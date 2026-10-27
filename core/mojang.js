'use strict';
// Официальные метаданные Mojang: версии, библиотеки, ассеты, Java и аргументы запуска.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const http = require('./http');

const UTF8_JVM = ['-Dfile.encoding=UTF-8', '-Dstdout.encoding=UTF-8', '-Dstderr.encoding=UTF-8'];
/** Окружение для Java: в Linux/macOS пути с кириллицей требуют UTF-8 локали. */
function javaEnv(base = process.env) {
  if (process.platform === 'win32' || /utf-?8/i.test(base.LC_ALL || base.LANG || '')) return base;
  return { ...base, LC_ALL: 'C.UTF-8', LANG: 'C.UTF-8' };
}

const MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const JAVA_ALL_URL =
  'https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json';
const LIBRARIES_URL = 'https://libraries.minecraft.net/';
const RESOURCES_URL = 'https://resources.download.minecraft.net/';

function osName(platform = process.platform) {
  return platform === 'win32' ? 'windows' : platform === 'darwin' ? 'osx' : 'linux';
}

/** Ключ платформы в манифесте Java от Mojang. */
function javaPlatform(platform = process.platform, arch = process.arch) {
  if (platform === 'win32') return arch === 'arm64' ? 'windows-arm64' : arch === 'ia32' ? 'windows-x86' : 'windows-x64';
  if (platform === 'darwin') return arch === 'arm64' ? 'mac-os-arm64' : 'mac-os';
  if (platform === 'linux') return arch === 'ia32' ? 'linux-i386' : arch === 'x64' ? 'linux' : null;
  return null;
}

/** Правила library/argument: без правил — разрешено; иначе применяется последнее совпавшее. */
function rulesAllow(rules, features = {}, env = {}) {
  if (!Array.isArray(rules) || !rules.length) return true;
  const name = env.os || osName();
  const arch = env.arch || process.arch;
  const release = env.release || os.release();
  let allowed = false;
  for (const rule of rules) {
    let match = true;
    if (rule.os) {
      if (rule.os.name && rule.os.name !== name) match = false;
      if (rule.os.arch && !((rule.os.arch === 'x86' && arch === 'ia32') || rule.os.arch === arch)) match = false;
      if (rule.os.version) {
        try {
          if (!new RegExp(rule.os.version).test(release)) match = false;
        } catch {
          match = false;
        }
      }
    }
    if (rule.features) {
      for (const [k, v] of Object.entries(rule.features)) if (!!features[k] !== v) match = false;
    }
    if (match) allowed = rule.action === 'allow';
  }
  return allowed;
}

/** group:artifact:version[:classifier][@ext] → относительный путь в maven-репозитории. */
function mavenPath(name) {
  let [coords, ext = 'jar'] = name.split('@');
  const [group, artifact, version, classifier] = coords.split(':');
  const file = `${artifact}-${version}${classifier ? '-' + classifier : ''}.${ext}`;
  return [...group.split('.'), artifact, version, file].join('/');
}

function libKey(name) {
  const [group, artifact, , classifier] = name.split('@')[0].split(':');
  return `${group}:${artifact}:${classifier || ''}`;
}

/** Склеить профиль загрузчика (Fabric) с базовой версией Minecraft. */
function mergeVersion(child, parent) {
  const merged = { ...parent, ...child };
  merged.libraries = [...(child.libraries || []), ...(parent.libraries || [])];
  merged.mainClass = child.mainClass || parent.mainClass;
  merged.jar = parent.jar || parent.id;
  merged.inheritsFrom = undefined;
  if (parent.arguments || child.arguments) {
    merged.arguments = {
      game: [...(parent.arguments?.game || []), ...(child.arguments?.game || [])],
      jvm: [...(parent.arguments?.jvm || []), ...(child.arguments?.jvm || [])],
    };
  }
  for (const k of ['assetIndex', 'assets', 'downloads', 'javaVersion', 'logging', 'type'])
    if (!child[k]) merged[k] = parent[k];
  return merged;
}

class Mojang {
  constructor(shared) {
    this.root = shared;
    this.versionsDir = path.join(shared, 'versions');
    this.librariesDir = path.join(shared, 'libraries');
    this.assetsDir = path.join(shared, 'assets');
    this.runtimeDir = path.join(shared, 'runtime');
    this.manifest = null;
  }

