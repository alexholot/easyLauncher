'use strict';
// Оркестратор: подготовка файлов и запуск сборки; совместная сессия на ПК хозяина; подключение гостя.
//   «Играть»            — сборка открывается в главном меню Minecraft (без комнаты, мира и подтверждений);
//   «Играть в мире»     — тот же запуск с быстрым входом в выбранный мир (если версия поддерживает);
//   «С друзьями»        — отдельный сценарий: сервер на ПК хозяина открывает мир сборки.
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { Mojang, buildClientArgs, javaEnv, placeNamed, offlineUuid } = require('./mojang');
const fabric = require('./fabric');
const loaders = require('./loaders');
const { LocalServer, lanAddresses } = require('./server');
const { readOverrides } = require('./serveradmin');
const { retryFs } = require('./http');
const { Store, readJson, writeJson } = require('./store');
const { Worlds } = require('./worlds');
const { ModCache } = require('./modcache');
const { SessionTracker } = require('./sessionlog');
const { inGame, onServer, validateLock } = require('./lock');

const NAME_RE = /^[A-Za-z0-9_]{3,16}$/;
const GiB = 1024 ** 3;

// ---- пробный запуск ----
// игра загрузилась до главного меню: звук и атласы текстур поднимаются в самом конце загрузки
// (1.13+ — «Sound engine started», до 1.13 — «Starting up SoundSystem», атлас блоков, отчёт FML)
const PROBE_READY = /Sound engine started|Starting up SoundSystem|SoundSystem Starting up|Created: \d+x\d+x?\d* (?:minecraft:)?textures(?:\/atlas\/blocks|-atlas)|Forge Mod Loader has successfully loaded \d+ mods/;
// признаки вылета или ошибок загрузки модов
const PROBE_FATAL = /---- Minecraft Crash Report ----|Mod Loading has failed|Incompatible mods found|FormattedException|Exception in thread "main"|#@!@# Game crashed|Crash report saved to|MixinApplyError|InvalidInjectionException|Skipping lifecycle event|Failed to complete lifecycle event|Mod loading errors? (?:has|have) occurred|ModLoadingException|Loading errors encountered/;
// Forge при ошибках загрузки модов не падает, а показывает экран ошибок; Fabric — своё окно ошибки и ждёт,
// пока его закроют (проверено на настоящей игре: без этого пробный запуск ждал 8 минут)
// Моды-«уведомители» (error_notifier и т. п.) тоже показывают окно «Found N error(s) during startup» и ждут
const PROBE_ERRORS = /Skipping lifecycle event|Failed to complete lifecycle event|Mod loading errors? (?:has|have) occurred|Loading errors encountered|Incompatible mods found|FormattedException|Mod resolution failed|Found \d+ errors? during startup|is a required dependency of .+ but it is not installed/;
// свой мод игрока, убранный на время пробного запуска
const PROBE_OFF = '.easylauncher-probe-off';

/** Закрыть процесс вместе с дочерними (Windows) — зависшая игра не должна остаться висеть. */
function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
    else process.kill(pid, 'SIGKILL');
  } catch {}
}

function dashedUuid(value) {
  const h = String(value || '').replace(/-/g, '').toLowerCase();
  return /^[0-9a-f]{32}$/.test(h) ? [h.slice(0, 8), h.slice(8, 12), h.slice(12, 16), h.slice(16, 20), h.slice(20)].join('-') : null;
}

/** Запись по имени заменяется целиком: один ник с лицензионным и офлайн-UUID одновременно не работает. */
async function whitelistPlayer(dir, name, uuid) {
  const id = dashedUuid(uuid);
  if (!NAME_RE.test(name || '') || !id) return false;
  const file = path.join(dir, 'whitelist.json');
  const old = await readJson(file);
  const list = Array.isArray(old) ? old.filter((x) => String(x?.name || '').toLowerCase() !== name.toLowerCase()) : [];
  list.push({ uuid: id, name });
  await writeJson(file, list);
  return true;
}

async function unwhitelistPlayer(dir, name) {
  if (!NAME_RE.test(name || '')) return false;
  const file = path.join(dir, 'whitelist.json');
  const old = await readJson(file);
  if (!Array.isArray(old)) return false;
  const list = old.filter((x) => String(x?.name || '').toLowerCase() !== name.toLowerCase());
  if (list.length === old.length) return false;
  await writeJson(file, list);
  return true;
}

const STAGES = {
  check: 'Проверка',
  files: 'Подготовка файлов',
  world: 'Создание мира',
  server: 'Запуск сервера',
  ready: 'Готов к подключению',
  game: 'Запуск Minecraft',
  prepare: 'Подготовка',
  connect: 'Подключение',
};

