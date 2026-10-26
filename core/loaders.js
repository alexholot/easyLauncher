'use strict';
// Загрузчики модов: Fabric, Quilt, Forge, NeoForge.
//   Fabric и Quilt — готовый профиль версии с их Meta-сервера (как в официальных инструкциях).
//   Forge и NeoForge — их собственный установщик в режиме без окна (--installClient / --installServer),
//   файлы ставятся прямо в общую папку лаунчера (она устроена как .minecraft). Установщик скачивается
//   с официального Maven и проверяется по опубликованному там SHA-1.
//   Очень старые установщики Forge (до 1.13) не умеют ставить клиент без окна: для них профиль
//   версии берётся из самого установщика (versionInfo), а для установщиков 2.0 без такой опции —
//   запускается свежий официальный установщик Forge (net.minecraftforge:installer:fatjar) с их профилем.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn } = require('child_process');
const AdmZip = require('adm-zip');
const http = require('./http');
const { mavenPath, javaEnv } = require('./mojang');

const META = { fabric: 'https://meta.fabricmc.net/v2', quilt: 'https://meta.quiltmc.org/v3' };
const FORGE_MAVEN = 'https://maven.minecraftforge.net';
const NEO_MAVEN = 'https://maven.neoforged.net/releases';
const LOADERS = ['vanilla', 'fabric', 'quilt', 'forge', 'neoforge'];
const LABELS = { vanilla: 'Vanilla', fabric: 'Fabric', quilt: 'Quilt', forge: 'Forge', neoforge: 'NeoForge' };