  async getManifest({ signal, refresh = true } = {}) {
    if (this.manifest && !refresh) return this.manifest;
    this.manifest = await http.cachedJson(MANIFEST_URL, path.join(this.versionsDir, 'version_manifest_v2.json'), {
      signal,
      refresh,
    });
    return this.manifest;
  }

  /** Список релизов, начиная с minimum (включительно). */
  async releases({ minimum = '1.16', signal } = {}) {
    const m = await this.getManifest({ signal });
    const out = [];
    for (const v of m.versions) {
      if (v.type !== 'release') continue;
      out.push(v.id);
      if (v.id === minimum) break;
    }
    return out;
  }

  /** Все версии из манифеста Mojang: релизы, снапшоты, старые бета и альфа. Новые сверху. */
  async allVersions({ signal } = {}) {
    const m = await this.getManifest({ signal });
    return m.versions.map((v) => ({ id: v.id, type: v.type, releaseTime: v.releaseTime }));
  }

  versionFile(id) {
    return path.join(this.versionsDir, id, id + '.json');
  }

  async readLocalVersion(id) {
    try {
      return JSON.parse(await fsp.readFile(this.versionFile(id), 'utf8'));
    } catch {
      return null;
    }
  }

  async saveVersion(json) {
    await fsp.mkdir(path.dirname(this.versionFile(json.id)), { recursive: true });
    await fsp.writeFile(this.versionFile(json.id), JSON.stringify(json, null, 2));
  }

  /** JSON версии Minecraft (с проверкой sha1 из манифеста). Склеивает inheritsFrom. */
  async getVersion(id, { signal } = {}) {
    let json = await this.readLocalVersion(id);
    if (!json || (!json.inheritsFrom && !json.downloads)) {
      let manifest;
      try {
        manifest = await this.getManifest({ signal, refresh: false });
      } catch (e) {
        throw new Error('Нет связи с серверами Mojang и нет сохранённой версии ' + id + '. ' + e.message);
      }
      let entry = manifest.versions.find((v) => v.id === id);
      if (!entry) {
        manifest = await this.getManifest({ signal, refresh: true });
        entry = manifest.versions.find((v) => v.id === id);
      }
      if (!entry) throw new Error('Версия Minecraft ' + id + ' не найдена.');
      json = await http.cachedJson(entry.url, this.versionFile(id), { sha1: entry.sha1, signal });
    }
    if (json.inheritsFrom) {
      const parent = await this.getVersion(json.inheritsFrom, { signal });
      return mergeVersion(json, parent);
    }
    return json;
  }

  /** Список нужных библиотек: задачи на загрузку, classpath и нативные архивы. */
  libraryPlan(version, env) {
    const tasks = [];
    const classpath = [];
    const natives = [];
    const seen = new Set();
    for (const lib of version.libraries || []) {
      if (!rulesAllow(lib.rules, {}, env)) continue;
      const nativeKey = lib.natives?.[env?.os || osName()];
      if (nativeKey) {
        const key = nativeKey.replace('${arch}', process.arch === 'ia32' ? '32' : '64');
        const art = lib.downloads?.classifiers?.[key];
        if (art) {
          const dest = path.join(this.librariesDir, art.path);
          tasks.push({ url: art.url, dest, sha1: art.sha1, size: art.size });
          natives.push({ file: dest, exclude: lib.extract?.exclude || ['META-INF/'] });
        }
      }
      const art = lib.downloads?.artifact;
      if (lib.downloads && !art) continue; // только нативные классификаторы
      const k = libKey(lib.name);
      if (seen.has(k)) continue;
      seen.add(k);
      let rel, url, sha1, size;
      if (art) {
        rel = art.path || mavenPath(lib.name);
        url = art.url;
        sha1 = art.sha1;
        size = art.size;
      } else {
        rel = mavenPath(lib.name);
        url = (lib.url || LIBRARIES_URL).replace(/\/?$/, '/') + rel;
        sha1 = lib.sha1;
        size = lib.size;
      }
      const dest = path.join(this.librariesDir, rel);
      if (url) tasks.push({ url, dest, sha1, size });
      classpath.push(dest);
    }
    return { tasks, classpath, natives };
  }