function cmpVersion(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

function fail(code, message, action) {
  return Object.assign(new Error(message), { code, action });
}

/** Своя Java из настроек (если файл на месте), иначе подобранная лаунчером. На Windows — javaw без консоли. */
function javaFor(custom, auto) {
  if (!custom || !fs.existsSync(custom)) return auto;
  const w = path.join(path.dirname(custom), 'javaw.exe');
  return process.platform === 'win32' && /java\.exe$/i.test(custom) && fs.existsSync(w) ? w : custom;
}

/** Включённые моды сборки (выключенные в папку mods не попадают). */
const enabled = (m) => m.enabled !== false;

/** Профиль настроек графики → options.txt, не затирая ручные настройки игрока. */
async function applyOptions(gameDir, profile) {
  const file = path.join(gameDir, 'options.txt');
  const stampFile = path.join(gameDir, '.easylauncher-profile.json');
  let text = '';
  let fresh = false;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch {
    fresh = true;
  }
  const stamp = JSON.stringify(profile || {});
  let last = '';
  try {
    last = await fsp.readFile(stampFile, 'utf8');
  } catch {}
  if (!fresh && (!profile || last === stamp)) return;
  const map = new Map();
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) map.set(line.slice(0, i), line.slice(i + 1));
  }
  if (fresh) map.set('lang', 'ru_ru');
  if (profile) {
    if (profile.render) map.set('renderDistance', profile.render);
    if (profile.simulation) map.set('simulationDistance', profile.simulation);
    if (profile.fps) map.set('maxFps', profile.fps);
    if (profile.graphics != null) map.set('graphicsMode', profile.graphics);
    if (profile.fullscreen != null) map.set('fullscreen', profile.fullscreen ? 'true' : 'false');
  }
  await fsp.mkdir(gameDir, { recursive: true });
  await retryFs(() => fsp.writeFile(file, [...map].map(([k, v]) => `${k}:${v}`).join('\n') + '\n'), 'options.txt');
  await fsp.writeFile(stampFile, stamp);
}

/** Последний crash-report или хвост latest.log. */
async function crashText(gameDir, since) {
  try {
    const dir = path.join(gameDir, 'crash-reports');
    const files = (await fsp.readdir(dir))
      .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .filter((x) => x.t >= since)
      .sort((a, b) => b.t - a.t);
    if (files[0]) return (await fsp.readFile(path.join(dir, files[0].f), 'utf8')).slice(0, 200000);
  } catch {}
  try {
    return (await fsp.readFile(path.join(gameDir, 'logs', 'latest.log'), 'utf8')).slice(-200000);
  } catch {}
  return '';
}

class Launcher extends EventEmitter {
  constructor(root, opts = {}) {
    super();
    this.root = root;
    this.shared = path.join(root, 'shared');
    this.store = new Store(root);
    this.worlds = new Worlds(this.store);
    this.mojang = new Mojang(this.shared);
    this.cache = new ModCache(this.shared);
    this.server = new LocalServer();
    this.totalMem = opts.totalMem || os.totalmem();
    this.client = null; // {proc, profileId, mode, gameDir, tracker}
    this.clientLines = [];
    this.abort = null;
    // сессия «без Microsoft» по локальной сети закрыта — адресы для прямого подключения не показываем
    const lan = () => (this.server.lanClosed ? [] : lanAddresses());
    this.lanList = lan;
    this.server.on('state', (s) => this.emit('event', { type: 'server', ...s, profileId: this.server.profileId, folder: this.server.folder, addresses: lan(), lanClosed: !!this.server.lanClosed }));
    this.server.on('log', (line) => this.emit('event', { type: 'log', source: 'server', line }));
    this.server.on('spawn', (pid) => this.server.folder && this.worlds.setLockPid(this.server.profileId, this.server.folder, pid).catch(() => {}));
    this.server.on('exit', (e) => e.folder && this.worlds.release(e.profileId, e.folder).catch(() => {}));
  }

  stage(stage, extra = {}) {
    this.emit('event', { type: 'stage', stage, label: STAGES[stage] || stage, ...extra });
  }

  /** Все версии Minecraft: [{id, type: release|snapshot|old_beta|old_alpha, releaseTime}]. */
  async versions() {
    return this.mojang.allVersions();
  }

  status() {
    return {
      client: !!this.client,
      clientProfile: this.client?.profileId || null,
      clientMode: this.client?.mode || null,
      playingLevel: this.client?.tracker.playingLevel() || null,
      server: this.server.state,
      serverProfile: this.server.profileId,
      serverFolder: this.server.folder,
      port: this.server.port,
      players: [...this.server.players],
      addresses: this.lanList(),
      lanClosed: !!this.server.lanClosed,
      preparing: !!this.abort,
    };
  }

  cancel() {
    this.abort?.abort();
  }

  /** Сборка сейчас используется игрой или сервером — менять её состав нельзя. */
  profileBusy(pid) {
    return (this.client && this.client.profileId === pid) || (this.server.state !== 'stopped' && this.server.profileId === pid) || this.preparing === pid;
  }

  /** Память: клиент + сервер + резерв для ОС не должны превышать объём ОЗУ. */
  checkMemory(ram, serverRam) {
    const total = this.totalMem / GiB;
    const reserve = Math.max(2, Math.round(total * 0.2));
    if (ram + serverRam + reserve > total + 0.5)
      throw fail(
        'NO_MEMORY',
        `Не хватает памяти: игре ${ram} ГБ${serverRam ? ` + серверу ${serverRam} ГБ` : ''} + системе ${reserve} ГБ, а у компьютера ${total.toFixed(0)} ГБ.`,
        'Уменьши память в настройках сборки.',
      );
  }