const memo = new Map();
async function cached(key, fn, ttl = 30 * 60 * 1000) {
  const hit = memo.get(key);
  if (hit && hit.until > Date.now()) return hit.value;
  const value = await fn();
  memo.set(key, { value, until: Date.now() + ttl });
  return value;
}
async function text(url, opts) {
  return (await http.request(url, opts)).text();
}
function mavenVersions(xml) {
  return [...String(xml).matchAll(/<version>([^<]+)<\/version>/g)].map((m) => m[1].trim());
}
/** Сравнение версий вида 47.3.10 / 0.16.9 / 21.1.77-beta. */
function cmp(a, b) {
  const pa = String(a).split(/[.+-]/);
  const pb = String(b).split(/[.+-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? '';
    const y = pb[i] ?? '';
    const nx = Number(x);
    const ny = Number(y);
    if (!Number.isNaN(nx) && !Number.isNaN(ny) && x !== '' && y !== '') {
      if (nx !== ny) return nx - ny;
    } else if (x !== y) return x === '' ? 1 : y === '' ? -1 : x < y ? -1 : 1; // «21.1.1» новее «21.1.1-beta»
  }
  return 0;
}

/**
 * Версия Minecraft для версии NeoForge.
 *   20.4.237 → 1.20.4; 21.0.x → 1.21; 21.1.77 → 1.21.1.
 *   С 2026 года Minecraft нумеруется по годам (26.1, 26.1.1), NeoForge повторяет её в начале: 26.1.0.12 → 26.1.
 */
function neoMinecraft(v) {
  const p = v.split('-')[0].split('.');
  const a = Number(p[0]);
  if (a >= 25) return p.length >= 4 && p[2] !== '0' ? `${p[0]}.${p[1]}.${p[2]}` : `${p[0]}.${p[1]}`;
  return p[1] === '0' ? `1.${p[0]}` : `1.${p[0]}.${p[1]}`;
}

/**
 * Версии загрузчика для версии Minecraft, новые сверху: [{version, stable, recommended}].
 */
async function loaderVersions(loader, mc, { signal } = {}) {
  if (loader === 'fabric' || loader === 'quilt') {
    const list = await cached(`${loader}:${mc}`, () => http.json(`${META[loader]}/versions/loader/${encodeURIComponent(mc)}`, { signal }));
    // Quilt Meta отдаёт версии не по порядку — сортируем сами, новые сверху
    return (Array.isArray(list) ? list : [])
      .map((x) => {
        const v = x.loader.version;
        const stable = loader === 'fabric' ? x.loader.stable !== false && !/beta|alpha|pre|rc/i.test(v) : !/beta|alpha|pre|rc/i.test(v);
        return { version: v, stable, recommended: false };
      })
      .sort((a, b) => cmp(b.version, a.version));
  }
  if (loader === 'forge') {
    const all = await cached('forge:meta', async () => mavenVersions(await text(`${FORGE_MAVEN}/net/minecraftforge/forge/maven-metadata.xml`, { signal })));
    const promos = await cached('forge:promos', () => http.json('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json', { signal }).catch(() => ({ promos: {} })));
    const rec = promos.promos?.[`${mc}-recommended`];
    return all
      .filter((v) => v.split('-')[0] === mc)
      .map((v) => v.slice(mc.length + 1))
      .sort((a, b) => cmp(b, a))
      .map((v) => ({ version: v, stable: true, recommended: v === rec || v.startsWith(rec + '-') }));
  }
  if (loader === 'neoforge') {
    const all = await cached('neo:meta', async () => mavenVersions(await text(`${NEO_MAVEN}/net/neoforged/neoforge/maven-metadata.xml`, { signal })));
    let list = all.filter((v) => neoMinecraft(v) === mc).sort((a, b) => cmp(b, a)).map((v) => ({ version: v, stable: !/beta|alpha/i.test(v), recommended: false }));
    if (mc === '1.20.1') {
      // для 1.20.1 NeoForge выпускался под старым именем net.neoforged:forge
      const legacy = await cached('neo:legacy', async () => mavenVersions(await text(`${NEO_MAVEN}/net/neoforged/forge/maven-metadata.xml`, { signal })).catch(() => []));
      list = legacy.filter((v) => v.startsWith('1.20.1-')).sort((a, b) => cmp(b, a)).map((v) => ({ version: v, stable: true, recommended: false, legacy: true }));
    }
    return list;
  }
  return [];
}

/** Рекомендуемая версия загрузчика: отмеченная авторами, иначе последняя стабильная, иначе последняя. */
function pickLoaderVersion(list) {
  return (list.find((x) => x.recommended) || list.find((x) => x.stable) || list[0])?.version || null;
}

/** Для каких версий Minecraft загрузчик вообще есть — чтобы не предлагать невозможное. */
async function supportedMinecraft(loader, { signal } = {}) {
  if (loader === 'fabric' || loader === 'quilt') {
    const list = await cached(`${loader}:games`, () => http.json(`${META[loader]}/versions/game`, { signal }));
    return new Set(list.map((x) => x.version));
  }
  if (loader === 'forge') {
    const all = await cached('forge:meta', async () => mavenVersions(await text(`${FORGE_MAVEN}/net/minecraftforge/forge/maven-metadata.xml`, { signal })));
    return new Set(all.map((v) => v.split('-')[0]));
  }
  if (loader === 'neoforge') {
    const all = await cached('neo:meta', async () => mavenVersions(await text(`${NEO_MAVEN}/net/neoforged/neoforge/maven-metadata.xml`, { signal })));
    return new Set([...all.map(neoMinecraft), '1.20.1']);
  }
  return null;
}

// ---------- Fabric и Quilt ----------
function metaId(loader, lv, mc) {
  return `${loader}-loader-${lv}-${mc}`;
}
async function installMetaProfile(mojang, loader, mc, lv, { signal } = {}) {
  const id = metaId(loader, lv, mc);
  if (!(await mojang.readLocalVersion(id))) {
    const profile = await http.json(`${META[loader]}/versions/loader/${encodeURIComponent(mc)}/${encodeURIComponent(lv)}/profile/json`, { signal });
    profile.id = id;
    await mojang.saveVersion(profile);
  }
  return id;
}

// ---------- Forge и NeoForge ----------
function installerUrl(loader, mc, lv) {
  if (loader === 'forge') return `${FORGE_MAVEN}/net/minecraftforge/forge/${mc}-${lv}/forge-${mc}-${lv}-installer.jar`;
  if (lv.startsWith('1.20.1-')) return `${NEO_MAVEN}/net/neoforged/forge/${lv}/forge-${lv}-installer.jar`;
  return `${NEO_MAVEN}/net/neoforged/neoforge/${lv}/neoforge-${lv}-installer.jar`;
}

/** Скачать установщик и проверить его SHA-1, опубликованный рядом на Maven. */
async function fetchInstaller(shared, url, { signal } = {}) {
  const dest = path.join(shared, 'installers', path.basename(new URL(url).pathname));
  const sha1 = (await text(url + '.sha1', { signal })).trim().split(/\s+/)[0].toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(sha1)) throw new Error('Maven не сообщил SHA-1 установщика — без проверки устанавливать не будем.');
  await http.download(url, dest, { sha1, signal });
  return dest;
}

function readProfile(installerJar) {
  const zip = new AdmZip(installerJar);
  const e = zip.getEntry('install_profile.json');
  if (!e) throw new Error('В установщике нет install_profile.json.');
  return { zip, profile: JSON.parse(e.getData().toString('utf8')) };
}