  clientJar(version) {
    const id = version.jar || version.id;
    return path.join(this.versionsDir, id, id + '.jar');
  }

  /** Библиотеки + client.jar + конфиг логов. Возвращает данные для запуска. */
  async installClient(version, { signal, onProgress } = {}) {
    const plan = this.libraryPlan(version);
    const client = version.downloads?.client;
    const jar = this.clientJar(version);
    if (client) plan.tasks.push({ url: client.url, dest: jar, sha1: client.sha1, size: client.size });
    let logging = null;
    const lc = version.logging?.client;
    if (lc?.file) {
      const dest = path.join(this.assetsDir, 'log_configs', lc.file.id);
      plan.tasks.push({ url: lc.file.url, dest, sha1: lc.file.sha1, size: lc.file.size });
      logging = lc.argument.replace('${path}', dest);
    }
    await http.downloadAll(plan.tasks, { signal, onProgress, concurrency: 8 });
    const nativesDir = path.join(this.versionsDir, version.id, 'natives');
    if (plan.natives.length) await this.extractNatives(plan.natives, nativesDir);
    else await fsp.mkdir(nativesDir, { recursive: true });
    return { classpath: [...plan.classpath, await this.classpathJar(version)], nativesDir, logging };
  }

  /**
   * client.jar для classpath. Forge и NeoForge (1.17+) исключают игру из модулей по имени
   * `${version_name}.jar` (-DignoreList): как и лаунчер Mojang, кладём копию игры под именем версии
   * загрузчика. Иначе в игре два модуля Minecraft и запуск падает: «Modules _1._20._1 and minecraft
   * export package net.minecraft.server». Fabric и Quilt берут игру как есть.
   */
  async classpathJar(version) {
    const jar = this.clientJar(version);
    if (!version.jar || version.jar === version.id || !JSON.stringify(version.arguments?.jvm || []).includes('${version_name}.jar')) return jar;
    const own = path.join(this.versionsDir, version.id, version.id + '.jar');
    const size = (f) => fsp.stat(f).then((s) => s.size, () => -1);
    if ((await size(own)) !== (await size(jar))) {
      await fsp.mkdir(path.dirname(own), { recursive: true });
      await fsp.copyFile(jar, own + '.part');
      await http.retryFs(() => fsp.rename(own + '.part', own), path.basename(own));
    }
    return own;
  }

  async extractNatives(list, dir) {
    const AdmZip = require('adm-zip');
    await fsp.mkdir(dir, { recursive: true });
    for (const { file, exclude } of list) {
      const zip = new AdmZip(file);
      for (const e of zip.getEntries()) {
        if (e.isDirectory || exclude.some((x) => e.entryName.startsWith(x))) continue;
        const out = path.join(dir, e.entryName);
        if (!out.startsWith(dir + path.sep)) continue;
        await fsp.mkdir(path.dirname(out), { recursive: true });
        await http.retryFs(() => fsp.writeFile(out, e.getData()), path.basename(out));
      }
    }
  }

  async installAssets(version, { signal, onProgress } = {}) {
    const ai = version.assetIndex;
    if (!ai) return { index: version.assets || 'legacy' };
    const indexFile = path.join(this.assetsDir, 'indexes', ai.id + '.json');
    const index = await http.cachedJson(ai.url, indexFile, { sha1: ai.sha1, signal });
    const tasks = [];
    const seen = new Set();
    for (const { hash, size } of Object.values(index.objects || {})) {
      if (seen.has(hash)) continue;
      seen.add(hash);
      const sub = hash.slice(0, 2) + '/' + hash;
      tasks.push({ url: RESOURCES_URL + sub, dest: path.join(this.assetsDir, 'objects', sub), sha1: hash, size });
    }
    // У ассетов размер в индексе точный — сверяем размер, хеш проверяется при загрузке
    await http.downloadAll(tasks, { signal, onProgress, concurrency: 16, quick: true });
    // Старые версии (до 1.7) читают ресурсы не из objects/, а по обычным путям:
    // «legacy» — из assets/virtual/legacy, «pre-1.6» — из папки resources в папке игры
    const named = Object.entries(index.objects || {}).map(([name, o]) => ({ name, file: path.join(this.assetsDir, 'objects', o.hash.slice(0, 2), o.hash) }));
    if (index.virtual) {
      const dir = path.join(this.assetsDir, 'virtual', ai.id);
      await placeNamed(named, dir);
      return { index: ai.id, gameAssets: dir };
    }
    if (index.map_to_resources) return { index: ai.id, mapToResources: named };
    return { index: ai.id };
  }