  /** Файлы игры для сборки: Minecraft, загрузчик, Java, библиотеки, ресурсы. Прогресс — по реальным данным. */
  async prepareRuntime(lock, signal) {
    const sub = (label) => (done, total, unit) =>
      this.stage('files', { detail: label, done, total, unit, percent: total ? Math.floor((done / total) * 100) : null });
    const loaderName = loaders.LABELS[lock.loader] || lock.loader;
    // сначала обычный Minecraft этой версии и его Java: на них ставится любой загрузчик
    const base = await this.mojang.getVersion(lock.minecraft, { signal });
    const java = await this.mojang.installJava(base, { signal, onProgress: sub('Java') });
    let versionId = lock.minecraft;
    let loaderVersion = lock.loaderVersion || null;
    if (lock.loader !== 'vanilla') {
      if (!loaders.LOADERS.includes(lock.loader)) throw fail('LOADER', `Неизвестный загрузчик ${lock.loader}.`);
      this.stage('files', { detail: loaderName, percent: null });
      if (!loaderVersion) {
        let list;
        try {
          list = await loaders.loaderVersions(lock.loader, lock.minecraft, { signal });
        } catch (e) {
          throw fail('LOADER', `Не удалось узнать версии ${loaderName}: ${e.message}`, 'Проверь интернет и повтори.');
        }
        loaderVersion = loaders.pickLoaderVersion(list);
        if (!loaderVersion) throw fail('LOADER', `${loaderName} не поддерживает Minecraft ${lock.minecraft}.`, 'Выбери другую версию игры или загрузчик.');
      }
      if (lock.loader === 'fabric' || lock.loader === 'quilt') versionId = await loaders.installMetaProfile(this.mojang, lock.loader, lock.minecraft, loaderVersion, { signal });
      else {
        // установщику Forge/NeoForge нужен уже скачанный обычный клиент этой версии
        await this.mojang.installClient(base, { signal, onProgress: sub('Библиотеки и игра') });
        versionId = await loaders.installForgeClient(this.mojang, lock.loader, lock.minecraft, loaderVersion, {
          java: java.java,
          signal,
          onLog: (line) => this.stage('files', { detail: `${loaderName}: ${line.slice(0, 90)}`, percent: null }),
        });
      }
    }
    const version = versionId === lock.minecraft ? base : await this.mojang.getVersion(versionId, { signal });
    const client = await this.mojang.installClient(version, { signal, onProgress: sub('Библиотеки и игра') });
    const assets = await this.mojang.installAssets(version, { signal, onProgress: sub('Ресурсы игры') });
    return { version, base, java, client, assets, loaderVersion };
  }

  /** Как запускать сервер сессии для загрузчика сборки: {jar} или {args}. */
  async prepareServerLaunch(lock, rt, dir, signal) {
    const loaderName = loaders.LABELS[lock.loader] || lock.loader;
    this.stage('server', { detail: lock.loader === 'vanilla' ? 'Сервер Minecraft' : `Сервер ${loaderName}`, percent: null });
    if (lock.loader === 'fabric') return { jar: await fabric.installServerLauncher(dir, lock.minecraft, rt.loaderVersion, { signal }) };
    if (lock.loader === 'quilt') return loaders.installQuiltServer(this.mojang, lock.minecraft, rt.loaderVersion, dir, { signal, baseVersion: rt.base });
    if (lock.loader === 'forge' || lock.loader === 'neoforge')
      return loaders.installForgeServer(this.mojang, lock.loader, lock.minecraft, rt.loaderVersion, dir, {
        java: rt.java.java,
        signal,
        baseVersion: rt.base,
        onLog: (line) => this.stage('server', { detail: `${loaderName}: ${line.slice(0, 90)}`, percent: null }),
      });
    const jar = path.join(dir, 'server.jar');
    await this.mojang.installServerJar(rt.base, jar, { signal });
    return { jar };
  }

  /** Файлы модов → общий кэш (с проверкой хешей) → папки mods клиента и (для сессии) сервера. */
  async prepareMods(pid, lock, { server = false, signal } = {}) {
    const active = lock.loader === 'vanilla' ? [] : lock.mods.filter(enabled);
    const needed = active.filter((e) => inGame(e) || (server && onServer(e)));
    const total = needed.reduce((a, e) => a + (e.file.size || 0), 0);
    let done = 0;
    const report = () => this.stage('files', { detail: 'Моды', done, total, unit: 'bytes', percent: total ? Math.floor((done / total) * 100) : null });
    for (const e of needed) {
      const before = done;
      await this.cache.ensure(e, {
        signal,
        onBytes: (n) => {
          done += n;
          report();
        },
      });
      done = before + (e.file.size || 0);
      report();
    }
    await this.cache.materialize(path.join(this.store.gameDir(pid), 'mods'), active.filter(inGame));
    if (server) await this.cache.materialize(path.join(this.store.serverDir(pid), 'mods'), active.filter(onServer));
  }

  async loadProfile(profileId) {
    const profile = await this.store.getProfile(profileId);
    const lock = validateLock(await this.store.getLock(profileId));
    return { profile, lock };
  }

  /** Одна подготовка за раз; пока она идёт, состав этой сборки менять нельзя (папка mods раскладывается). */
  async withAbort(fn, pid = null) {
    if (this.abort) throw fail('BUSY', 'Подготовка уже идёт.');
    const ac = new AbortController();
    this.abort = ac;
    this.preparing = pid;
    try {
      return await fn(ac.signal);
    } finally {
      this.abort = null;
      this.preparing = null;
    }
  }