/** Запуск Java с выводом строк в onLog; ошибка — с последними строками вывода. */
function runJava(java, args, { cwd, signal, onLog } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(java, args, { cwd, env: javaEnv(), windowsHide: true });
    const lines = [];
    const feed = (chunk) => {
      for (const l of String(chunk).split(/\r?\n/)) {
        if (!l.trim()) continue;
        lines.push(l);
        if (lines.length > 400) lines.shift();
        onLog?.(l);
      }
    };
    proc.stdout.on('data', feed);
    proc.stderr.on('data', feed);
    const abort = () => proc.kill();
    signal?.addEventListener('abort', abort, { once: true });
    proc.on('error', (e) => reject(new Error('Не удалось запустить Java: ' + e.message)));
    proc.on('close', (code) => {
      signal?.removeEventListener('abort', abort);
      if (signal?.aborted) return reject(Object.assign(new Error('Подготовка отменена'), { code: 'CANCELLED' }));
      resolve({ code, lines });
    });
  });
}

/** Свежий официальный установщик Forge (fatjar) — для установщиков без режима «без окна». */
async function forgeInstallerTool(shared, { signal } = {}) {
  const meta = await text(`${FORGE_MAVEN}/net/minecraftforge/installer/maven-metadata.xml`, { signal });
  const release = (meta.match(/<release>([^<]+)<\/release>/) || [])[1] || mavenVersions(meta).sort(cmp).pop();
  if (!release) throw new Error('Не удалось узнать версию установщика Forge.');
  return fetchInstaller(shared, `${FORGE_MAVEN}/net/minecraftforge/installer/${release}/installer-${release}-fatjar.jar`, { signal });
}

const SEP = process.platform === 'win32' ? ';' : ':';
const fixUrl = (u) => String(u || '').replace(/^https?:\/\/files\.minecraftforge\.net\/maven\/?/, FORGE_MAVEN + '/');

/** Клиент Forge/NeoForge. Возвращает id версии (versions/<id>/<id>.json в общей папке). */
async function installForgeClient(mojang, loader, mc, lv, { java, signal, onLog } = {}) {
  const shared = mojang.root;
  const marker = (id) => path.join(mojang.versionsDir, id, '.easylauncher-installed');
  const known = path.join(shared, 'installers', `${loader}-${mc}-${lv}.id`);
  try {
    const id = (await fsp.readFile(known, 'utf8')).trim();
    if (fs.existsSync(marker(id)) && (await mojang.readLocalVersion(id))) return id;
  } catch {}
  const jar = await fetchInstaller(shared, installerUrl(loader, mc, lv), { signal });
  const { zip, profile } = readProfile(jar);
  let id;
  if (profile.versionInfo) {
    // установщик 1.x (Forge до 1.13): профиль версии и универсальный JAR лежат внутри
    const v = profile.versionInfo;
    id = v.id;
    v.inheritsFrom = v.inheritsFrom || mc;
    v.jar = v.jar || mc;
    v.libraries = (v.libraries || [])
      .filter((l) => l.clientreq !== false)
      .map((l) => (l.url ? { ...l, url: fixUrl(l.url) } : l));
    const uni = profile.install?.filePath && zip.getEntry(profile.install.filePath);
    if (uni && profile.install.path) {
      const dest = path.join(mojang.librariesDir, mavenPath(profile.install.path));
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.writeFile(dest, uni.getData());
      // библиотеку самого Forge не нужно скачивать — она уже извлечена
      v.libraries = v.libraries.map((l) => (l.name === profile.install.path ? { name: l.name } : l));
    }
    await mojang.saveVersion(v);
  } else {
    // установщик 2.x: обработчики (processors) запускает сам установщик
    id = profile.version;
    const lp = path.join(shared, 'launcher_profiles.json');
    if (!fs.existsSync(lp)) await fsp.writeFile(lp, JSON.stringify({ profiles: {} }));
    const flag = loader === 'neoforge' ? '--install-client' : '--installClient';
    let r = await runJava(java, ['-jar', jar, flag, shared], { cwd: shared, signal, onLog });
    if (!fs.existsSync(mojang.versionFile(id)) && loader === 'forge') {
      onLog?.('Этот установщик Forge не умеет ставить без окна — используем официальный свежий установщик Forge.');
      const tool = await forgeInstallerTool(shared, { signal });
      r = await runJava(java, ['-cp', tool + SEP + jar, 'net.minecraftforge.installer.SimpleInstaller', '--installClient', shared], { cwd: shared, signal, onLog });
    }
    if (!fs.existsSync(mojang.versionFile(id))) {
      throw Object.assign(new Error(`Установщик ${LABELS[loader]} завершился без результата (код ${r.code}): ${r.lines.slice(-3).join(' / ')}`), { code: 'LOADER_INSTALL' });
    }
  }
  await fsp.writeFile(marker(id), new Date().toISOString());
  await fsp.writeFile(known, id);
  return id;
}

