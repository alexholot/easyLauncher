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
const { Mojang, buildClientArgs, javaEnv, placeNamed } = require('./mojang');
const fabric = require('./fabric');
const loaders = require('./loaders');
const { LocalServer, lanAddresses } = require('./server');
const { retryFs } = require('./http');
const { Store } = require('./store');
const { Worlds } = require('./worlds');
const { ModCache } = require('./modcache');
const { SessionTracker } = require('./sessionlog');
const { onClient, onServer, validateLock } = require('./lock');

const NAME_RE = /^[A-Za-z0-9_]{3,16}$/;
const GiB = 1024 ** 3;

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
    this.server.on('state', (s) => this.emit('event', { type: 'server', ...s, profileId: this.server.profileId, folder: this.server.folder, addresses: lanAddresses() }));
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
      addresses: lanAddresses(),
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
    const needed = active.filter((e) => onClient(e) || (server && onServer(e)));
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
    await this.cache.materialize(path.join(this.store.gameDir(pid), 'mods'), active.filter(onClient));
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
      });
      this.startClient(rt.java.javaw, args, { gameDir, profileId: profile.id, mode: req.server ? 'server' : 'play' });
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
   * req: {profileId, folder?, create?: {name, seed, gamemode, difficulty, hardcore}, auth, eula, serverRam, options, players}
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
        // Штатная проверка аккаунтов Microsoft не отключается; входят только приглашённые
        'online-mode': true,
        'white-list': true,
        'enforce-whitelist': true,
        'level-seed': c.seed || '',
        gamemode: c.gamemode || world?.gamemode || 'survival',
        difficulty: c.difficulty || 'normal',
        hardcore: !!(c.hardcore || world?.hardcore),
        'view-distance': req.options?.render || 10,
        'simulation-distance': req.options?.simulation || 6,
        'spawn-protection': 0,
      };
      // до 1.13 сервер читает режим и сложность только числами: «creative» превратился бы в выживание
      if (!rt.base.arguments) {
        props.gamemode = { survival: 0, creative: 1, adventure: 2, spectator: 3 }[props.gamemode] ?? 0;
        props.difficulty = { peaceful: 0, easy: 1, normal: 2, hard: 3 }[props.difficulty] ?? 2;
      }
      // Порт мог занять другой процесс между проверкой и стартом Java — пробуем следующий
      let port = 25565;
      for (let attempt = 0; ; attempt++) {
        try {
          await this.worlds.acquire(profile.id, folder, 'server');
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
      this.server.command('whitelist add ' + req.auth.name);
      await this.worlds.recordSession(profile.id, folder, { mode: 'host' });
      this.stage('ready', { port: this.server.port });
      return { ok: true, folder, port: this.server.port, address: '127.0.0.1:' + this.server.port };
    }, req.profileId);
  }

  /** Разрешить вход игроку (гостю по приглашению) / отозвать. */
  allowPlayer(name) {
    if (!NAME_RE.test(name)) throw new Error('Некорректное имя игрока.');
    this.server.command('whitelist add ' + name);
  }
  removePlayer(name) {
    if (!NAME_RE.test(name)) throw new Error('Некорректное имя игрока.');
    this.server.command('whitelist remove ' + name);
    this.server.command('kick ' + name + ' Приглашение отозвано');
  }

  /** Гость: сборка комнаты, подключение к локальному концу туннеля. */
  async playGuest({ profileId, address, auth, ram, options }) {
    if (this.client) throw fail('CLIENT_RUNNING', 'Minecraft уже запущен.');
    if (!auth) throw fail('AUTH_REQUIRED', 'Для подключения к другу нужен вход через Microsoft.', 'Войди в аккаунт.');
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
        username: auth.name,
        auth,
        ram: Math.max(1, Number(ram) || 4),
        server: address,
      });
      this.startClient(rt.java.javaw, args, { gameDir, profileId, mode: 'guest' });
      return { ok: true };
    }, profileId);
  }

  startClient(java, args, ctx) {
    const started = Date.now();
    this.clientLines = [];
    const tracker = new SessionTracker();
    const proc = spawn(java, args, { cwd: ctx.gameDir, env: javaEnv(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false });
    this.client = { proc, tracker, ...ctx };
    tracker.on('world', (level) => this.emit('event', { type: 'client-world', profileId: ctx.profileId, level }));
    tracker.on('singleplayer-end', (s) => this.emit('event', { type: 'world-session', profileId: ctx.profileId, ...s }));
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

  /** Сохранить мир и завершить сессию. */
  async endSession() {
    await this.server.stop();
  }

  async shutdown() {
    this.cancel();
    await this.server.stop();
  }
}

module.exports = { Launcher, applyOptions, cmpVersion, STAGES, enabled };