  /**
   * «Играть». req: {profileId, auth?, nickname, ram, options, world?: папка мира, server?: 'host:port'}.
   * Без мира открывается главное меню Minecraft.
   */
  async play(req) {
    if (this.client) throw fail('CLIENT_RUNNING', 'Minecraft уже запущен.', 'Закрой игру, чтобы запустить другую сборку.');
    const name = req.auth?.name || req.nickname;
    if (!req.auth && !NAME_RE.test(name || '')) throw fail('NAME', 'Никнейм: 3–16 символов, латиница, цифры и _.', 'Задай никнейм в профиле.');
    return this.withAbort(async (signal) => {
      this.stage('check');
      const { profile, lock } = await this.loadProfile(req.profileId);
      if (req.world) {
        const w = await this.worlds.get(profile.id, req.world);
        if (await this.worlds.holder(profile.id, req.world)) throw fail('WORLD_LOCKED', `Мир «${w.name}» сейчас открыт сервером совместной игры.`, 'Подключись к сессии или заверши её.');
      }
      this.checkMemory(req.ram, 0);
      this.stage('files');
      const rt = await this.prepareRuntime(lock, signal);
      if (rt.loaderVersion && rt.loaderVersion !== lock.loaderVersion) {
        lock.loaderVersion = rt.loaderVersion;
        await this.store.saveLock(profile.id, lock);
      }
      await this.prepareMods(profile.id, lock, { signal });
      const gameDir = this.store.gameDir(profile.id);
      await applyOptions(gameDir, req.options);
      if (rt.assets.mapToResources) await placeNamed(rt.assets.mapToResources, path.join(gameDir, 'resources'));
      this.stage('game');
      const supportsWorld = JSON.stringify(rt.version.arguments?.game || []).includes('quickPlaySingleplayer');
      const args = buildClientArgs(rt.version, {
        gameDir,
        assetsDir: this.mojang.assetsDir,
        assetIndex: rt.assets.index,
        gameAssets: rt.assets.mapToResources ? path.join(gameDir, 'resources') : rt.assets.gameAssets,
        classpath: rt.client.classpath,
        nativesDir: rt.client.nativesDir,
        librariesDir: this.mojang.librariesDir,
        logging: rt.client.logging,
        username: name,
        auth: req.auth || null,
        ram: Math.max(1, Number(req.ram) || 4),
        server: req.server || null,
        world: req.world && supportsWorld ? req.world : null,
        extraJvm: req.jvmArgs || [],
        window: req.window || null,
      });
      this.startClient(javaFor(req.javaPath, rt.java.javaw), args, { gameDir, profileId: profile.id, mode: req.server ? 'server' : 'play', player: name });
      await this.store.updateProfile(profile.id, { lastPlayed: new Date().toISOString() });
      return { ok: true, worldJoin: req.world ? supportsWorld : null };
    }, req.profileId);
  }

  /**
   * Можно ли открыть сессию с друзьями на этой версии. Нужен серверный JAR от Mojang и проверка
   * аккаунтов через sessionserver.mojang.com — она появилась в 1.7.2 (25.10.2013); старый сервис
   * session.minecraft.net отключён, у альфы и беты сервера в описании нет вовсе.
   */
  async coopSupport(minecraft, signal) {
    const v = await this.mojang.getVersion(minecraft, { signal });
    if (!v.downloads?.server || (v.releaseTime || '') < '2013-10-25')
      return { ok: false, reason: `Игра с друзьями работает с Minecraft 1.7.2 и новее. У ${minecraft} нет сервера, который умеет проверять аккаунты Microsoft.` };
    return { ok: true };
  }