/**
 * Сервер Forge/NeoForge. Возвращает способ запуска: {jar} или {args} (современные версии
 * запускаются через файл аргументов @libraries/.../win_args.txt или unix_args.txt).
 */
async function installForgeServer(mojang, loader, mc, lv, dir, { java, signal, onLog, baseVersion } = {}) {
  const stamp = path.join(dir, '.easylauncher-loader');
  const want = `${loader}|${mc}|${lv}`;
  let ready = false;
  try {
    ready = (await fsp.readFile(stamp, 'utf8')) === want;
  } catch {}
  if (!ready) {
    const jar = await fetchInstaller(mojang.root, installerUrl(loader, mc, lv), { signal });
    // старые установщики качают серверный JAR Minecraft по давно закрытому адресу — кладём его заранее
    if (baseVersion?.downloads?.server) await mojang.installServerJar(baseVersion, path.join(dir, `minecraft_server.${mc}.jar`), { signal });
    const flag = loader === 'neoforge' ? '--install-server' : '--installServer';
    let r = await runJava(java, ['-jar', jar, flag, dir], { cwd: dir, signal, onLog });
    if (!findServerLaunch(dir, loader, mc, lv) && loader === 'forge') {
      const tool = await forgeInstallerTool(mojang.root, { signal });
      r = await runJava(java, ['-cp', tool + SEP + jar, 'net.minecraftforge.installer.SimpleInstaller', '--installServer', dir], { cwd: dir, signal, onLog });
    }
    if (!findServerLaunch(dir, loader, mc, lv)) throw Object.assign(new Error(`Сервер ${LABELS[loader]} не установился (код ${r.code}): ${r.lines.slice(-3).join(' / ')}`), { code: 'LOADER_INSTALL' });
    await fsp.writeFile(stamp, want);
  }
  return findServerLaunch(dir, loader, mc, lv);
}

function findServerLaunch(dir, loader, mc, lv) {
  const argsName = process.platform === 'win32' ? 'win_args.txt' : 'unix_args.txt';
  const candidates =
    loader === 'forge'
      ? [path.join('libraries', 'net', 'minecraftforge', 'forge', `${mc}-${lv}`, argsName)]
      : [path.join('libraries', 'net', 'neoforged', 'neoforge', lv, argsName), path.join('libraries', 'net', 'neoforged', 'forge', lv, argsName)];
  for (const rel of candidates) if (fs.existsSync(path.join(dir, rel))) return { args: ['@' + rel] };
  let files = [];
  try {
    files = fs.readdirSync(dir);
  } catch {}
  const jar = files.find((f) => /^(forge|neoforge).*\.jar$/i.test(f) && !/installer/i.test(f));
  return jar ? { jar: path.join(dir, jar) } : null;
}

// ---------- Quilt: сервер ----------
async function installQuiltServer(mojang, mc, lv, dir, { signal, baseVersion } = {}) {
  const profile = await http.json(`${META.quilt}/versions/loader/${encodeURIComponent(mc)}/${encodeURIComponent(lv)}/server/json`, { signal });
  const libs = [];
  for (const l of profile.libraries || []) {
    const rel = mavenPath(l.name);
    const dest = path.join(dir, 'libraries', rel);
    await http.download((l.url || 'https://maven.quiltmc.org/repository/release/').replace(/\/?$/, '/') + rel, dest, { signal, sha1: l.sha1 });
    libs.push(dest);
  }
  const serverJar = path.join(dir, 'server.jar');
  await mojang.installServerJar(baseVersion, serverJar, { signal });
  return { args: [`-Dloader.gameJarPath=${serverJar}`, '-cp', [...libs, serverJar].join(SEP), profile.mainClass] };
}

module.exports = { LOADERS, LABELS, loaderVersions, pickLoaderVersion, supportedMinecraft, installMetaProfile, metaId, installForgeClient, installForgeServer, installQuiltServer, installerUrl, neoMinecraft, mavenVersions, cmp, findServerLaunch, readProfile };
