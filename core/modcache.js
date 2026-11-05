'use strict';
// Общий кэш файлов модов по SHA-1 и раскладка в папки mods профилей.
// Файлы в кэше не изменяются, поэтому одна сборка не может испортить другую.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const AdmZip = require('adm-zip');
const http = require('./http');
const { retryFs } = http;

const MANAGED = '.easylauncher-managed.json';
// Разрешённые источники автоматического скачивания
const ALLOWED_HOSTS = [/^https:\/\/cdn\.modrinth\.com\//, /^https:\/\/(edge|mediafilez)\.forgecdn\.net\//];

function safeName(name) {
  const base = path.basename(String(name || ''));
  if (!/\.jar$/i.test(base) || base.startsWith('.') || /[<>:"|?*\x00-\x1f]/.test(base))
    throw new Error('Недопустимое имя файла мода: ' + name);
  return base;
}

/** Проверка, что это действительно мод нужного загрузчика: JAR читается и содержит описание мода. */
function inspectJar(file) {
  let zip;
  try {
    zip = new AdmZip(file);
  } catch {
    return { ok: false, reason: 'файл не является JAR-архивом' };
  }
  const read = (n) => {
    const e = zip.getEntry(n);
    return e ? e.getData().toString('utf8') : null;
  };
  const out = { ok: true, loaders: [], environment: null, modId: null, name: null, version: null };
  const fabric = read('fabric.mod.json');
  if (fabric) {
    out.loaders.push('fabric');
    try {
      const j = JSON.parse(fabric.replace(/^﻿/, ''));
      out.modId = j.id || null;
      out.environment = j.environment || '*';
      out.name = typeof j.name === 'string' ? j.name : null;
      out.version = typeof j.version === 'string' ? j.version : null;
    } catch {}
  }
  const quilt = read('quilt.mod.json');
  if (quilt) out.loaders.push('quilt');
  // Forge до 1.13: описание в mcmod.info (JSON-массив или {modList: [...]})
  const mcmod = read('mcmod.info');
  if (mcmod && !out.loaders.length) {
    out.loaders.push('forge');
    try {
      const j = JSON.parse(mcmod.replace(/^﻿/, ''));
      const m = (Array.isArray(j) ? j : j.modList || [])[0] || {};
      out.modId = m.modid || null;
      out.name = typeof m.name === 'string' ? m.name : null;
      out.version = typeof m.version === 'string' && !/\$\{/.test(m.version) ? m.version : null;
    } catch {}
  }
  // название и версия из описания мода Forge/NeoForge: первый [[mods]], «${file.jarVersion}» — из манифеста
  for (const [file, loader] of [['META-INF/mods.toml', 'forge'], ['META-INF/neoforge.mods.toml', 'neoforge']]) {
    const toml = read(file);
    if (!toml) continue;
    out.loaders.push(loader);
    const mods = toml.split(/^\s*\[\[mods\]\]\s*$/m)[1] || '';
    const field = (k) => (mods.match(new RegExp(`^\\s*${k}\\s*=\\s*["']([^"'\\n]*)["']`, 'm')) || [])[1] || null;
    out.modId = out.modId || field('modId');
    out.name = out.name || field('displayName');
    let v = field('version');
    if (v && /\$\{/.test(v)) v = ((read('META-INF/MANIFEST.MF') || '').match(/^Implementation-Version:\s*(\S+)/m) || [])[1] || null;
    out.version = out.version || v;
  }
  return out;
}

class ModCache {
  /** allowHosts — список разрешённых источников (по умолчанию CDN Modrinth и CurseForge). */
  constructor(sharedDir, { allowHosts = ALLOWED_HOSTS } = {}) {
    this.dir = path.join(sharedDir, 'mod-cache');
    this.allowHosts = allowHosts;
  }

  pathFor(file) {
    const sha1 = String(file?.hashes?.sha1 || '').toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(sha1)) throw new Error('У файла нет SHA-1 — без хеша файл не устанавливается.');
    return path.join(this.dir, sha1.slice(0, 2), sha1 + '.jar');
  }

  has(file) {
    try {
      return fs.existsSync(this.pathFor(file));
    } catch {
      return false;
    }
  }

  /** Скачать файл в кэш (или убедиться, что он там есть). */
  async ensure(entry, { signal, onBytes } = {}) {
    const f = entry.file;
    const dest = this.pathFor(f);
    if (await http.isValid(dest, { sha1: f.hashes.sha1, size: f.size })) return dest;
    if (!f.url) {
      const e = new Error(
        `${entry.name}: автор запретил автоматическое скачивание. Открой официальную страницу, скачай файл и импортируй его.`,
      );
      e.code = 'DOWNLOAD_BLOCKED';
      e.entry = entry;
      throw e;
    }
    if (!this.allowHosts.some((re) => re.test(f.url))) {
      const e = new Error(`${entry.name}: источник ${new URL(f.url).host} не входит в список разрешённых.`);
      e.code = 'SOURCE_NOT_ALLOWED';
      throw e;
    }
    await http.download(f.url, dest, { sha1: f.hashes.sha1, sha512: f.hashes.sha512, size: f.size, signal, onBytes });
    return dest;
  }

  /**
   * Импорт вручную скачанного файла. Принимается только если хеш совпадает с ожидаемым
   * из метаданных площадки — так нельзя подменить мод другим файлом.
   */
  async importFile(srcPath, entry) {
    const sha1 = await http.hashFile(srcPath, 'sha1');
    if (sha1 !== String(entry.file.hashes.sha1).toLowerCase())
      throw new Error(`Это не тот файл: SHA-1 не совпадает с файлом «${entry.file.filename}» на площадке.`);
    const dest = this.pathFor(entry.file);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.copyFile(srcPath, dest + '.part');
    await retryFs(() => fsp.rename(dest + '.part', dest));
    return dest;
  }

  /**
   * Привести папку mods к списку entries. Файлы, которые лаунчер не ставил, не трогаем.
   * Возвращает список имён файлов.
   */
  async materialize(modsDir, entries) {
    await fsp.mkdir(modsDir, { recursive: true });
    let managed = [];
    try {
      managed = JSON.parse(await fsp.readFile(path.join(modsDir, MANAGED), 'utf8')).files || [];
    } catch {}
    const wanted = new Map();
    for (const e of entries) {
      const original = safeName(e.file.filename);
      let name = original;
      if (wanted.has(name)) {
        const ext = path.extname(original);
        const base = path.basename(original, ext);
        const suffix = String(e.file.hashes?.sha1 || e.versionId || e.key || '').replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'copy';
        name = safeName(`${base}-${suffix}${ext}`);
        for (let i = 2; wanted.has(name); i++) name = safeName(`${base}-${suffix}-${i}${ext}`);
      }
      wanted.set(name, e);
    }
    for (const old of managed) {
      if (!wanted.has(old)) await retryFs(() => fsp.rm(path.join(modsDir, safeName(old)), { force: true }), old);
    }
    for (const [name, e] of wanted) {
      const target = path.join(modsDir, name);
      const src = this.pathFor(e.file);
      if (!fs.existsSync(src)) throw Object.assign(new Error(`${e.name}: файла нет в кэше.`), { code: 'NOT_CACHED', entry: e });
      if (await http.isValid(target, { sha1: e.file.hashes.sha1, size: e.file.size })) continue;
      await retryFs(() => fsp.rm(target, { force: true }), name);
      try {
        await fsp.link(src, target);
      } catch {
        await fsp.copyFile(src, target);
      }
    }
    await fsp.writeFile(path.join(modsDir, MANAGED), JSON.stringify({ files: [...wanted.keys()] }, null, 2));
    return [...wanted.keys()];
  }

  /** Размер кэша и удаление файлов, на которые не ссылается ни один lock. */
  async gc(usedSha1s) {
    let freed = 0;
    let dirs = [];
    try {
      dirs = await fsp.readdir(this.dir);
    } catch {
      return 0;
    }
    for (const d of dirs) {
      for (const f of await fsp.readdir(path.join(this.dir, d)).catch(() => [])) {
        const sha1 = f.replace(/\.jar(\.part)?$/, '');
        if (!usedSha1s.has(sha1)) {
          const p = path.join(this.dir, d, f);
          freed += (await fsp.stat(p)).size;
          await fsp.rm(p, { force: true });
        }
      }
    }
    return freed;
  }
}

module.exports = { ModCache, inspectJar, safeName, ALLOWED_HOSTS };