  /**
   * Совместная сессия: сервер на ПК хозяина открывает мир сборки (или создаёт новый).
   * req: {profileId, folder?, create?: {name, seed, gamemode, difficulty, hardcore}, auth, eula, serverRam, options, players, offlineGuests?}
   */
  async startSession(req) {
    if (this.server.state !== 'stopped') throw fail('SESSION_ACTIVE', 'Сессия уже запущена.', 'Заверши её, чтобы открыть другой мир.');
    if (!req.auth) throw fail('AUTH_REQUIRED', 'Для игры с друзьями нужен вход через Microsoft: сервер проверяет аккаунты всех игроков.', 'Войди в аккаунт.');
    if (req.eula !== true) throw fail('EULA', 'Перед первым запуском сервера нужно принять Minecraft EULA.', 'Прими EULA.');
    return this.withAbort(async (signal) => {
      this.stage('check');
      const { profile, lock } = await this.loadProfile(req.profileId);
      const support = await this.coopSupport(lock.minecraft, signal);
      if (!support.ok) throw fail('COOP_UNSUPPORTED', support.reason, 'Для игры с друзьями создай сборку на Minecraft 1.7.2 или новее.');
      let folder = req.folder;
      let world = null;
      if (folder) {
        world = await this.worlds.get(profile.id, folder);
        // имя мира в журнале клиента появляется не сразу — пока оно неизвестно, считаем, что открыт любой
        const sp = this.client?.profileId === profile.id && this.client.tracker.current?.type === 'singleplayer';
        if (sp && [null, world.name].includes(this.client.tracker.playingLevel()))
          throw fail('WORLD_IN_USE', `Мир «${world.name}» может быть открыт в одиночной игре.`, 'Выйди из мира в главное меню Minecraft.');
      } else {
        folder = await this.worlds.freeFolder(profile.id, req.create?.name);
      }
      this.checkMemory(0, Number(req.serverRam) || 2);
      this.stage('files');
      const rt = await this.prepareRuntime(lock, signal);
      await this.prepareMods(profile.id, lock, { server: true, signal });
      this.stage(world ? 'server' : 'world');
      const dir = this.store.serverDir(profile.id);
      const launch = await this.prepareServerLaunch(lock, rt, dir, signal);
      const c = req.create || {};
      const props = {
        motd: (world?.name || c.name || 'easyLauncher').replace(/[\r\n]/g, ' ').slice(0, 59),
        'max-players': Math.max(2, Math.min(64, Number(req.players) || 8)),
        // Режим без проверки аккаунтов включается хозяином явно только для закрытой сессии по приглашению.
        // Белый список и допуск через P2P остаются включены, но ник офлайн-игрока можно подделать.
        'online-mode': req.offlineGuests !== true,
        'white-list': true,
        'enforce-whitelist': true,
        'level-seed': c.seed || '',
        // иначе новый мир получает в level.dat имя «world», а не то, что ввёл хозяин
        'level-name': folder,
        gamemode: c.gamemode || world?.gamemode || 'survival',
        difficulty: c.difficulty || 'normal',
        hardcore: !!(c.hardcore || world?.hardcore),
        'view-distance': req.options?.render || 10,
        'simulation-distance': req.options?.simulation || 6,
        'spawn-protection': 0,
        // команды, которые лаунчер шлёт серверу (значок ♪ голосового чата, координаты для объёмного звука),
        // иначе дублируются в чат хозяину-оператору серыми строками [Server: …]
        'broadcast-console-to-ops': false,
        // то, что хозяин выбрал в админ-панели, важнее значений по умолчанию (проверку аккаунтов панель не меняет)
        ...(await readOverrides(dir)),
        // «без Microsoft» сервер ники не проверяет: из локальной сети (Wi-Fi в кафе, общежитие) любой зашёл бы
        // напрямую под ником хозяина в обход приглашений. Тогда сервер слушает только этот ПК — друзья по
        // приглашению идут через туннель лаунчера, он подключается к 127.0.0.1. С Microsoft — вся сеть, как раньше.
        'server-ip': req.offlineGuests === true ? '127.0.0.1' : '',
      };
      // до 1.13 сервер читает режим и сложность только числами: «creative» превратился бы в выживание
      if (!rt.base.arguments) {
        props.gamemode = { survival: 0, creative: 1, adventure: 2, spectator: 3 }[props.gamemode] ?? 0;
        props.difficulty = { peaceful: 0, easy: 1, normal: 2, hard: 3 }[props.difficulty] ?? 2;
      }
      // В офлайн-режиме команда whitelist add может найти лицензионный UUID по нику и записать его,
      // хотя подключение придёт с офлайн-UUID. Готовим точную запись до запуска сервера.
      const hostListed = await whitelistPlayer(dir, req.auth.name, req.offlineGuests === true ? offlineUuid(req.auth.name) : req.auth.uuid);
      // Порт мог занять другой процесс между проверкой и стартом Java — пробуем следующий
      let port = 25565;
      for (let attempt = 0; ; attempt++) {
        try {
          await this.worlds.acquire(profile.id, folder, 'server');
          this.server.lanClosed = req.offlineGuests === true;
          const started = this.server.start({
            dir,
            java: rt.java.java,
            jar: launch.jar,
            launchArgs: launch.args,
            ram: Math.max(1, Number(req.serverRam) || 2),
            eula: true,
            properties: props,
            programArgs: ['--universe', this.worlds.savesDir(profile.id), '--world', folder],
            worldKey: `${profile.id}/${folder}`,
            folder,
            profileId: profile.id,
            port,
          });
          await new Promise((resolve, reject) => {
            const onAbort = () => {
              this.server.stop();
              reject(fail('CANCELLED', 'Подготовка отменена.'));
            };
            signal.addEventListener('abort', onAbort, { once: true });
            started.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
          });
          break;
        } catch (e) {
          await this.worlds.release(profile.id, folder).catch(() => {});
          if (e.code !== 'PORT_BUSY' || attempt >= 2) throw e;
          port = (this.server.port || port) + 1;
        }
      }
      if (!hostListed) this.server.command('whitelist add ' + req.auth.name);
      // для перезапуска из админ-панели: тот же мир, та же сборка
      this.lastSession = { ...req, folder, create: null };
      await this.worlds.recordSession(profile.id, folder, { mode: 'host' });
      this.stage('ready', { port: this.server.port });
      return { ok: true, folder, port: this.server.port, address: '127.0.0.1:' + this.server.port };
    }, req.profileId);
  }

  /** Разрешить вход игроку (гостю по приглашению) / отозвать. */
  async allowPlayer(name) {
    if (!NAME_RE.test(name)) throw new Error('Некорректное имя игрока.');
    if (this.lastSession?.offlineGuests === true) {
      await whitelistPlayer(this.store.serverDir(this.server.profileId), name, offlineUuid(name));
      this.server.command('whitelist reload');
      return;
    }
    this.server.command('whitelist add ' + name);
  }
  async removePlayer(name) {
    if (!NAME_RE.test(name)) throw new Error('Некорректное имя игрока.');
    await unwhitelistPlayer(this.store.serverDir(this.server.profileId), name);
    this.server.command('whitelist reload');
    this.server.command('kick ' + name + ' Приглашение отозвано');
  }

