'use strict';
// Чтение готовых сборок: .mrpack (Modrinth) и архив CurseForge (manifest.json + overrides).
// Архив — недоверенные данные: пути проверяются (никаких «..» и абсолютных), размер ограничен,
// скачивание — только с разрешённых площадок и со сверкой хеша.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const AdmZip = require('adm-zip');

const MAX_ARCHIVE = 1024 * 1024 * 1024; // сам файл сборки
const MAX_UNPACKED = 2 * 1024 * 1024 * 1024; // всё, что распаковывается из overrides
const MAX_ENTRIES = 30000;
// площадки, с которых .mrpack разрешено качать по спецификации Modrinth
const PACK_HOSTS = /^https:\/\/(cdn\.modrinth\.com|github\.com|raw\.githubusercontent\.com|gitlab\.com)\//;
const MRPACK_LOADERS = { 'fabric-loader': 'fabric', 'quilt-loader': 'quilt', forge: 'forge', neoforge: 'neoforge' };

const fail = (message) => Object.assign(new Error(message), { code: 'BAD_PACK' });

/** Безопасный относительный путь внутри папки игры или null. */
function safeRel(p) {
  const s = String(p || '').replace(/\\/g, '/');
  if (!s || s.startsWith('/') || /^[a-z]:/i.test(s) || s.includes('\0')) return null;
  const parts = s.split('/').filter((x) => x && x !== '.');
  if (!parts.length || parts.some((x) => x === '..' || /[<>:"|?*]/.test(x))) return null;
  return parts.join('/');
}

/** «forge-47.2.0» → {loader: 'forge', version: '47.2.0'} (CurseForge). */
function cfLoader(id) {
  const m = /^(forge|fabric|quilt|neoforge)-(.+)$/i.exec(String(id || ''));
  return m ? { loader: m[1].toLowerCase(), version: m[2] } : null;
}

/** Названия и адреса модов из modlist.html экспорта CurseForge: [{slug, name, url}]. */
function parseModlist(html) {
  const out = [];
  for (const m of String(html || '').matchAll(/<a[^>]+href="(https:\/\/(?:www\.)?curseforge\.com\/minecraft\/mc-mods\/([\w-]+))\/?"[^>]*>([^<]+)<\/a>/gi)) {
    const name = m[3].replace(/\s*\(by [^)]*\)\s*$/i, '').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim();
    // адрес — всегда www.curseforge.com: только его лаунчер разрешает открыть в браузере
    out.push({ url: `https://www.curseforge.com/minecraft/mc-mods/${m[2].toLowerCase()}`, slug: m[2].toLowerCase(), name });
  }
  return out;
}

/**
 * Прочитать файл сборки. Возвращает описание без побочных эффектов:
 * { kind: 'mrpack'|'curseforge', name, minecraft, loader, loaderVersion,
 *   mods: [{ sha1, sha512, size, path, urls, client, server }]           — .mrpack
 *   cfFiles: [{ projectId, fileId, required, name, slug, url }]         — CurseForge
 *   files: [{ path, sha1, sha512, size, urls }]                         — не моды (.mrpack: ресурспаки, шейдеры)
 *   overrides: [имена записей архива], overridesBase }
 */
async function readPack(file) {
  const st = await fsp.stat(file);
  if (st.size > MAX_ARCHIVE) throw fail('Файл сборки больше 1 ГБ — так не бывает, это не сборка.');
  let zip;
  try {
    zip = new AdmZip(file);
  } catch {
    throw fail('Файл повреждён или это не архив сборки.');
  }
  const entries = zip.getEntries();
  if (entries.length > MAX_ENTRIES) throw fail('В архиве слишком много файлов — так не бывает, это не сборка.');
  const read = (n) => {
    const e = zip.getEntry(n);
    return e ? e.getData().toString('utf8').replace(/^﻿/, '') : null;
  };
  const json = (n) => {
    const t = read(n);
    if (t == null) return null;
    try {
      return JSON.parse(t);
    } catch {
      throw fail(`В архиве испорчен ${n}.`);
    }
  };
  const idx = json('modrinth.index.json');
  if (idx) {
    if (idx.game !== 'minecraft') throw fail('Эта сборка не для Minecraft.');
    const deps = idx.dependencies || {};
    const lk = Object.keys(MRPACK_LOADERS).find((k) => deps[k]);
    const mods = [];
    const files = [];
    for (const f of idx.files || []) {
      const rel = safeRel(f.path);
      if (!rel) continue;
      // только то, что нужно игроку: серверные файлы клиенту не ставим
      if (f.env?.client === 'unsupported') continue;
      const item = { path: rel, sha1: String(f.hashes?.sha1 || '').toLowerCase(), sha512: String(f.hashes?.sha512 || '').toLowerCase() || null, size: Number(f.fileSize) || 0, urls: (f.downloads || []).filter((u) => PACK_HOSTS.test(u)), optional: f.env?.client === 'optional' };
      if (!/^[0-9a-f]{40}$/.test(item.sha1)) continue;
      if (/^mods\/[^/]+\.jar$/i.test(rel)) mods.push(item);
      else files.push(item);
    }
    return {
      kind: 'mrpack',
      name: String(idx.name || path.basename(file, path.extname(file))).slice(0, 60),
      minecraft: String(deps.minecraft || ''),
      loader: lk ? MRPACK_LOADERS[lk] : 'vanilla',
      loaderVersion: lk ? String(deps[lk]) : null,
      mods,
      files,
      overrides: overridesOf(entries, ['overrides/', 'client-overrides/']),
      zip,
    };
  }
  const man = json('manifest.json');
  if (man && man.manifestType === 'minecraftModpack') {
    const ld = (man.minecraft?.modLoaders || []).map((x) => cfLoader(x.id)).filter(Boolean);
    const primary = (man.minecraft?.modLoaders || []).find((x) => x.primary);
    const l = (primary && cfLoader(primary.id)) || ld[0] || null;
    const list = parseModlist(read('modlist.html'));
    const base = (safeRel(man.overrides || 'overrides') || 'overrides') + '/';
    const cfFiles = (man.files || [])
      .filter((x) => Number.isInteger(x.projectID) && Number.isInteger(x.fileID))
      .map((x) => ({ projectId: String(x.projectID), fileId: String(x.fileID), required: x.required !== false }));
    return {
      kind: 'curseforge',
      name: String(man.name || path.basename(file, path.extname(file))).slice(0, 60),
      minecraft: String(man.minecraft?.version || ''),
      loader: l ? l.loader : 'vanilla',
      loaderVersion: l ? l.version : null,
      cfFiles,
      // названия и адреса модов (modlist.html): без CurseForge по ним ищем те же моды на Modrinth
      modlist: list,
      files: [],
      overrides: overridesOf(entries, [base]),
      zip,
    };
  }
  throw fail('Это не сборка Modrinth (.mrpack) и не архив CurseForge: в нём нет modrinth.index.json или manifest.json.');
}

/** Записи overrides: [{name, rel, size}], client-overrides идут после overrides и заменяют их. */
function overridesOf(entries, prefixes) {
  const out = new Map();
  for (const pre of prefixes) {
    for (const e of entries) {
      if (e.isDirectory || !e.entryName.startsWith(pre)) continue;
      const rel = safeRel(e.entryName.slice(pre.length));
      if (rel) out.set(rel.toLowerCase(), { name: e.entryName, rel, size: e.header.size || 0 });
    }
  }
  return [...out.values()];
}

/** Распаковать overrides в папку игры. Возвращает число файлов. */
async function extractOverrides(pack, gameDir) {
  const total = pack.overrides.reduce((a, o) => a + o.size, 0);
  if (total > MAX_UNPACKED) throw fail('Настройки сборки занимают больше 2 ГБ — распаковка остановлена.');
  const root = path.resolve(gameDir);
  let n = 0;
  for (const o of pack.overrides) {
    const target = path.resolve(root, o.rel);
    if (!target.startsWith(root + path.sep)) continue;
    const data = pack.zip.getEntry(o.name)?.getData();
    if (!data) continue;
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, data);
    n++;
  }
  return n;
}

module.exports = { readPack, extractOverrides, parseModlist, cfLoader, safeRel, PACK_HOSTS };