  /** Java нужной версии из официального набора Mojang. Возвращает путь к исполняемому файлу. */
  async installJava(version, { signal, onProgress } = {}) {
    const component = version.javaVersion?.component || 'jre-legacy';
    const platform = javaPlatform();
    const home = path.join(this.runtimeDir, component);
    const exe = (gui) => {
      const bin =
        process.platform === 'darwin'
          ? path.join(home, 'jre.bundle', 'Contents', 'Home', 'bin')
          : path.join(home, 'bin');
      return path.join(bin, process.platform === 'win32' ? (gui ? 'javaw.exe' : 'java.exe') : 'java');
    };
    if (!platform) return { java: 'java', javaw: 'java', system: true };
    const marker = path.join(home, '.easylauncher-complete');
    if (fs.existsSync(marker) && fs.existsSync(exe(false))) return { java: exe(false), javaw: exe(true), home };
    const all = await http.cachedJson(JAVA_ALL_URL, path.join(this.runtimeDir, 'all.json'), { signal });
    const entry = all[platform]?.[component]?.[0];
    if (!entry) return { java: 'java', javaw: 'java', system: true };
    const manifest = await http.json(entry.manifest.url, { signal });
    const tasks = [];
    const links = [];
    const executables = [];
    for (const [rel, f] of Object.entries(manifest.files)) {
      const dest = path.join(home, rel);
      if (f.type === 'directory') await fsp.mkdir(dest, { recursive: true });
      else if (f.type === 'link') links.push({ dest, target: f.target });
      else if (f.type === 'file' && f.downloads?.raw) {
        const raw = f.downloads.raw;
        tasks.push({ url: raw.url, dest, sha1: raw.sha1, size: raw.size });
        if (f.executable) executables.push(dest);
      }
    }
    await http.downloadAll(tasks, { signal, onProgress, concurrency: 12 });
    if (process.platform !== 'win32') {
      for (const f of executables) await fsp.chmod(f, 0o755);
      for (const l of links) {
        await http.retryFs(() => fsp.rm(l.dest, { force: true }));
        await fsp.mkdir(path.dirname(l.dest), { recursive: true });
        await fsp.symlink(l.target, l.dest).catch(() => {});
      }
    }
    await fsp.writeFile(marker, new Date().toISOString());
    return { java: exe(false), javaw: exe(true), home };
  }

  /** Серверный JAR этой версии Minecraft. */
  async installServerJar(version, dest, { signal, onProgress } = {}) {
    const s = version.downloads?.server;
    if (!s) throw new Error('Для Minecraft ' + version.id + ' Mojang не публикует серверный JAR.');
    onProgress?.(0, 1);
    await http.download(s.url, dest, { sha1: s.sha1, size: s.size, signal });
    onProgress?.(1, 1);
  }
}

/** Офлайн-UUID так же, как его вычисляет сервер с online-mode=false. */
function offlineUuid(name) {
  const h = crypto.createHash('md5').update('OfflinePlayer:' + name).digest();
  h[6] = (h[6] & 0x0f) | 0x30;
  h[8] = (h[8] & 0x3f) | 0x80;
  return h.toString('hex');
}