  /** Гость: сборка комнаты, подключение к локальному концу туннеля. */
  async playGuest({ profileId, address, auth, offlineName, ram, options }) {
    if (this.client) throw fail('CLIENT_RUNNING', 'Minecraft уже запущен.');
    const username = auth?.name || offlineName;
    if (!auth && !NAME_RE.test(username || '')) throw fail('AUTH_REQUIRED', 'Хозяин не разрешил вход без Microsoft или не указан офлайн-ник.', 'Войди в аккаунт или попроси хозяина включить тестовый режим.');
    if (!/^127\.0\.0\.1:\d{2,5}$/.test(address)) throw fail('ADDRESS', 'Некорректный локальный адрес туннеля.');
    return this.withAbort(async (signal) => {
      const lock = validateLock(await this.store.getLock(profileId));
      this.checkMemory(ram, 0);
      this.stage('prepare');
      const rt = await this.prepareRuntime(lock, signal);
      await this.prepareMods(profileId, lock, { signal });
      const gameDir = this.store.gameDir(profileId);
      await applyOptions(gameDir, options);
      if (rt.assets.mapToResources) await placeNamed(rt.assets.mapToResources, path.join(gameDir, 'resources'));
      this.stage('connect');
      const args = buildClientArgs(rt.version, {
        gameDir,
        assetsDir: this.mojang.assetsDir,
        assetIndex: rt.assets.index,
        gameAssets: rt.assets.mapToResources ? path.join(gameDir, 'resources') : rt.assets.gameAssets,
        classpath: rt.client.classpath,
        nativesDir: rt.client.nativesDir,
        librariesDir: this.mojang.librariesDir,
        logging: rt.client.logging,
        username,
        auth,
        ram: Math.max(1, Number(ram) || 4),
        server: address,
      });
      this.startClient(rt.java.javaw, args, { gameDir, profileId, mode: 'guest', player: username });
      return { ok: true };
    }, profileId);
  }

  /**
   * Пробный запуск: игра стартует с заданным набором модов, лаунчер ждёт по журналу, пока она загрузится
   * до главного меню, и закрывает её. Не считается игрой (часы, летопись, камера не трогаются).
   * mods — записи lock для этого запуска (null — моды сборки как есть); folderOff — свои файлы игрока
   * в папке mods, которые на этот запуск убираются (возвращаются в любом случае).
   * Ответ: { ok: true|false|null, reason: 'loaded'|'crashed'|'errors'|'timeout'|'cancelled', crash, evidence, seconds }.
   */
  async probe(req, { mods = null, folderOff = [], timeoutMs = 8 * 60 * 1000, graceMs = Number(process.env.EASY_PROBE_GRACE_MS) || 20000 } = {}) {
    if (this.client) throw fail('CLIENT_RUNNING', 'Minecraft уже запущен.', 'Закрой игру, чтобы проверить запуск.');
    const name = req.auth?.name || req.nickname;
    if (!req.auth && !NAME_RE.test(name || '')) throw fail('NAME', 'Никнейм: 3–16 символов, латиница, цифры и _.', 'Задай никнейм в профиле.');
    const prep = await this.withAbort(async (signal) => {
      this.stage('check');
      const { profile, lock } = await this.loadProfile(req.profileId);
      this.checkMemory(req.ram, 0);
      this.stage('files');
      const rt = await this.prepareRuntime(lock, signal);
      if (rt.loaderVersion && rt.loaderVersion !== lock.loaderVersion) {
        lock.loaderVersion = rt.loaderVersion;
        await this.store.saveLock(profile.id, lock);
      }
      await this.prepareMods(profile.id, mods ? { ...lock, mods } : lock, { signal });
      const gameDir = this.store.gameDir(profile.id);
      await applyOptions(gameDir, req.options);
      if (rt.assets.mapToResources) await placeNamed(rt.assets.mapToResources, path.join(gameDir, 'resources'));
      const args = buildClientArgs(rt.version, {
        gameDir,
        assetsDir: this.mojang.assetsDir,
        assetIndex: rt.assets.index,
        gameAssets: rt.assets.mapToResources ? path.join(gameDir, 'resources') : rt.assets.gameAssets,
        classpath: rt.client.classpath,
        nativesDir: rt.client.nativesDir,
        librariesDir: this.mojang.librariesDir,
        logging: rt.client.logging,
        username: name,
        auth: req.auth || null,
        ram: Math.max(1, Number(req.ram) || 4),
        extraJvm: req.jvmArgs || [],
        window: { width: 854, height: 480, fullscreen: false },
      });
      return { java: javaFor(req.javaPath, rt.java.javaw), args, gameDir, profileId: profile.id };
    }, req.profileId);
    // свои моды игрока, не участвующие в этом запуске, — временно в сторону (с меткой, чтобы вернуть даже после сбоя)
    const modsDir = path.join(prep.gameDir, 'mods');
    const moved = [];
    try {
      for (const f of folderOff) {
        const from = path.join(modsDir, path.basename(f));
        if (!fs.existsSync(from)) continue;
        await fsp.rename(from, from + PROBE_OFF);
        moved.push(from);
      }
      return await this.runProbe(prep, { timeoutMs, graceMs });
    } finally {
      for (const from of moved) await fsp.rename(from + PROBE_OFF, from).catch(() => {});
    }
  }

  runProbe({ java, args, gameDir, profileId }, { timeoutMs, graceMs }) {
    return new Promise((resolve) => {
      const started = Date.now();
      const lines = [];
      let state = 'loading'; // loading → ready → done
      let verdict = null;
      let evidence = null;
      let errTimer = false;
      const proc = spawn(java, args, { cwd: gameDir, env: javaEnv(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false });
      this.client = { proc, profileId, mode: 'probe', probe: true, killed: false };
      this.emit('event', { type: 'probe', state: 'running', profileId });
      const timers = [];
      const stop = (v) => {
        if (verdict) return;
        verdict = v;
        if (this.client?.proc === proc) this.client.killed = true;
        try {
          proc.kill();
        } catch {}
        // процесс не закрылся сам — через 10 с принудительно (Windows: дерево процессов)
        timers.push(setTimeout(() => killTree(proc.pid), 10000));
      };
      this.probeStop = () => stop({ ok: null, reason: 'cancelled' });
      timers.push(setTimeout(() => stop({ ok: null, reason: 'timeout' }), timeoutMs));
      const onLine = (line) => {
        lines.push(line);
        if (lines.length > 4000) lines.splice(0, 1000);
        this.emit('event', { type: 'log', source: 'probe', line });
        if (verdict) return;
        const errorScreen = PROBE_ERRORS.test(line);
        if (PROBE_FATAL.test(line) || errorScreen) evidence = evidence || line.trim().slice(0, 300);
        // ошибки загрузки модов показываются окном или экраном, а не падением — дальше ждать нечего
        // (3 с — чтобы успели записаться следующие строки с причиной)
        if (errorScreen && !errTimer) {
          errTimer = true;
          timers.push(setTimeout(() => stop({ ok: false, reason: 'errors' }), 3000));
        }
        if (state === 'loading' && PROBE_READY.test(line)) {
          state = 'ready';
          this.emit('event', { type: 'probe', state: 'ready', profileId });
          // после загрузки ресурсов Forge ещё завершает загрузку модов — немного ждём, не упадёт ли
          timers.push(setTimeout(() => stop({ ok: evidence ? false : true, reason: evidence ? 'errors' : 'loaded' }), graceMs));
        }
      };
      const reader = (stream) => {
        let buf = '';
        stream.setEncoding('utf8');
        stream.on('data', (chunk) => {
          buf += chunk;
          const parts = buf.split(/\r?\n/);
          buf = parts.pop();
          for (const l of parts) onLine(l);
        });
      };
      reader(proc.stdout);
      reader(proc.stderr);
      const finish = async (code, error) => {
        for (const t of timers) clearTimeout(t);
        if (this.client?.proc === proc) this.client = null;
        this.probeStop = null;
        let v = verdict;
        // игра закрылась сама, не дойдя до проверки, — вылет
        if (!v) v = { ok: false, reason: 'crashed' };
        let crash = '';
        if (v.ok === false) {
          crash = (await crashText(gameDir, started)) || lines.slice(-400).join('\n');
          // окно ошибки загрузки пишет причину только в вывод игры, а не в latest.log
          if (v.reason === 'errors') crash += '\n' + lines.slice(-200).join('\n');
          if (error) crash = error + '\n' + crash;
        }
        const out = { ...v, crash, evidence, code, seconds: Math.round((Date.now() - started) / 1000) };
        this.emit('event', { type: 'probe', state: 'stopped', profileId, ok: out.ok, reason: out.reason });
        resolve(out);
      };
      proc.on('error', (e) => finish(-1, 'Не удалось запустить Java: ' + e.message));
      proc.on('close', (code) => finish(code));
    });
  }

  /** Остановить пробный запуск (кнопка «Отмена»). */
  stopProbe() {
    this.probeStop?.();
    this.cancel();
  }

  startClient(java, args, ctx) {
    const started = Date.now();
    this.clientLines = [];
    const tracker = new SessionTracker({ player: ctx.player });
    const proc = spawn(java, args, { cwd: ctx.gameDir, env: javaEnv(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false });
    this.client = { proc, tracker, ...ctx };
    tracker.on('world', (level) => this.emit('event', { type: 'client-world', profileId: ctx.profileId, level }));
    // достижения и смерти игрока — повод для «Камеры воспоминаний» сохранить момент
    tracker.on('moment', (m) => this.emit('event', { type: 'moment', profileId: ctx.profileId, ...m }));
    tracker.on('singleplayer-end', (s) => this.emit('event', { type: 'world-session', profileId: ctx.profileId, ...s }));
    // игра на сервере (у хозяина — свой сервер сессии): вход и выход — для летописи мира сервера
    tracker.on('multiplayer', (s) => this.emit('event', { type: 'client-server', profileId: ctx.profileId, server: s.server }));
    tracker.on('multiplayer-end', (s) => this.emit('event', { type: 'server-session', profileId: ctx.profileId, server: s.server, shots: s.shots }));
    tracker.on('screenshot', (s) => this.emit('event', { type: 'screenshot', profileId: ctx.profileId, ...s }));
    this.emit('event', { type: 'client', state: 'running', mode: ctx.mode, profileId: ctx.profileId });
    const reader = (stream) => {
      let buf = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        buf += chunk;
        const parts = buf.split(/\r?\n/);
        buf = parts.pop();
        for (const line of parts) {
          this.clientLines.push(line);
          if (this.clientLines.length > 3000) this.clientLines.splice(0, 1000);
          tracker.feed(line);
          this.emit('event', { type: 'log', source: 'client', line });
        }
      });
    };
    reader(proc.stdout);
    reader(proc.stderr);
    const finish = async (code, error) => {
      if (this.client?.proc !== proc) return;
      tracker.end();
      const killed = !!this.client.killed;
      this.client = null;
      let text = '';
      if ((code !== 0 || error) && !killed) {
        text = (await crashText(ctx.gameDir, started)) || this.clientLines.slice(-400).join('\n');
        if (error) text = error + '\n' + text;
      }
      this.emit('event', {
        type: 'client',
        state: 'stopped',
        mode: ctx.mode,
        profileId: ctx.profileId,
        code,
        killed,
        crash: text,
        // игрок закрыл игру, а его сервер ещё работает — интерфейс спросит, что делать
        sessionActive: this.server.state === 'running' && this.server.profileId === ctx.profileId,
        seconds: (Date.now() - started) / 1000,
      });
    };
    proc.on('error', (e) => finish(-1, 'Не удалось запустить Java: ' + e.message));
    proc.on('close', (code) => finish(code));
  }