function substitute(str, vars) {
  return str.replace(/\$\{([a-zA-Z_]+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

function expandArgs(list, vars, features, env) {
  const out = [];
  for (const a of list || []) {
    if (typeof a === 'string') out.push(substitute(a, vars));
    else if (a && rulesAllow(a.rules, features, env)) {
      for (const v of [].concat(a.value)) out.push(substitute(v, vars));
    }
  }
  return out;
}

/** Разложить файлы ресурсов по именам (жёсткая ссылка, если можно, иначе копия). */
async function placeNamed(named, dir) {
  for (const { name, file } of named) {
    const dest = path.join(dir, name);
    if (!dest.startsWith(dir + path.sep)) continue;
    try {
      await fsp.access(dest);
      continue;
    } catch {}
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.link(file, dest).catch(() => fsp.copyFile(file, dest));
  }
}

/**
 * Полная командная строка клиента.
 * opts: {gameDir, assetsDir, assetIndex, classpath, nativesDir, librariesDir, logging,
 *        username, ram, server: "host:port"|null, extraJvm: []}
 */
function buildClientArgs(version, opts, env) {
  const sep = (env?.os || osName()) === 'windows' ? ';' : ':';
  const a = opts.auth;
  const username = a?.name || opts.username;
  const uuid = a?.uuid || offlineUuid(username);
  const vars = {
    auth_player_name: username,
    version_name: version.id,
    game_directory: opts.gameDir,
    assets_root: opts.assetsDir,
    game_assets: opts.gameAssets || opts.assetsDir,
    assets_index_name: opts.assetIndex,
    auth_uuid: uuid,
    auth_access_token: a?.accessToken || '0',
    auth_session: a?.accessToken ? `token:${a.accessToken}:${uuid}` : '0',
    clientid: a?.clientId || '',
    auth_xuid: a?.xuid || '',
    user_type: a ? 'msa' : 'legacy',
    user_properties: '{}',
    version_type: 'easyLauncher',
    natives_directory: opts.nativesDir,
    launcher_name: 'easyLauncher',
    launcher_version: '1.0',
    classpath: opts.classpath.join(sep),
    classpath_separator: sep,
    library_directory: opts.librariesDir,
    quickPlayMultiplayer: opts.server || '',
    quickPlaySingleplayer: opts.world || '',
    quickPlayPath: '',
    resolution_width: String(opts.window?.width || ''),
    resolution_height: String(opts.window?.height || ''),
  };
  const gameArgsText = JSON.stringify(version.arguments?.game || []);
  const supportsQuickPlay = gameArgsText.includes('quickPlayMultiplayer');
  const features = {
    is_quick_play_multiplayer: !!opts.server && supportsQuickPlay,
    is_quick_play_singleplayer: !opts.server && !!opts.world && gameArgsText.includes('quickPlaySingleplayer'),
    // размер окна игры из настроек лаунчера
    has_custom_resolution: !!(opts.window?.width && opts.window?.height),
  };
  const jvm = [
    `-Xmx${opts.ram}G`,
    `-Xms${Math.min(opts.ram, 2)}G`,
    '-XX:+UseG1GC',
    '-XX:+ParallelRefProcEnabled',
    '-XX:MaxGCPauseMillis=200',
    '-XX:+UnlockExperimentalVMOptions',
    '-XX:+DisableExplicitGC',
    '-XX:G1NewSizePercent=30',
    '-XX:G1MaxNewSizePercent=40',
    '-XX:G1HeapRegionSize=8M',
    '-XX:G1ReservePercent=20',
    // журнал читается лаунчером как UTF-8: иначе русские названия миров приходят «????» (на Windows — cp1251)
    ...UTF8_JVM,
    ...(opts.extraJvm || []),
  ];
  let game;
  if (version.arguments) {
    jvm.push(...expandArgs(version.arguments.jvm, vars, features, env));
    game = expandArgs(version.arguments.game, vars, features, env);
  } else {
    jvm.push(
      `-Djava.library.path=${opts.nativesDir}`,
      '-Dminecraft.launcher.brand=easyLauncher',
      '-Dminecraft.launcher.version=1.0',
      '-cp',
      vars.classpath,
    );
    if ((env?.os || osName()) === 'osx') jvm.push('-XstartOnFirstThread');
    game = substitute(version.minecraftArguments || '', vars).split(' ').filter(Boolean);
    if (features.has_custom_resolution) game.push('--width', vars.resolution_width, '--height', vars.resolution_height);
  }
  if (opts.logging) jvm.push(opts.logging);
  if (opts.server && !supportsQuickPlay) {
    const [host, port = '25565'] = opts.server.split(':');
    game.push('--server', host, '--port', port);
  }
  return [...jvm, version.mainClass, ...game];
}

module.exports = { placeNamed, UTF8_JVM, javaEnv, Mojang, rulesAllow, mavenPath, mergeVersion, offlineUuid, buildClientArgs, osName, javaPlatform };