  /** Принудительное закрытие по просьбе игрока — это не вылет, окно об ошибке не показывается. */
  stopClient() {
    if (!this.client) return;
    this.client.killed = true;
    this.client.proc.kill();
  }

  /**
   * ВРЕМЕННО, для проверки голоса на одном компьютере: второй Minecraft под ником name заходит
   * прямо на сервер сессии (127.0.0.1). Не считается игрой (часы, летопись, камера не трогаются).
   * Своя папка игры вне сборки; моды и их настройки — те же (ссылки на папки сборки), звук игры выключен.
   */
  async startTestClient({ profileId, name, options }) {
    if (this.server.state !== 'running' || this.server.profileId !== profileId) throw fail('NO_SESSION', 'Сессия не запущена.');
    if (this.testClient) throw fail('TEST_RUNNING', 'Второй игрок уже запущен.');
    if (!NAME_RE.test(name || '')) throw fail('NAME', 'Некорректный ник.');
    const lock = validateLock(await this.store.getLock(profileId));
    const rt = await this.prepareRuntime(lock, new AbortController().signal);
    const main = this.store.gameDir(profileId);
    const gameDir = path.join(this.store.root, 'test-client', profileId);
    await fsp.mkdir(gameDir, { recursive: true });
    for (const sub of ['mods', 'config', 'defaultconfigs']) {
      const target = path.join(main, sub);
      const link = path.join(gameDir, sub);
      if (!fs.existsSync(target)) continue;
      // ссылка уже есть — оставляем (никогда не удаляем: за ней папки сборки)
      if (await fsp.lstat(link).catch(() => null)) continue;
      await fsp.symlink(target, link, 'junction');
    }
    await applyOptions(gameDir, options);
    // звук второй игры не нужен (голос играет лаунчер), и не открывать меню паузы без фокуса
    const optFile = path.join(gameDir, 'options.txt');
    let opt = await fsp.readFile(optFile, 'utf8').catch(() => '');
    for (const [k, v] of [['soundCategory_master', '0.0'], ['pauseOnLostFocus', 'false']]) {
      const re = new RegExp(`^${k}:.*$`, 'm');
      opt = re.test(opt) ? opt.replace(re, `${k}:${v}`) : opt + (opt && !opt.endsWith('\n') ? '\n' : '') + `${k}:${v}\n`;
    }
    await fsp.writeFile(optFile, opt);
    if (rt.assets.mapToResources) await placeNamed(rt.assets.mapToResources, path.join(gameDir, 'resources'));
    const args = buildClientArgs(rt.version, {
      gameDir,
      assetsDir: this.mojang.assetsDir,
      assetIndex: rt.assets.index,
      gameAssets: rt.assets.mapToResources ? path.join(gameDir, 'resources') : rt.assets.gameAssets,
      classpath: rt.client.classpath,
      nativesDir: rt.client.nativesDir,
      librariesDir: this.mojang.librariesDir,
      logging: rt.client.logging,
      username: name,
      auth: null,
      ram: 2,
      server: '127.0.0.1:' + this.server.port,
      window: { width: 854, height: 480, fullscreen: false },
    });
    const proc = spawn(rt.java.javaw, args, { cwd: gameDir, env: javaEnv(), stdio: 'ignore', windowsHide: false });
    this.testClient = proc;
    const done = () => {
      if (this.testClient !== proc) return;
      this.testClient = null;
      this.emit('event', { type: 'test-client', state: 'stopped' });
    };
    proc.on('error', done);
    proc.on('close', done);
    return proc;
  }
  stopTestClient() {
    const p = this.testClient;
    if (!p) return;
    try {
      p.kill();
    } catch {}
    // не закрылся сам — через 10 с принудительно (только если это всё ещё он)
    const t = setTimeout(() => this.testClient === p && killTree(p.pid), 10000);
    t.unref?.();
  }

  /** Сохранить мир и завершить сессию. */
  async endSession() {
    this.stopTestClient();
    await this.server.stop();
  }

  /** Перезапуск сервера с тем же миром — чтобы применились настройки server.properties. */
  async restartSession() {
    if (!this.lastSession || this.server.state === 'stopped') throw fail('NO_SESSION', 'Сессия не запущена.');
    const req = this.lastSession;
    await this.server.stop();
    await this.worlds.release(req.profileId, req.folder).catch(() => {});
    return this.startSession(req);
  }

  async shutdown() {
    this.cancel();
    this.stopTestClient();
    await this.server.stop();
  }
}

/** Свои моды, оставшиеся убранными после сбоя пробного запуска (лаунчер закрыли посреди проверки), — вернуть. */
async function restoreProbeLeftovers(modsDir) {
  let names = [];
  try {
    names = await fsp.readdir(modsDir);
  } catch {
    return 0;
  }
  let n = 0;
  for (const f of names.filter((x) => x.endsWith(PROBE_OFF))) {
    const from = path.join(modsDir, f);
    const to = from.slice(0, -PROBE_OFF.length);
    if (fs.existsSync(to)) continue;
    await fsp.rename(from, to).then(() => n++, () => {});
  }
  return n;
}

module.exports = { Launcher, applyOptions, cmpVersion, STAGES, enabled, restoreProbeLeftovers, PROBE_READY, PROBE_FATAL, PROBE_OFF };
