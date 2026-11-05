'use strict';
// Слой сервисов главного процесса: сборки, их миры, запуск, каталог модов, игра с друзьями и помощник.
// Не зависит от Electron (кроме необязательного движка WebRTC), поэтому проверяется в Node.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { Launcher, restoreProbeLeftovers } = require('./launcher');
const loaders = require('./loaders');
const LOADER_LABEL = loaders.LABELS;
const { ModInstaller } = require('./modinstall');
const { planChanges, modState, compatible } = require('./modplan');
const { latestScreenshot } = require('./worlds');
const { PlayLog } = require('./playlog');
const http = require('./http');
const { ModrinthProvider } = require('./catalog/modrinth');
const { CurseForgeProvider } = require('./catalog/curseforge');
const lockLib = require('./lock');
const { readJson, writeJson, emptyLock } = require('./store');
const { HostSession, GuestSession, parseInvite } = require('./net/session');
const { EosHostSession, EosGuestSession } = require('./net/eos/rooms');
const { RelayHost, RelayGuest } = require('./net/relay');
const { AiManager, processRssMb } = require('./ai/manager');
const { ServerAdmin } = require('./serveradmin');
const { Assistant, smallTalk, ruleIntent } = require('./ai/assistant');
const { classify } = require('./hardware');
const { Trophies, norm: trophyNorm } = require('./trophies');
const { VoiceHub } = require('./net/voice');
const { normalizeVoice, voiceCommands, indicatorSupport } = require('./voicecfg');
const { PositionTracker } = require('./voicepos');
const { diagnose: diagnoseRules } = require('./ai/diagnose');
const builder = require('./ai/builder');
const { checkLinks, satisfies } = require('./modlinks');
const { DEFAULTS } = require('./defaults');
const { Skins } = require('./skins');
const { Memories, normalizeMemories } = require('./memories');
const { Chronicle } = require('./chronicle');
const { readWorld } = require('./worlddata');
const { offlineUuid } = require('./mojang');
const { regionCoords, FLATTENING } = require('./worldmap');
const { checkFolder } = require('./worlds');
const { PerfWatch } = require('./perf');
const { Challenges, GOALS, RULES, parseResult } = require('./challenges');
const { Worker } = require('worker_threads');
const { modGraph: buildModGraph } = require('./modgraph');
const { inspectJar } = require('./modcache');
const { toEntry } = require('./modplan');
const { readPack, extractOverrides, PACK_HOSTS, safeRel } = require('./modpack');
const { ALLOWED_HOSTS } = require('./modcache');
const { fingerprint } = require('./catalog/curseforge');
// классы проектов CurseForge: моды, ресурспаки, шейдеры
const CF_CLASS = { mods: 6, resourcepacks: 12, shaders: 6552 };

/** Выполнить fn для всех элементов, не больше n одновременно; порядок результатов — как у list. */
async function mapLimit(list, n, fn) {
  const out = new Array(list.length);
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const i = next++;
      out[i] = await fn(list[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, worker));
  return out;
}

// файлы, которые игрок сам положил в папку mods: .jar (включён) и .jar.disabled (выключен)
const FOLDER_JAR = /^(?!\.)[^<>:"|?*\\/]+\.jar(\.disabled)?$/i;

const GiB = 1024 ** 3;

/** Внешний вид лаунчера: только известные значения, остальное — по умолчанию. */
const APPEARANCE = {
  // стиль оформления: живые темы с панорамой (пещера, костёр, древний город, луг), стекло или минимализм
  style: ['lush', 'campfire', 'deepdark', 'meadow', 'glass', 'aurora', 'neon', 'sunset', 'pixel', 'minimal'],
  blur: ['normal', 'soft', 'strong'],
  theme: ['dark', 'slate', 'oled', 'light'],
  motion: ['full', 'reduced', 'off'],
  radius: ['normal', 'sharp', 'round'],
  sidebar: ['full', 'compact'],
  font: ['system', 'rounded', 'minecraft'],
  glass: ['off', 'on'],
};
function normalizeAppearance(a = {}) {
  const out = {};
  for (const [k, list] of Object.entries(APPEARANCE)) out[k] = list.includes(a?.[k]) ? a[k] : list[0];
  out.accent = /^#[0-9a-f]{6}$/i.test(a?.accent || '') ? a.accent.toLowerCase() : '#f2b25c';
  out.scale = [90, 100, 110, 125].includes(a?.scale) ? a.scale : 100;
  return out;
}
const IMG_RE = /\.(png|jpe?g|webp)$/i;
const BG_MODES = ['default', 'custom', 'profile'];

const NEWS_BASE = 'https://launchercontent.mojang.com';
const NEWS_URL = NEWS_BASE + '/v2/javaPatchNotes.json';
const NEWS_URL_V1 = NEWS_BASE + '/javaPatchNotes.json';
const stripHtml = (h) => String(h || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

/** Записи новостей → только нужные поля; неизвестный формат — пустой список, а не ошибка интерфейса. */
function parseNews(data) {
  const entries = Array.isArray(data?.entries) ? data.entries : [];
  return entries
    .filter((e) => e && typeof e.title === 'string')
    .map((e) => ({
      id: String(e.id || e.version || e.title).slice(0, 80),
      title: e.title.slice(0, 160),
      version: String(e.version || '').slice(0, 40),
      type: e.type === 'snapshot' ? 'snapshot' : 'release',
      date: typeof e.date === 'string' ? e.date : null,
      text: stripHtml(e.shortText || e.body).slice(0, 400),
      image: typeof e.image?.url === 'string' && /^\/?[\w./-]+\.(png|jpe?g|webp)$/i.test(e.image.url) && !e.image.url.includes('..') ? NEWS_BASE + '/' + e.image.url.replace(/^\//, '') : null,
      contentPath: /^[\w.-]{1,120}\.json$/.test(e.contentPath || '') ? e.contentPath : null,
      // v1: полный текст сразу в записи (HTML; интерфейс берёт из него только текст)
      body: typeof e.body === 'string' ? e.body.slice(0, 200000) : null,
    }))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))
    .slice(0, 12);
}

function plural(n, a, b, c) {
  const m10 = n % 10;
  const m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? a : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? b : c;
}

/** Шаг задания помощника для игрока — по изменению плана. */
function stepOf(c) {
  // смена версии: не всегда обновление — ради совместимости версия бывает и старше
  if (c.type === 'update' && c.from && c.to) return `${c.name}: версия ${c.from} → ${c.to}`;
  return `${c.type === 'add' ? 'Добавить' : c.type === 'update' ? 'Обновить' : 'Убрать'} ${c.name}${c.dependencyOf ? ` (нужен для ${c.dependencyOf})` : ''}`;
}

/**
 * Похоже на журнал или текст ошибки, а не на просьбу: строки времени «[12:34:56]», уровни, стек, сообщения
 * загрузчиков. Такой текст идёт в разбор ошибки — иначе в нём находятся «моды» и «сборка», и помощник
 * начинал задавать вопросы о новой сборке.
 */
const LOG_LIKE = /Exception|\w+Error\b|Caused by:|\[(?:ERROR|FATAL|WARN)\]|\/(?:ERROR|FATAL|WARN)\]|^\s*\[\d\d:\d\d:\d\d\]|^\s*at [\w.$]+\(|Mod '[^'\n]+' \([\w.-]+\)|incompatible with|which is missing|wrong version is present|Crash Report|crash-\d{4}-|Incompatible mods|exit code -?\d+|код -?\d+\)/im;

/**
 * Ответы игрока на уточняющие вопросы (приходят из окна — берём только известные поля и значения).
 * null — вопросов ещё не задавали; {} — ответил «по умолчанию».
 */
function cleanAnswers(a) {
  if (!a || typeof a !== 'object') return null;
  const out = {};
  if (['small', 'normal', 'big'].includes(a.size)) out.size = a.size;
  if (a.version === 'auto' || /^[0-9][0-9a-z.-]{0,15}$/i.test(a.version || '')) out.version = a.version;
  if (['auto', 'fabric', 'forge', 'neoforge', 'quilt'].includes(a.loader)) out.loader = a.loader;
  if (['few', 'more'].includes(a.amount)) out.amount = a.amount;
  if (['new', 'current'].includes(a.where)) out.where = a.where;
  if (['surprise', 'night_horror', 'base_defense', 'scarcity', 'outbreak', 'ruined_world', 'mutants', 'tactical', 'coop'].includes(a.style)) out.style = a.style;
  for (const k of ['perf', 'qol', 'visuals', 'setup']) if (typeof a[k] === 'boolean') out[k] = a[k];
  return out;
}

/** Уточняющие вопросы перед добавлением модов по теме в текущую сборку. */
function addQuestions(intent) {
  const yes = (v) => [
    { value: true, label: 'Да', selected: v },
    { value: false, label: 'Нет', selected: !v },
  ];
  return [
    { id: 'amount', title: 'Сколько модов добавить', hint: '', options: [{ value: 'few', label: 'Немного (до 8)', selected: !intent.big }, { value: 'more', label: 'Побольше (до 20)', selected: !!intent.big }] },
    { id: 'perf', title: 'Заодно поставить моды оптимизации', hint: 'Больше FPS, игра не меняется', options: yes(!!intent.lowEnd) },
    { id: 'setup', title: 'Поднять память игре, если модов станет много', hint: '', options: yes(true) },
  ];
}

/** Мод, который проверка убрала из подборки: «JEI (заменён на EMI)». */
function droppedText(d) {
  return d.replacedBy ? `${d.name} (заменён на ${d.replacedBy})` : d.name;
}

/** Раздел подборки по причине выбора мода: «Ты просил», «Оптимизация», «Зомби»… */
function groupTitle(reason) {
  const [kind, theme] = String(reason).split(':');
  if (kind === 'term') return 'Ты просил';
  if (kind === 'ai') return 'Посоветовала нейросеть';
  if (kind === 'base') return theme === 'qol' ? 'Удобства' : 'Оптимизация';
  if (kind === 'role') return builder.ROLE_RU[theme] || 'Игровая роль';
  return builder.THEME_RU[theme] || 'Другое';
}

/** Адрес из журнала игры («127.0.0.1:25565») — свой сервер сессии на этом ПК с портом port. */
function ownServer(addr, port) {
  const m = /^(127\.0\.0\.1|localhost|\[?::1\]?):(\d{1,5})$/i.exec(String(addr || ''));
  return !!m && Number(m[2]) === Number(port);
}

function inside(dir, file) {
  const rel = path.relative(path.resolve(dir), path.resolve(file));
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

class Services extends EventEmitter {
  /**
   * opts: { launcher?, ai?, rtc?: {engine, RtcHost, RtcGuest}, backend?, catalogBase? }
   */
  constructor(root, opts = {}) {
    super();
    this.root = root;
    this.settingsFile = path.join(root, 'settings.json');
    this.settingsWrite = Promise.resolve();
    this.launcher = opts.launcher || new Launcher(root);
    this.store = this.launcher.store;
    this.worlds = this.launcher.worlds;
    this.installer = new ModInstaller(this.store, this.launcher.cache, { isBusy: (pid) => this.launcher.profileBusy(pid) });
    this.ai = opts.ai || new AiManager(root);
    this.rtc = opts.rtc || null;
    // Epic Online Services: фабрика платформы (null — EOS в этой сборке нет; тогда сервер комнат или LAN)
    this.eosFactory = opts.eos || null;
    this.eosPlatform = null;
    this.admin = new ServerAdmin(this.launcher, { rss: processRssMb });
    this.restarting = false;
    this.opts = opts;
    this.plans = new Map(); // planId → {pid, plan}
    this.tasks = new Map(); // taskId → задание помощника, которое игрок подтверждает одной кнопкой
    this.modsAbort = null;
    this.host = null; // HostSession
    this.guest = null; // {session, profileId, manifest, room}
    this.playlog = new PlayLog(this.store);
    this.playingLevels = new Map(); // pid → миры, в которые заходили за этот запуск
    this.coopLog = null; // {pid, folder, players, started} — пока идёт сессия с друзьями
    this.updatesCache = new Map(); // pid → {key, at, result}
    this.sizeCache = new Map(); // pid → {at, bytes}
    this.skins = new Skins(root);
    this.chronicle = new Chronicle(this.store, this.worlds);
    // в мире сервера сессии у каждого игрока свой файл — летопись и карта берут свой, а не друга
    this.knownUuids = new Set();
    this.chronicle.uuids = () => this.myUuids();
    this.perf = new PerfWatch({ rss: processRssMb });
    this.challenges = new Challenges(root);
    this.trophyBook = new Trophies(root);
    this.worldSession = null; // {pid, folder, startedAt, startDay, moments} — сессия в мире для летописи
    // «Камера воспоминаний»: ролики из игры для живого фона (включает только сам игрок)
    this.memories = opts.memories || new Memories(root, { settings: async () => (await this.settings()).memories, bundled: opts.ffmpegDir || null });
    this.memories.on('state', (st) => this.emit('memories', st));
    // лаунчер закрыли посреди пробного запуска — свои моды игрока, убранные на время, возвращаются на место
    this.store
      .listProfiles()
      .then((list) => Promise.all(list.map((p) => restoreProbeLeftovers(path.join(this.store.gameDir(p.id), 'mods')))))
      .catch(() => {});
    this.launcher.on('event', (ev) => {
      this.emit('event', ev);
      this.trackPlay(ev);
      if (ev.type === 'client') this.watchGame(ev).catch(() => {});
      if (ev.type === 'client') this.chronicleClient(ev).catch(() => {});
      if (ev.type === 'client-world') this.chronicleBegin(ev.profileId, ev.level).catch(() => {});
      if (ev.type === 'moment') this.onMoment(ev).catch(() => {});
      if (ev.type === 'log' && ev.source === 'client') this.perf.feed(ev.line);
      if (ev.type === 'client') this.perfClient(ev).catch(() => {});
      // сервер остановлен — комната закрывается, приглашения перестают работать
      // перезапуск из админ-панели — приглашения и подключённые друзья остаются
      if (ev.type === 'server' && ev.state === 'stopped' && this.host && !this.restarting) this.stopRoom().catch(() => {});
      if (ev.type === 'world-session') this.onWorldSession(ev).catch(() => {});
      if (ev.type === 'client-server') this.onClientServer(ev).catch(() => {});
      if (ev.type === 'server-session') this.onServerSession(ev).catch(() => {});
      if (ev.type === 'server' && ev.port) this.lastServerPort = ev.port;
    });
  }

  /** Журнал сессий: запуск игры (время и миры) и сессия с друзьями (мир и кто заходил). */
  trackPlay(ev) {
    if (ev.type === 'client' && ev.profileId) {
      if (ev.state === 'running') this.playingLevels.set(ev.profileId, new Set());
      if (ev.state === 'stopped') {
        const worlds = [...(this.playingLevels.get(ev.profileId) || [])];
        this.playingLevels.delete(ev.profileId);
        // запуск, который не дошёл до игры (упал на старте), в часы не считается
        if ((ev.seconds || 0) >= 5) this.playlog.add(ev.profileId, { mode: ev.mode === 'guest' ? 'guest' : 'play', seconds: ev.seconds, worlds });
      }
    }
    if (ev.type === 'client-world' && ev.level) this.playingLevels.get(ev.profileId)?.add(ev.level);
    if (ev.type === 'server' && ev.profileId) {
      if (ev.state !== 'stopped') {
        if (!this.coopLog) this.coopLog = { pid: ev.profileId, folder: ev.folder, players: new Set(), started: Date.now() };
        for (const n of ev.players || []) this.coopLog.players.add(n);
      } else if (this.coopLog) {
        const c = this.coopLog;
        this.coopLog = null;
        const host = this.coopHostName;
        this.worlds
          .get(c.pid, c.folder)
          .catch(() => null)
          .then((w) => this.playlog.add(c.pid, { mode: 'friends', seconds: (Date.now() - c.started) / 1000, worlds: w ? [w.name] : [], players: [...c.players].filter((n) => n !== host) }));
      }
    }
  }

  /** Камера следит за окном только запущенной из лаунчера игры: pid процесса Java и где сейчас игрок. */
  async watchGame(ev) {
    const c = this.launcher.client;
    if (ev.state !== 'running' || !c?.proc?.pid) return this.memories.gameStopped();
    const p = await this.store.getProfile(ev.profileId).catch(() => null);
    this.memories.gameStarted({
      pid: c.proc.pid,
      profileId: ev.profileId,
      profileName: p?.name || '',
      // null — главное меню: там не пишем
      level: () => {
        const cur = this.launcher.client?.tracker.current;
        if (!cur) return null;
        if (cur.type === 'singleplayer') return cur.level || 'Одиночный мир';
        return this.launcher.client.mode === 'guest' ? 'В гостях у друга' : 'Сервер';
      },
    });
  }

  /** Перенос прежней схемы и восстановление прерванных установок — один раз при запуске. */
  async init() {
    const moved = await this.worlds.migrateLegacy().catch(() => []);
    for (const p of await this.store.listProfiles()) await this.installer.recover(p.id).catch(() => {});
    return { migrated: moved.length };
  }

  // ---------- настройки ----------
  async settings() {
    const s = (await readJson(this.settingsFile)) || {};
    return {
      // пустая строка в настройках = «как в сборке»
      backend: s.backend || this.opts.backend || DEFAULTS.backend,
      // Прокси каталога CurseForge (например, Cloudflare Worker). Пусто — каталог идёт через сервер комнат.
      cfProxy: s.cfProxy || DEFAULTS.cfProxy,
      // что задано разработчиком при сборке — игроку эти поля не показываются
      builtIn: { backend: !!DEFAULTS.backend, cfProxy: !!DEFAULTS.cfProxy, msClientId: !!DEFAULTS.msClientId },
      // чем работают приглашения через интернет: 'eos' (Epic, без своего сервера), 'server' (сервер комнат) или нет
      invites: this.eosFactory ? 'eos' : s.backend || this.opts.backend || DEFAULTS.backend ? 'server' : null,
      ram: s.ram || null,
      serverRam: s.serverRam || null,
      eula: s.eula === true,
      motion: s.motion !== false,
      appearance: normalizeAppearance(s.appearance),
      lastProfile: s.lastProfile || null,
      nickname: s.nickname || 'Player',
      // игрок сам выбрал игру без входа в Microsoft — больше не спрашиваем при каждом запуске
      offlineOk: s.offlineOk === true,
      options: s.options || null,
      // фон главного экрана: стандартный / своя картинка / скриншот выбранной сборки
      background: BG_MODES.includes(s.background?.mode) ? s.background : { mode: 'default' },
      // затемнение фона больше не настраивается (ползунок убран) — постоянное значение для читаемости
      dim: 0.55,
      // окно игры: размер или полный экран; null — как решит сама игра
      window: s.window || null,
      // свои аргументы Java и своя Java (для опытных игроков); пусто — лаунчер подбирает сам
      jvmArgs: s.jvmArgs || '',
      javaPath: s.javaPath || '',
      // что делать с лаунчером, когда игра запущена: оставить, свернуть или спрятать до закрытия игры
      afterLaunch: ['keep', 'minimize', 'hide'].includes(s.afterLaunch) ? s.afterLaunch : 'keep',
      showNews: s.showNews !== false,
      checkUpdates: s.checkUpdates !== false,
      verifyUpdates: s.verifyUpdates !== false,
      // камера воспоминаний: запись роликов из игры (выключена, пока игрок сам не включит) и показ их фоном
      memories: normalizeMemories(s.memories),
      // голосовой чат: режим, кнопка, порог, устройства, громкость каждого друга, значок в игре
      voice: normalizeVoice(s.voice),
    };
  }
  saveSettings(patch) {
    const current = this.settingsWrite.catch(() => {}).then(() => this.saveSettingsNow(patch));
    this.settingsWrite = current;
    return current;
  }

  async saveSettingsNow(patch) {
    const cur = (await readJson(this.settingsFile)) || {};
    // только известные поля: настройки не превращаются в склад произвольных данных из интерфейса
    const KNOWN = ['backend', 'cfProxy', 'ram', 'serverRam', 'eula', 'motion', 'lastProfile', 'nickname', 'options', 'offlineOk', 'dim', 'appearance', 'background', 'window', 'jvmArgs', 'javaPath', 'afterLaunch', 'showNews', 'checkUpdates', 'verifyUpdates', 'memories', 'voice'];
    for (const k of Object.keys(patch)) if (!KNOWN.includes(k)) throw new Error('Неизвестная настройка: ' + k);
    const next = { ...cur, ...patch };
    if (patch.eula !== undefined) next.eula = patch.eula === true;
    if (patch.offlineOk !== undefined) next.offlineOk = patch.offlineOk === true;
    if (patch.dim !== undefined) next.dim = Math.max(0.2, Math.min(0.9, Number(patch.dim) || 0.55));
    if (patch.lastProfile !== undefined && patch.lastProfile !== null) await this.store.getProfile(patch.lastProfile);
    if (patch.options !== undefined && patch.options !== null) {
      // числа идут в options.txt игры — только целые в разумных пределах
      const o = patch.options;
      const int = (v, lo, hi) => (Number.isInteger(v) && v >= lo && v <= hi ? v : undefined);
      next.options = { render: int(o.render, 2, 32), simulation: int(o.simulation, 2, 32), fps: int(o.fps, 10, 260), graphics: int(o.graphics, 0, 2) };
    }
    if (patch.background !== undefined) {
      const b = patch.background || {};
      if (!BG_MODES.includes(b.mode)) throw new Error('Неизвестный вид фона.');
      // файл картинки — только из папки лаунчера (его туда копирует setBackground)
      const file = b.file && inside(this.root, b.file) ? b.file : b.mode === 'custom' ? cur.background?.file : undefined;
      next.background = file ? { mode: b.mode, file } : { mode: b.mode };
    }
    for (const field of ['backend', 'cfProxy']) {
      if (patch[field] === undefined) continue;
      const b = String(patch[field]).trim().replace(/\/$/, '');
      if (b && !/^https:\/\/[\w.-]+(:\d+)?$/.test(b) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(b))
        throw new Error('Адрес должен начинаться с https:// (без пути в конце)');
      next[field] = b;
    }
    for (const f of ['ram', 'serverRam']) {
      if (patch[f] === undefined || patch[f] === null) continue;
      const n = Number(patch[f]);
      const max = Math.max(1, Math.round(this.launcher.totalMem / GiB) - 2);
      if (!Number.isInteger(n) || n < 1 || n > max) throw new Error(`Память: целое число от 1 до ${max} ГБ.`);
      next[f] = n;
    }
    if (patch.window !== undefined) {
      const w = patch.window;
      const int = (v, lo, hi) => (Number.isInteger(v) && v >= lo && v <= hi ? v : null);
      next.window = w ? { width: int(w.width, 640, 7680), height: int(w.height, 480, 4320), fullscreen: w.fullscreen === true } : null;
      // своё окно без размера игра получила бы как «--width null» — лучше сразу сказать, что не так
      if (next.window && !next.window.fullscreen && (!next.window.width || !next.window.height)) throw new Error('Размер окна: ширина от 640 до 7680, высота от 480 до 4320 точек.');
    }
    if (patch.jvmArgs !== undefined) {
      const a = String(patch.jvmArgs || '').trim();
      // только флаги JVM: без переводов строк, команд и путей к другим программам; память задаётся отдельно
      if (a.length > 600 || /[\r\n`$;&|<>]/.test(a)) throw new Error('Аргументы Java: одна строка до 600 символов, без спецсимволов.');
      if (a && a.split(/\s+/).some((x) => !/^-/.test(x))) throw new Error('Аргументы Java начинаются с «-», например -XX:+UseZGC.');
      if (/(^|\s)-Xm[xs]/.test(a)) throw new Error('Память задаётся полем «Память для игры», а не аргументами -Xmx/-Xms.');
      next.jvmArgs = a;
    }
    if (patch.javaPath !== undefined) {
      const j = String(patch.javaPath || '').trim();
      if (j && (!/(^|[\\/])javaw?(\.exe)?$/i.test(j) || !fs.existsSync(j))) throw new Error('Укажи файл java.exe (или javaw.exe) из папки bin установленной Java.');
      next.javaPath = j;
    }
    if (patch.afterLaunch !== undefined && !['keep', 'minimize', 'hide'].includes(patch.afterLaunch)) throw new Error('Неизвестное поведение лаунчера.');
    for (const k of ['showNews', 'checkUpdates', 'verifyUpdates']) if (patch[k] !== undefined) next[k] = patch[k] !== false;
    if (patch.appearance !== undefined) next.appearance = normalizeAppearance({ ...normalizeAppearance(cur.appearance), ...patch.appearance });
    if (patch.memories !== undefined) next.memories = normalizeMemories({ ...normalizeMemories(cur.memories), ...patch.memories });
    if (patch.voice !== undefined) next.voice = normalizeVoice({ ...normalizeVoice(cur.voice), ...patch.voice });
    if (patch.nickname !== undefined && !/^[A-Za-z0-9_]{3,16}$/.test(patch.nickname)) throw new Error('Никнейм: 3–16 символов, латиница, цифры и _.');
    await writeJson(this.settingsFile, next);
    return this.settings();
  }

  /** Своя картинка фона копируется в папку лаунчера: исходный файл можно удалить. */
  async setBackground(mode, srcFile) {
    if (!BG_MODES.includes(mode)) throw new Error('Неизвестный вид фона.');
    if (mode !== 'custom') return this.saveSettings({ background: { mode } });
    if (!IMG_RE.test(srcFile || '')) throw new Error('Фон — изображение PNG, JPG или WEBP.');
    if ((await fsp.stat(srcFile)).size > 20 * 1024 * 1024) throw new Error('Изображение больше 20 МБ.');
    const dir = path.join(this.root, 'backgrounds');
    await fsp.rm(dir, { recursive: true, force: true });
    await fsp.mkdir(dir, { recursive: true });
    const file = path.join(dir, 'custom' + path.extname(srcFile).toLowerCase());
    await fsp.copyFile(srcFile, file);
    return this.saveSettings({ background: { mode, file } });
  }

  /** Что показать фоном для сборки. Честная подпись: скриншот сборки, а не «мира», если связь с миром не подтверждена. */
  async backgroundFor(pid) {
    const s = await this.settings();
    if (s.background.mode === 'custom' && s.background.file && fs.existsSync(s.background.file)) return { kind: 'custom', file: s.background.file, label: 'Своё изображение' };
    if (s.background.mode === 'profile' && pid) {
      const p = await this.store.getProfile(pid).catch(() => null);
      if (p?.cover && fs.existsSync(p.cover)) return { kind: 'profile-cover', file: p.cover, label: 'Обложка сборки' };
      const shot = p && (await latestScreenshot(this.store, pid));
      if (shot) return { kind: 'profile-shot', file: shot, label: 'Последний скриншот сборки' };
    }
    return { kind: 'default', file: null, label: 'Стандартный фон' };
  }

  /** Путь к картинке разрешён для показа в интерфейсе: только внутри папки лаунчера и только изображения. */
  imageAllowed(file) {
    return this.imagePathAllowed(file) && fs.existsSync(file);
  }
  /** Путь картинки внутри папки лаунчера (файла может уже не быть — например, заменённая обложка). */
  imagePathAllowed(file) {
    return IMG_RE.test(file) && inside(this.root, file);
  }
  /** Видео для живого фона: только ролики камеры воспоминаний. */
  mediaAllowed(file) {
    return /\.mp4$/i.test(file || '') && inside(this.memories.dir, file) && fs.existsSync(file);
  }

  /** Бюджет памяти по объёму ОЗУ: игра, сервер (для хозяина) и резерв для системы. */
  memoryBudget(mode, settings = {}, profile = null) {
    const total = Math.round(this.launcher.totalMem / GiB);
    const reserve = Math.max(2, Math.round(total * 0.2));
    const client = profile?.ram || settings.ram || (total <= 4 ? 2 : total <= 8 ? 3 : total <= 16 ? 4 : 6);
    const server = mode === 'host' ? settings.serverRam || (total <= 8 ? 1 : total <= 16 ? 3 : 4) : 0;
    return { total, reserve, client, server, fits: client + server + reserve <= total };
  }

  providers() {
    return this.settings().then((s) => ({
      modrinth: this._mr || (this._mr = new ModrinthProvider(this.opts.catalogBase ? { base: this.opts.catalogBase.modrinth } : {})),
      curseforge: new CurseForgeProvider({ backend: this.opts.catalogBase?.curseforgeBackend || s.cfProxy || s.backend }),
    }));
  }

  // ---------- сборки ----------
  async cardFor(p) {
    const lock = await this.store.getLock(p.id);
    // обложка вне папки лаунчера (перенесли папку, восстановили из копии) окну всё равно не отдаётся — не показываем её
    const cover = p.cover && this.imageAllowed(p.cover) ? p.cover : null;
    // моды, которые игрок положил в папку сам, тоже часть сборки — в счётчике их видно
    const folder = p.kind === 'room' || p.loader === 'vanilla' ? [] : await this.folderFiles(p.id);
    return {
      ...p,
      mods: lock.mods.length + folder.length,
      modsFolder: folder.length,
      modsOff: lock.mods.filter((m) => m.enabled === false).length + folder.filter((n) => /\.disabled$/i.test(n)).length,
      cover,
      // обложка карточки: закреплённая игроком, иначе последний скриншот этой сборки
      shot: cover ? null : await latestScreenshot(this.store, p.id),
      busy: this.launcher.profileBusy(p.id),
    };
  }

  async overview() {
    const [list, settings] = await Promise.all([this.store.listProfiles(), this.settings()]);
    const profiles = [];
    for (const p of list) profiles.push(await this.cardFor(p));
    const personal = profiles.filter((p) => p.kind !== 'room');
    let selected = settings.lastProfile && personal.find((p) => p.id === settings.lastProfile) ? settings.lastProfile : personal[0]?.id || null;
    return {
      profiles,
      selected,
      settings,
      background: await this.backgroundFor(selected),
      status: this.launcher.status(),
      room: this.host?.state('online') || null,
    };
  }

  /** Первая сборка создаётся сама: Vanilla последнего релиза. Игроку не нужно ничего настраивать. */
  async ensureFirstProfile(minecraft) {
    if ((await this.store.listProfiles()).some((p) => p.kind !== 'room')) return null;
    let mc = minecraft;
    if (!mc) {
      try {
        mc = (await this.launcher.versions()).find((v) => v.type === 'release')?.id;
      } catch {}
    }
    const p = await this.store.createProfile({ name: 'Minecraft', minecraft: mc || '1.21.1', loader: 'vanilla' });
    await this.saveSettings({ lastProfile: p.id });
    return p;
  }

  async selectProfile(pid) {
    const p = await this.store.getProfile(pid);
    if (p.kind === 'room') throw new Error('Сборка друга запускается только по его приглашению в разделе «С друзьями».');
    await this.saveSettings({ lastProfile: pid });
    return this.backgroundFor(pid);
  }

  async createProfile({ name, minecraft, loader = 'vanilla', loaderVersion = null }) {
    if (loaderVersion !== null && !/^[\w.+-]{1,60}$/.test(String(loaderVersion))) throw new Error('Некорректная версия загрузчика.');
    const p = await this.store.createProfile({ name, minecraft, loader, loaderVersion });
    await this.saveSettings({ lastProfile: p.id });
    return p;
  }

  async profileDetails(pid) {
    const profile = await this.store.getProfile(pid);
    const lock = await this.store.getLock(pid);
    const settings = await this.settings();
    let history = [];
    try {
      history = (await fsp.readdir(this.installer.historyDir(pid))).filter((f) => f.endsWith('.lock.json'));
    } catch {}
    return {
      profile: await this.cardFor(profile),
      lock,
      worlds: await this.worlds.list(pid),
      canRollback: history.length > 0,
      budget: this.memoryBudget('play', settings, profile),
      busy: this.launcher.profileBusy(pid),
    };
  }

  /** Настройки сборки (рядом с самой сборкой): название, память. */
  async updateProfile(pid, patch) {
    const allowed = {};
    if (patch.name !== undefined) allowed.name = patch.name;
    if (patch.ram !== undefined) {
      const r = patch.ram === null ? null : Math.round(Number(patch.ram));
      if (r !== null && !(r >= 1 && r <= 64)) throw new Error('Память: от 1 до 64 ГБ.');
      allowed.ram = r;
    }
    // свой скин сборки: id образа из гардероба или null — «как в гардеробе»
    if (patch.skinId !== undefined) {
      if (patch.skinId !== null && !(await this.skins.list()).items.some((x) => x.id === patch.skinId)) throw new Error('Такого образа нет в гардеробе.');
      allowed.skinId = patch.skinId;
    }
    return this.store.updateProfile(pid, allowed);
  }

  /** Обложка сборки: своя картинка или скриншот из этой сборки. Закрепляется — сама не меняется. */
  async setProfileCover(pid, src) {
    if (src === null) {
      const p = await this.store.getProfile(pid);
      if (p.cover && inside(this.store.profileDir(pid), p.cover)) await fsp.rm(p.cover, { force: true });
      return this.store.updateProfile(pid, { cover: null });
    }
    if (!IMG_RE.test(src)) throw new Error('Обложка — изображение PNG, JPG или WEBP.');
    if ((await fsp.stat(src)).size > 20 * 1024 * 1024) throw new Error('Изображение больше 20 МБ.');
    const p = await this.store.getProfile(pid);
    const dir = path.join(this.store.profileDir(pid), 'covers');
    await fsp.mkdir(dir, { recursive: true });
    const dest = path.join(dir, `profile-${Date.now()}${path.extname(src).toLowerCase()}`);
    await fsp.copyFile(src, dest);
    if (p.cover && inside(dir, p.cover)) await fsp.rm(p.cover, { force: true });
    return this.store.updateProfile(pid, { cover: dest });
  }

  /** Удаление сборки: сначала копии всех её миров (в backups/, вне сборки), затем папка. */
  async deleteProfile(pid, confirmName) {
    const p = await this.store.getProfile(pid);
    if (String(confirmName).trim() !== p.name) throw new Error('Для удаления введи точное название сборки.');
    if (this.launcher.profileBusy(pid)) throw new Error('Сначала закрой игру и заверши сессию с друзьями.');
    const saved = [];
    for (const w of await this.worlds.list(pid)) {
      await this.worlds.backup(pid, w.folder, { reason: 'before-delete', reasonText: 'Перед удалением сборки' });
      saved.push(w.name);
    }
    await this.store.deleteProfile(pid);
    const s = await this.settings();
    if (s.lastProfile === pid) await this.saveSettings({ lastProfile: null });
    return { backedUp: saved };
  }

  /** Версии загрузчика для версии Minecraft (для выбора при создании сборки). */
  async loaderVersions(loader, mc) {
    const list = await loaders.loaderVersions(loader, mc);
    return { list: list.slice(0, 80), recommended: loaders.pickLoaderVersion(list) };
  }

  /**
   * Картинки модов сборки: из каталогов одним запросом на источник, кэш на неделю в profiles/<pid>/mod-icons.json.
   * Только адреса CDN каталогов (они же разрешены в CSP окна). Нет сети — что есть в кэше.
   */
  async modIcons(pid) {
    const lock = await this.store.getLock(pid);
    const file = path.join(this.store.profileDir(pid), 'mod-icons.json');
    const cache = (await readJson(file)) || {};
    const WEEK = 7 * 24 * 3600 * 1000;
    const need = lock.mods.filter((m) => m.projectId && ['modrinth', 'curseforge'].includes(m.source) && !(cache[m.key] && Date.now() - cache[m.key].at < WEEK));
    if (need.length) {
      const p = await this.providers();
      for (const source of ['modrinth', 'curseforge']) {
        const ids = need.filter((m) => m.source === source).map((m) => String(m.projectId));
        if (!ids.length) continue;
        let found = [];
        try {
          found = await p[source].projects(ids);
        } catch {
          continue; // нет сети или CurseForge не настроен — попробуем в следующий раз
        }
        const byId = new Map(found.map((x) => [String(x.id), x.iconUrl]));
        for (const m of need.filter((x) => x.source === source)) cache[m.key] = { url: byId.get(String(m.projectId)) || null, at: Date.now() };
      }
      await writeJson(file, cache);
    }
    const ok = (u) => (/^https:\/\/(cdn\.modrinth\.com|media\.forgecdn\.net)\//.test(u || '') ? u : null);
    return Object.fromEntries(lock.mods.map((m) => [m.key, ok(cache[m.key]?.url)]));
  }

  /**
   * Схема зависимостей мода сборки. Названия и картинки неустановленных зависимостей — из каталогов
   * одним запросом, кэш на неделю в profiles/<pid>/mod-deps.json; нет сети — блок без названия.
   */
  async modGraph(pid, key) {
    if (typeof key !== 'string' || !/^(modrinth|curseforge|local):[A-Za-z0-9_-]+$/.test(key)) throw Object.assign(new Error('Некорректный мод.'), { code: 'BAD_INPUT' });
    const lock = await this.store.getLock(pid);
    const g = buildModGraph(lock, key);
    const icons = await this.modIcons(pid).catch(() => ({}));
    const file = path.join(this.store.profileDir(pid), 'mod-deps.json');
    const cache = (await readJson(file)) || {};
    const WEEK = 7 * 24 * 3600 * 1000;
    const need = g.nodes.filter((n) => !n.installed && n.projectId && ['modrinth', 'curseforge'].includes(n.source) && !(cache[n.key] && Date.now() - cache[n.key].at < WEEK));
    if (need.length) {
      const p = await this.providers();
      for (const source of ['modrinth', 'curseforge']) {
        const ids = need.filter((n) => n.source === source).map((n) => String(n.projectId));
        if (!ids.length) continue;
        let found;
        try {
          found = await p[source].projects(ids);
        } catch {
          continue; // нет сети или CurseForge не настроен — названия будут в следующий раз
        }
        const byId = new Map(found.map((x) => [String(x.id), x]));
        for (const n of need.filter((x) => x.source === source)) {
          const x = byId.get(String(n.projectId));
          cache[n.key] = { name: x?.name || null, url: x?.iconUrl || null, at: Date.now() };
        }
      }
      await writeJson(file, cache);
    }
    const ok = (u) => (/^https:\/\/(cdn\.modrinth\.com|media\.forgecdn\.net)\//.test(u || '') ? u : null);
    for (const n of g.nodes) {
      if (n.installed) n.iconUrl = icons[n.key] || null;
      else {
        n.name = cache[n.key]?.name || null;
        n.iconUrl = ok(cache[n.key]?.url);
      }
    }
    return { ...g, loader: lock.loader, minecraft: lock.minecraft };
  }

  // ---------- моды, положенные в папку mods вручную ----------
  /** Имена файлов в папке mods, которые ставил не лаунчер (без хешей — для быстрого счётчика на карточке). */
  async folderFiles(pid) {
    const dir = path.join(this.store.gameDir(pid), 'mods');
    let names = [];
    try {
      names = await fsp.readdir(dir);
    } catch {
      return [];
    }
    let managed = [];
    try {
      managed = JSON.parse(await fsp.readFile(path.join(dir, '.easylauncher-managed.json'), 'utf8')).files || [];
    } catch {}
    const own = new Set(managed.map((n) => n.toLowerCase()));
    return names.filter((n) => FOLDER_JAR.test(n) && !own.has(n.toLowerCase()));
  }

  /**
   * Свести папку mods со сборкой. Мод, который игрок положил сам и который узнаёт Modrinth (по SHA-1 файла),
   * становится обычным модом сборки: файл переезжает в кэш, дальше им управляет лаунчер (обновления,
   * зависимости, схема). Неузнанные файлы остаются в папке как есть и показываются отдельным списком.
   * Во время игры сборку не меняем — только показываем.
   */
  async syncFolder(pid) {
    const profile = await this.store.getProfile(pid);
    if (profile.kind === 'room' || profile.loader === 'vanilla') return { adopted: [], replaced: [], local: [] };
    const dir = path.join(this.store.gameDir(pid), 'mods');
    const names = await this.folderFiles(pid);
    // хеш и описание файла считаем один раз: кэш по имени, размеру и времени изменения
    const infoFile = path.join(this.store.profileDir(pid), 'folder-mods.json');
    const known = (await readJson(infoFile)) || {};
    const files = [];
    for (const name of names) {
      const full = path.join(dir, name);
      let st;
      try {
        st = await fsp.stat(full);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      let k = known[name];
      // v — версия разбора JAR: после улучшений (например, mcmod.info старых Forge) описание пересчитывается
      if (!k || k.v !== 2 || k.size !== st.size || k.mtime !== st.mtimeMs) {
        let meta = { ok: false, loaders: [] };
        try {
          meta = inspectJar(full);
        } catch {}
        k = { v: 2, size: st.size, mtime: st.mtimeMs, sha1: await http.hashFile(full, 'sha1'), name: meta.name || null, version: meta.version || null, modId: meta.modId || null, loaders: meta.loaders || [], jar: meta.ok !== false, checked: 0 };
      }
      files.push({ file: name, enabled: !/\.disabled$/i.test(name), ...k });
    }
    const adopted = [];
    const replaced = [];
    // во время игры и пока ставятся моды (план меняет тот же состав) — только показываем
    const busy = this.launcher.profileBusy(pid) || !!this.modsAbort;
    const lock = await this.store.getLock(pid);
    // узнаём на Modrinth только включённые файлы; неузнанный файл спрашиваем снова не чаще раза в сутки
    const ask = busy ? [] : files.filter((f) => f.enabled && f.jar && Date.now() - (f.checked || 0) > 24 * 3600 * 1000);
    /** Взять файл из папки в сборку по найденному в каталоге релизу (provider: modrinth/curseforge). */
    const adopt = async (f, provider, projectId, versionId) => {
      try {
        const [project, v] = await Promise.all([provider.project(projectId), provider.version(projectId, versionId)]);
        // файл для другого загрузчика или версии игры в сборку не берём: он остаётся в папке с предупреждением
        if (!compatible(v, lock)) {
          f.otherTarget = true;
          return;
        }
        const own = v.files.find((x) => String(x.hashes.sha1 || '').toLowerCase() === f.sha1) || v.files[0];
        const entry = toEntry(project, { ...v, files: [{ ...own, primary: true }] }, { addedBy: 'user' });
        await this.launcher.cache.importFile(path.join(dir, f.file), entry);
        const i = lock.mods.findIndex((m) => m.key === entry.key);
        if (i >= 0) {
          // другая версия мода, который уже есть в сборке: файл из папки — то, что игрок хочет
          replaced.push({ key: entry.key, name: entry.name, from: lock.mods[i].version, to: entry.version, oldFile: lock.mods[i].file.filename });
          // игрок сам положил файл — значит, мод нужен включённым, даже если в сборке он был выключен
          lock.mods[i] = { ...entry, pinned: lock.mods[i].pinned, addedBy: lock.mods[i].addedBy };
        } else {
          lock.mods.push(entry);
          adopted.push({ key: entry.key, name: entry.name, version: entry.version });
        }
        f.adopted = true;
      } catch {} // не вышло взять под управление — файл остаётся в папке и в списке «из папки»
    };
    if (ask.length) {
      const prov = await this.providers();
      // 1) Modrinth — по SHA-1
      let found = null;
      try {
        found = await prov.modrinth.byHashes(ask.map((f) => f.sha1));
      } catch {} // нет сети — попробуем в следующий раз, файлы пока просто показываем
      for (const f of ask) {
        const hit = found?.[f.sha1];
        if (hit) await adopt(f, prov.modrinth, hit.projectId, hit.versionId);
      }
      // 2) CurseForge — по отпечатку файла (его моды часто есть только там)
      const rest = found ? ask.filter((f) => !f.adopted && !f.otherTarget) : [];
      let cfFound = null;
      if (rest.length && prov.curseforge.status().available) {
        for (const f of rest) {
          if (!Number.isInteger(f.fp)) {
            try {
              f.fp = fingerprint(await fsp.readFile(path.join(dir, f.file)));
            } catch {}
          }
        }
        try {
          cfFound = await prov.curseforge.byFingerprints(rest.map((f) => f.fp));
        } catch {}
        for (const f of rest) {
          const hit = cfFound?.[f.fp];
          if (hit) await adopt(f, prov.curseforge, hit.projectId, hit.fileId);
        }
      }
      // ответ получен (и «не знаем такой файл» тоже) — следующий вопрос о нём не раньше чем через сутки
      for (const f of ask) if (found && !f.adopted) f.checked = Date.now();
    }
    if (adopted.length || replaced.length) {
      lock.updatedAt = new Date().toISOString();
      await this.store.saveLock(pid, lock);
      // файл в папке заменяет копия из кэша под управлением лаунчера (иначе мод оказался бы в папке дважды)
      for (const f of files.filter((x) => x.adopted)) await http.retryFs(() => fsp.rm(path.join(dir, f.file), { force: true }), f.file);
      try {
        await this.launcher.cache.materialize(dir, lock.mods.filter((m) => m.enabled !== false && lockLib.inGame(m)));
      } catch {
        // каких-то других файлов сборки нет в кэше (докачаются при запуске) — взятые моды кладём сами, чтобы они не пропали из папки
        await this.placeAdopted(dir, lock, [...adopted, ...replaced].map((x) => x.key), replaced.map((x) => x.oldFile));
      }
    }
    const keep = {};
    for (const f of files.filter((x) => !x.adopted)) keep[f.file] = { v: 2, size: f.size, mtime: f.mtime, sha1: f.sha1, name: f.name, version: f.version, modId: f.modId, loaders: f.loaders, jar: f.jar, checked: f.checked || 0, otherTarget: !!f.otherTarget, fp: Number.isInteger(f.fp) ? f.fp : undefined };
    await writeJson(infoFile, keep);
    const local = files
      .filter((f) => !f.adopted)
      .map((f) => ({
        file: f.file,
        name: f.name || f.file.replace(/\.jar(\.disabled)?$/i, ''),
        version: f.version || '',
        enabled: f.enabled,
        size: f.size,
        // мод другого загрузчика игра не загрузит — предупреждаем
        // (как при установке: Quilt запускает моды Fabric, ранний NeoForge — моды Forge)
        wrongLoader: f.jar && f.loaders.length > 0 && !f.loaders.includes(profile.loader) && !(profile.loader === 'quilt' && f.loaders.includes('fabric')) && !(profile.loader === 'neoforge' && f.loaders.includes('forge')),
        notMod: !f.jar || !f.loaders.length,
        // Modrinth знает этот файл, но он для другой версии Minecraft или другого загрузчика
        otherTarget: !!f.otherTarget,
      }))
      .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    const brief = (x) => ({ name: x.name, ...(x.version ? { version: x.version } : { from: x.from, to: x.to }) });
    return { adopted: adopted.map(brief), replaced: replaced.map(brief), local, busy };
  }

  /** Положить файлы взятых модов в папку и записать их как файлы лаунчера; прежние версии этих модов — убрать. */
  async placeAdopted(dir, lock, keys, oldFiles = []) {
    const listFile = path.join(dir, '.easylauncher-managed.json');
    let managed = [];
    try {
      managed = JSON.parse(await fsp.readFile(listFile, 'utf8')).files || [];
    } catch {}
    const now = new Set(keys.map((k) => lock.mods.find((x) => x.key === k)?.file.filename).filter(Boolean));
    // прежняя версия заменённого мода — иначе в папке окажутся две версии одного мода
    for (const old of oldFiles) {
      if (!old || now.has(old) || !managed.includes(old)) continue;
      await http.retryFs(() => fsp.rm(path.join(dir, path.basename(old)), { force: true }), old);
      managed = managed.filter((n) => n !== old);
    }
    for (const key of keys) {
      const m = lock.mods.find((x) => x.key === key);
      if (!m) continue;
      const name = path.basename(m.file.filename);
      const target = path.join(dir, name);
      if (!fs.existsSync(target)) await fsp.copyFile(this.launcher.cache.pathFor(m.file), target);
      if (!managed.includes(name)) managed.push(name);
    }
    await fsp.writeFile(listFile, JSON.stringify({ files: managed }, null, 2));
  }

  /** Путь к файлу из папки mods по имени — только непосредственно в ней и только мод, который ставил не лаунчер. */
  async folderPath(pid, file) {
    if (typeof file !== 'string' || !FOLDER_JAR.test(file) || file !== path.basename(file)) throw Object.assign(new Error('Некорректное имя файла.'), { code: 'BAD_INPUT' });
    if (!(await this.folderFiles(pid)).includes(file)) throw Object.assign(new Error('Такого файла нет в папке модов.'), { code: 'NOT_FOUND' });
    return path.join(this.store.gameDir(pid), 'mods', file);
  }

  /** Включить/выключить мод из папки: .jar ↔ .jar.disabled (загрузчик берёт только .jar). */
  async folderToggle(pid, file, on) {
    if (this.launcher.profileBusy(pid)) throw Object.assign(new Error('Сборку нельзя менять во время игры или работы сервера.'), { code: 'SESSION_ACTIVE' });
    const from = await this.folderPath(pid, file);
    const base = file.replace(/\.disabled$/i, '');
    const to = path.join(path.dirname(from), on ? base : base + '.disabled');
    if (from === to) return { file };
    if (fs.existsSync(to)) throw new Error('В папке уже есть файл ' + path.basename(to) + '.');
    await http.retryFs(() => fsp.rename(from, to), file);
    return { file: path.basename(to) };
  }

  /** Версии Minecraft, для которых есть загрузчик. */
  async loaderSupport(loader) {
    const set = await loaders.supportedMinecraft(loader);
    return set ? [...set] : null;
  }

  /** Экспорт состава сборки: версия, загрузчик и точные релизы модов (без самих файлов). */
  async exportProfile(pid, file) {
    const p = await this.store.getProfile(pid);
    const lock = await this.store.getLock(pid);
    const pack = {
      format: 'easylauncher.pack/1',
      name: p.name,
      minecraft: lock.minecraft,
      loader: lock.loader,
      mods: lock.mods.filter((m) => m.addedBy !== 'dependency').map((m) => ({ source: m.source, projectId: m.projectId, versionId: m.versionId, name: m.name })),
    };
    await writeJson(file, pack);
    return { mods: pack.mods.length };
  }

  /** Импорт: новая сборка и план установки тех же релизов (зависимости подбираются заново и проверяются). */
  async importProfile(file) {
    const pack = await readJson(file);
    if (pack?.format !== 'easylauncher.pack/1' || !Array.isArray(pack.mods)) throw new Error('Это не файл сборки easyLauncher (.easypack).');
    const before = await this.settings();
    let p;
    try {
      p = await this.createProfile({ name: pack.name, minecraft: pack.minecraft, loader: pack.loader });
      const add = pack.mods
        .filter((m) => ['modrinth', 'curseforge'].includes(m.source) && /^[\w-]{1,64}$/.test(String(m.projectId)))
        .slice(0, 500)
        .map((m) => ({ source: m.source, projectId: String(m.projectId), versionId: m.versionId ? String(m.versionId) : undefined }));
      const plan = add.length ? await this.planMods(p.id, { add }) : null;
      // запрос возвращается вместе с планом: окно плана пересобирает его с ним (бета-версии, дубликаты)
      return { profile: p, plan, add };
    } catch (e) {
      if (p) {
        await this.store.deleteProfile(p.id).catch(() => {});
        await this.saveSettings({ lastProfile: before.lastProfile || null }).catch(() => {});
      }
      throw e;
    }
  }

  /**
   * Импорт готовой сборки: .easypack, .mrpack (Modrinth) или архив CurseForge. Создаёт сборку, раскладывает
   * настройки сборки (overrides) и готовит план установки модов — игрок видит его до установки.
   * report: что взято с Modrinth вместо CurseForge, что не нашлось (со ссылками), что пропущено и почему.
   */
  async importPack(file) {
    if (/\.(easypack|json)$/i.test(file)) {
      const r = await this.importProfile(file);
      return { ...r, request: r.plan ? { add: r.add } : null, report: null };
    }
    const pack = await readPack(file);
    if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,47}$/.test(pack.minecraft)) throw Object.assign(new Error('В сборке не указана версия Minecraft.'), { code: 'BAD_PACK' });
    const before = await this.settings();
    let p;
    try {
      const lv = pack.loaderVersion && /^[\w.+-]{1,60}$/.test(pack.loaderVersion) ? pack.loaderVersion : null;
      p = await this.createProfile({ name: pack.name, minecraft: pack.minecraft, loader: pack.loader, loaderVersion: pack.loader === 'vanilla' ? null : lv });
      const gameDir = this.store.gameDir(p.id);
      const target = { minecraft: pack.minecraft, loader: pack.loader };
      const report = { kind: pack.kind, total: 0, viaModrinth: 0, files: 0, overrides: 0, notFound: [], skipped: [], noCurseForge: false };
      // что сейчас происходит — в окне ожидания импорта (большая сборка разбирается минуты)
      const say = (detail) => this.emit('mods-progress', { phase: 'import', detail });
      const add = [];
      const prov = await this.providers();
      const mr = prov.modrinth;
      if (pack.kind === 'mrpack') {
        report.total = pack.mods.length;
        let hits = {};
        say(`Проверяю моды на Modrinth: ${pack.mods.length}`);
        if (pack.mods.length) {
          try {
            hits = await mr.byHashes(pack.mods.map((m) => m.sha1));
          } catch (e) {
            throw Object.assign(new Error('Не удалось связаться с Modrinth, чтобы проверить моды сборки. Проверь интернет и повтори импорт.'), { code: 'NETWORK' });
          }
        }
        const known = pack.mods.filter((m) => hits[m.sha1]);
        // всё о модах — пачками: план большой сборки иначе сделал бы сотни запросов
        await mr.warmVersions(known.map((m) => hits[m.sha1].versionId)).catch(() => {});
        await mr.projects([...new Set(known.map((m) => hits[m.sha1].projectId))]).catch(() => {});
        for (const m of known) add.push({ source: 'modrinth', projectId: hits[m.sha1].projectId, versionId: hits[m.sha1].versionId });
        // файлы не с Modrinth (например, с GitHub) — скачиваем в папку модов со сверкой хеша, как «свои» моды
        const rest = [...pack.mods.filter((x) => !hits[x.sha1]), ...pack.files];
        let k = 0;
        for (const m of pack.mods.filter((x) => !hits[x.sha1])) {
          say(`Скачиваю файлы сборки: ${++k} из ${rest.length}`);
          if (await this.packDownload(m, gameDir)) report.files++;
          else report.notFound.push({ name: path.basename(m.path), url: m.urls[0] || null });
        }
        for (const f of pack.files) {
          say(`Скачиваю файлы сборки: ${++k} из ${rest.length}`);
          if (await this.packDownload(f, gameDir)) report.files++;
          else report.skipped.push({ name: f.path, reason: 'не скачался' });
        }
      } else if (prov.curseforge.status().available && (await prov.curseforge.project(pack.cfFiles[0]?.projectId || '238222').then(() => true, () => false))) {
        // CurseForge отвечает — точные файлы из manifest.json (не ответил — ниже ищем те же моды на Modrinth).
        // Всё о файлах — параллельно и с повтором: потом план берёт ответы из кэша, а не спрашивает по одному.
        const cf = prov.curseforge;
        let checked = 0;
        const info = await mapLimit(pack.cfFiles, 8, async (f) => {
          say(`Проверяю моды CurseForge: ${++checked} из ${pack.cfFiles.length}`);
          let err;
          for (let i = 0; i < 3; i++) {
            try {
              return { f, raw: await cf.rawMod(f.projectId), v: await cf.version(f.projectId, f.fileId) };
            } catch (e) {
              err = e;
              if (e.code === 'NOT_FOUND') break;
              await new Promise((r) => setTimeout(r, 400 * (i + 1)));
            }
          }
          return { f, err };
        });
        for (const x of info) {
          if (x.err) {
            report.skipped.push({ name: x.f.projectId, reason: `Мод CurseForge ${x.f.projectId}: ${x.err.message}` });
            continue;
          }
          const cls = x.raw.classId;
          if (cls === undefined || cls === CF_CLASS.mods) {
            report.total++;
            add.push({ source: 'curseforge', projectId: x.f.projectId, versionId: x.f.fileId });
            continue;
          }
          // ресурспаки и шейдеры в сборке CurseForge лежат рядом с модами — кладём их в свои папки
          const dir = cls === CF_CLASS.resourcepacks ? 'resourcepacks' : cls === CF_CLASS.shaders ? 'shaderpacks' : null;
          const file = x.v.files[0];
          if (!dir) report.skipped.push({ name: x.raw.name, reason: `${x.raw.name}: это не мод, ресурспак или шейдер — пропущено.` });
          else if (!file.url) report.skipped.push({ name: x.raw.name, reason: `${x.raw.name}: автор запретил скачивание из лаунчеров — скачай с сайта CurseForge.` });
          else {
            say(`Скачиваю ${dir === 'resourcepacks' ? 'ресурспак' : 'шейдер'}: ${x.raw.name}`);
            if (await this.packDownload({ path: `${dir}/${file.filename}`, urls: [file.url], sha1: file.hashes.sha1, size: file.size }, gameDir, ALLOWED_HOSTS)) report.files++;
            else report.skipped.push({ name: x.raw.name, reason: `${x.raw.name}: не скачался.` });
          }
        }
      } else {
        // CurseForge не подключён: те же моды ищем на Modrinth по названию и адресу из modlist.html
        report.noCurseForge = true;
        report.total = pack.modlist.length || pack.cfFiles.length;
        for (const [i, m] of pack.modlist.entries()) {
          say(`Ищу моды на Modrinth: ${i + 1} из ${pack.modlist.length}`);
          const hit = await this.findOnModrinth(mr, m, target).catch(() => null);
          if (hit) {
            add.push({ source: 'modrinth', projectId: hit.id });
            report.viaModrinth++;
          } else report.notFound.push({ name: m.name, url: m.url });
        }
        if (!pack.modlist.length) report.unnamed = pack.cfFiles.length;
      }
      say('Раскладываю настройки сборки…');
      report.overrides = await extractOverrides(pack, gameDir);
      say(`Составляю план установки: ${add.length} модов`);
      const { plan, request } = await this.planImport(p.id, add, report);
      return { profile: p, plan, request, report };
    } catch (e) {
      if (p) {
        await this.store.deleteProfile(p.id).catch(() => {});
        await this.saveSettings({ lastProfile: before.lastProfile || null }).catch(() => {});
      }
      throw e;
    }
  }

  /**
   * План импорта, который можно применить: точный релиз из сборки не подходит этой версии игры — берём
   * подходящий; мод не ставится совсем (нет версии, конфликт) — убираем из плана и пишем в отчёт.
   */
  async planImport(pid, add, report) {
    if (!add.length) return { plan: null, request: null };
    let list = add.map((a) => ({ ...a }));
    let plan = null;
    for (let round = 0; round < 4; round++) {
      plan = await this.planMods(pid, { add: list, trustPack: true });
      if (plan.ok) break;
      const byKey = new Map(list.map((a) => [`${a.source}:${a.projectId}`, a]));
      let changed = false;
      for (const e of plan.errors || []) {
        const a = e.key && byKey.get(e.key);
        if (!a) continue;
        if (e.code === 'INCOMPATIBLE' && a.versionId) {
          delete a.versionId; // точный релиз не подошёл — пусть план подберёт совместимый
          changed = true;
        } else {
          list = list.filter((x) => x !== a);
          byKey.delete(e.key);
          report.skipped.push({ name: (e.message || e.key).split(':')[0], reason: e.message || 'не ставится' });
          changed = true;
        }
      }
      if (!changed) break;
    }
    return { plan, request: { add: list, trustPack: true } };
  }

  /** Тот же мод на Modrinth по адресу CurseForge (slug) или названию — только если он есть для этой сборки. */
  async findOnModrinth(mr, { slug, name }, target) {
    const norm = (x) => String(x || '').toLowerCase().replace(/\(.*?\)|\[.*?\]/g, '').replace(/[^a-zа-я0-9]+/g, '');
    const fits = async (p) => (await mr.versions(p.id, target)).some((v) => (v.minecraft || []).includes(target.minecraft) && compatible(v, target));
    if (slug) {
      try {
        const p = await mr.project(slug);
        if ((p.slug === slug || norm(p.name) === norm(name)) && (await fits(p))) return p;
      } catch {}
    }
    if (!name) return null;
    const hits = (await mr.search({ query: name, minecraft: target.minecraft, loader: target.loader, limit: 10 })).hits;
    const hit = hits.find((h) => norm(h.name) === norm(name) || (slug && h.slug === slug));
    return hit && (await fits(hit)) ? hit : null;
  }

  /** Файл сборки не из каталога: только с разрешённых площадок, внутри папки игры, со сверкой хеша, с повтором. */
  async packDownload(item, gameDir, hosts = [PACK_HOSTS]) {
    const url = item.urls.find((u) => hosts.some((re) => re.test(u)));
    const rel = safeRel(item.path);
    const target = rel && path.resolve(gameDir, rel);
    if (!url || !target || !target.startsWith(path.resolve(gameDir) + path.sep) || !item.sha1) return false;
    for (let i = 0; i < 3; i++) {
      try {
        await http.download(url, target, { sha1: item.sha1, sha512: item.sha512 || undefined, size: item.size || undefined });
        return true;
      } catch {
        await new Promise((r) => setTimeout(r, 500 * (i + 1)));
      }
    }
    return false;
  }

  /** Скриншоты сборки (новые сверху) — для выбора обложки. */
  async screenshots(pid, limit = 60) {
    const dir = path.join(this.store.gameDir(pid), 'screenshots');
    let files = [];
    try {
      files = (await fsp.readdir(dir)).filter((f) => IMG_RE.test(f));
    } catch {}
    const out = [];
    for (const f of files) out.push({ file: path.join(dir, f), name: f, t: (await fsp.stat(path.join(dir, f))).mtimeMs });
    return out.sort((a, b) => b.t - a.t).slice(0, limit);
  }

  // ---------- главный экран ----------
  /** Всё для главной: часы в игре, запуски, история, последние скриншоты, размер сборки. */
  async homeInfo(pid) {
    const profile = await this.store.getProfile(pid);
    const lock = await this.store.getLock(pid);
    const log = await this.playlog.summary(pid, 6);
    const shotsAll = await this.screenshots(pid, 1000);
    const worlds = await this.worlds.list(pid).catch(() => []);
    // моды из папки, положенные вручную, — как на карточке сборки, чтобы числа на главной совпадали
    const folder = profile.kind === 'room' || profile.loader === 'vanilla' ? [] : await this.folderFiles(pid);
    return {
      stats: {
        seconds: log.seconds,
        launches: log.launches,
        lastPlayed: profile.lastPlayed || null,
        worlds: worlds.length,
        screenshots: shotsAll.length,
        mods: lock.mods.length + folder.length,
        sizeBytes: await this.profileSize(pid, `${shotsAll.length}:${worlds.length}:${lock.mods.length}`),
      },
      sessions: log.sessions,
      shots: shotsAll.slice(0, 8),
    };
  }

  /** Сколько места занимает сборка (игра, миры, моды); пересчёт раз в 10 минут или когда изменилось число скриншотов, миров, модов. */
  async profileSize(pid, key = '') {
    const c = this.sizeCache.get(pid);
    if (c && c.key === key && Date.now() - c.at < 10 * 60 * 1000) return c.bytes;
    let bytes = 0;
    const walk = async (dir, depth) => {
      let list = [];
      try {
        list = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of list) {
        const f = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (depth < 12) await walk(f, depth + 1);
        } else if (e.isFile()) bytes += (await fsp.stat(f).catch(() => ({ size: 0 }))).size;
      }
    };
    await walk(this.store.profileDir(pid), 0);
    this.sizeCache.set(pid, { at: Date.now(), key, bytes });
    return bytes;
  }

  /** Место на диске: общий кэш модов и файлы игры (версии, библиотеки, ресурсы, Java). */
  async storageInfo() {
    const shared = path.join(this.root, 'shared');
    const size = async (dir) => {
      let bytes = 0;
      const walk = async (d, depth) => {
        for (const e of await fsp.readdir(d, { withFileTypes: true }).catch(() => [])) {
          const f = path.join(d, e.name);
          if (e.isDirectory()) {
            if (depth < 14) await walk(f, depth + 1);
          } else if (e.isFile()) bytes += (await fsp.stat(f).catch(() => ({ size: 0 }))).size;
        }
      };
      await walk(dir, 0);
      return bytes;
    };
    const game = (await Promise.all(['versions', 'libraries', 'assets', 'runtime'].map((d) => size(path.join(shared, d))))).reduce((a, b) => a + b, 0);
    return { modCache: await size(path.join(shared, 'mod-cache')), game };
  }

  /** Удалить из кэша файлы модов, которые не нужны ни одной сборке (с учётом прежних составов для отката). */
  async cleanModCache() {
    if (this.installer.activePid || this.runningTask) throw new Error('Сейчас ставятся моды — очисти кэш после окончания.');
    const used = new Set();
    const add = (lock) => (lock?.mods || []).forEach((m) => m.file?.hashes?.sha1 && used.add(String(m.file.hashes.sha1).toLowerCase()));
    for (const p of await this.store.listProfiles()) {
      add(await this.store.getLock(p.id));
      const dir = this.installer.historyDir(p.id);
      for (const f of await fsp.readdir(dir).catch(() => [])) if (f.endsWith('.lock.json')) add(await readJson(path.join(dir, f)));
    }
    return { freed: await this.launcher.cache.gc(used) };
  }

  /** Сколько модов можно обновить. Проверка через каталог — не чаще раза в 6 часов и заново после изменения состава. */
  async modUpdates(pid, { force = false } = {}) {
    const lock = await this.store.getLock(pid);
    if (lock.loader === 'vanilla' || !lock.mods.length) return { count: 0, names: [] };
    const key = lock.mods.map((m) => m.key + '@' + m.versionId).join(',');
    const c = this.updatesCache.get(pid);
    if (!force && c && c.key === key && Date.now() - c.at < 6 * 3600 * 1000) return c.result;
    const plan = await this.planMods(pid, { update: 'all' });
    this.plans.delete(plan.planId); // только подсчёт: применять этот план никто не будет
    const ups = plan.changes.filter((ch) => ch.type === 'update');
    const result = { count: ups.length, names: ups.map((ch) => ch.name).slice(0, 5), checkedAt: new Date().toISOString() };
    this.updatesCache.set(pid, { key, at: Date.now(), result });
    return result;
  }

  /**
   * Новости Minecraft: список изменений Java Edition с сервера лаунчера Mojang. Формат неофициальный:
   * сначала v2 (краткий текст + отдельный файл с полным), иначе v1 (полный текст в записи). Кэш — для офлайна.
   */
  async news() {
    let lastError = null;
    for (const [url, name] of [[NEWS_URL, 'java-patch-notes.json'], [NEWS_URL_V1, 'java-patch-notes-v1.json']]) {
      const file = path.join(this.root, 'cache', name);
      let fresh = false;
      try {
        fresh = Date.now() - (await fsp.stat(file)).mtimeMs < 6 * 3600 * 1000;
      } catch {}
      let data = null;
      try {
        // без ответа за 8 секунд — последние сохранённые новости
        data = await http.cachedJson(url, file, { refresh: !fresh, signal: AbortSignal.timeout(8000) });
      } catch (e) {
        lastError = e;
        data = await readJson(file); // тайм-аут считается отменой — кэш берём сами
      }
      const list = parseNews(data);
      if (list.length) return list;
    }
    throw lastError || new Error('Новостей нет.');
  }

  /** Полный текст записи новостей (HTML от Mojang; интерфейс показывает из него только текст). */
  async newsBody(contentPath) {
    if (!/^[\w.-]{1,120}\.json$/.test(String(contentPath))) throw new Error('Некорректная запись новостей.');
    const j = await http.json(NEWS_BASE + '/v2/' + contentPath, { signal: AbortSignal.timeout(15000) });
    return { body: String(j?.body || '').slice(0, 400000) };
  }

  // ---------- миры сборки ----------
  playingFolder(pid) {
    const st = this.launcher.status();
    return st.clientProfile === pid ? st.playingLevel : null;
  }

  async listWorlds(pid) {
    const list = await this.worlds.list(pid);
    const playing = this.playingFolder(pid);
    const srv = this.launcher.status();
    return list.map((w) => ({ ...w, playing: playing === w.name, hosted: srv.server !== 'stopped' && srv.serverProfile === pid && srv.serverFolder === w.folder }));
  }

  /** Обложка мира вручную: своя картинка или скриншот этой же сборки. */
  async setWorldCover(pid, folder, src, { pinned = true } = {}) {
    return this.worlds.setCover(pid, folder, src, { source: 'manual', pinned });
  }
  async pinWorldCover(pid, folder, pinned) {
    return this.worlds.pinCover(pid, folder, pinned);
  }
  async clearWorldCover(pid, folder) {
    return this.worlds.clearCover(pid, folder);
  }
  async worldBackups(pid, folder) {
    return this.worlds.backups(pid, folder);
  }
  async backupWorld(pid, folder) {
    const w = await this.worlds.get(pid, folder);
    return this.worlds.backup(pid, folder, { server: this.launcher.server, playingFolder: this.playingFolder(pid) === w.name ? folder : null });
  }
  async restoreWorld(pid, folder, backupId) {
    const w = await this.worlds.get(pid, folder);
    return this.worlds.restore(pid, folder, backupId, { playingFolder: this.playingFolder(pid) === w.name ? folder : null });
  }
  async deleteWorld(pid, folder, confirmName) {
    const w = await this.worlds.get(pid, folder);
    if (this.playingFolder(pid) === w.name) throw new Error('В этом мире сейчас идёт игра. Выйди в главное меню Minecraft.');
    await this.worlds.remove(pid, folder, confirmName);
    await this.chronicle.forget(pid, folder).catch(() => {});
  }

  /**
   * Сессия в одиночном мире закончилась (по журналу клиента). Если имя мира однозначно соответствует
   * одной папке — запоминаем сессию и обновляем незакреплённую обложку последним скриншотом из неё.
   * Неоднозначно — скриншоты остаются только «скриншотами сборки».
   */
  /** Папка мира по имени из журнала — только если совпадение однозначное. */
  async resolveWorld(pid, level) {
    if (!level) return null;
    const matches = (await this.worlds.list(pid)).filter((w) => w.name === level || w.folder === level);
    return matches.length === 1 ? matches[0] : null;
  }

  // ---------- «Вызов другу» ----------
  challengeCatalog() {
    return { goals: GOALS.map((g) => ({ id: g.id, text: g.text, title: g.ru, min: g.min })), rules: RULES };
  }
  async challengeCreate(opts = {}) {
    const s = await this.settings();
    return opts.random ? this.challenges.random(s.nickname) : this.challenges.create({ ...opts, from: s.nickname });
  }
  challengeCompare(code) {
    return parseResult(code);
  }

  // ---------- «Почему тормозило» ----------
  perfFile(pid) {
    return path.join(this.store.profileDir(pid), 'perf.json');
  }
  async perfClient(ev) {
    if (ev.state === 'running') {
      const c = this.launcher.client;
      if (!c?.proc?.pid) return;
      const lock = await this.store.getLock(ev.profileId).catch(() => ({ mods: [] }));
      this.perf.start({ pid: c.proc.pid, profileId: ev.profileId, ramGb: this.launchRam || 4, loader: lock.loader, mods: lock.mods || [], gameDir: this.store.gameDir(ev.profileId), totalRamGb: Math.round(this.launcher.totalMem / GiB) });
      return;
    }
    if (ev.state !== 'stopped') return;
    const report = this.perf.stop({ seconds: ev.seconds });
    if (!report) return;
    await writeJson(this.perfFile(ev.profileId), report);
    if (report.issues.length) this.emit('event', { type: 'perf', profileId: ev.profileId, report });
  }
  /** Последний разбор сборки — пока игрок не скрыл его или не сыграл снова. */
  async perfLast(pid) {
    const r = await readJson(this.perfFile(pid));
    return r && !r.dismissed && r.issues?.length ? r : null;
  }
  async perfDismiss(pid) {
    const r = await readJson(this.perfFile(pid));
    if (r) await writeJson(this.perfFile(pid), { ...r, dismissed: true });
    return true;
  }

  // ---------- летопись мира ----------
  async chronicleBegin(pid, level) {
    const w = await this.resolveWorld(pid, level);
    if (!w) return;
    if (this.worldSession) await this.chronicleEnd().catch(() => {});
    await this.worldBegin(pid, w.folder);
  }
  async worldBegin(pid, folder) {
    const s = await this.chronicle.begin(pid, folder);
    this.worldSession = s;
    await this.challenges.worldBegin(pid, folder, { isNew: s.isNew }).catch(() => {});
  }
  async chronicleEnd(shots = []) {
    const s = this.worldSession;
    if (!s) return;
    this.worldSession = null;
    await this.challenges.worldEnd(s.pid, s.folder).catch(() => {});
    await this.chronicle.end(s, { shots });
    this.emit('event', { type: 'worlds-changed', profileId: s.pid });
  }
  /** Свои UUID игрока: аккаунт Microsoft (из запусков) и офлайн-ник — так называются свои файлы игрока в мире. */
  rememberMe(auth) {
    if (auth?.uuid) this.knownUuids.add(auth.uuid);
    if (auth?.name) this.knownUuids.add(offlineUuid(auth.name));
  }
  myUuids() {
    const out = [...this.knownUuids];
    if (this.nickCache) out.push(offlineUuid(this.nickCache));
    return out;
  }

  /**
   * Хозяин зашёл (или перезашёл через меню) на свой сервер сессии — летопись мира этого сервера,
   * как в одиночной игре. Чужой сервер из меню игры — не наш мир.
   */
  async onClientServer(ev) {
    const c = this.launcher.client;
    const srv = this.launcher.server;
    if (!c || c.mode !== 'server' || this.worldSession || srv.state !== 'running' || srv.profileId !== ev.profileId || !srv.folder) return;
    if (!ownServer(ev.server, srv.port)) return;
    await this.worldBegin(ev.profileId, srv.folder);
  }
  /** Хозяин вышел со своего сервера: сессия в летописи со скриншотами, последний — обложка мира. */
  async onServerSession({ profileId, server, shots = [] }) {
    const s = this.worldSession;
    if (!s || s.pid !== profileId || !ownServer(server, this.launcher.server.port ?? this.lastServerPort)) return;
    const folder = s.folder;
    await this.chronicleEnd(shots).catch(() => {});
    await this.worlds.recordSession(profileId, folder, { mode: 'host', shots: shots.length }).catch(() => {});
    const last = shots[shots.length - 1];
    if (!last) return;
    const file = path.join(this.store.gameDir(profileId), 'screenshots', path.basename(last));
    if (fs.existsSync(file)) await this.worlds.setCover(profileId, folder, file, { source: 'session', pinned: false });
    this.emit('event', { type: 'worlds-changed', profileId });
  }

  /** Хозяин играет на своём сервере сессии: летопись ведётся для мира этого сервера. */
  async chronicleClient(ev) {
    if (ev.state === 'running' && ev.mode === 'server' && this.launcher.server.folder && this.launcher.server.profileId === ev.profileId) {
      await this.worldBegin(ev.profileId, this.launcher.server.folder);
    }
    if (ev.state === 'stopped') {
      await this.chronicleEnd();
      // игра закрыта, летопись и часы записаны — новые трофеи
      await new Promise((r) => setTimeout(r, 300));
      const t = await this.trophies().catch(() => null);
      if (t?.fresh.length) this.emit('event', { type: 'trophy', fresh: t.fresh });
    }
  }

  /**
   * Откуда скриншот (для подписи в фото-режиме): мир и игровой день — из сессии летописи, в которой он сделан.
   * Координаты сессии — где игрок закончил её, поэтому они только примерные.
   */
  async shotInfo(pid, file) {
    const base = path.basename(file);
    const chr = await this.chronicle.data(pid).catch(() => ({ worlds: {} }));
    let hit = null;
    for (const [folder, w] of Object.entries(chr.worlds || {})) {
      const e = (w.events || []).find((x) => x.kind === 'session' && (x.shots || []).includes(base));
      if (e) hit = { folder, day: e.day ?? null, pos: e.pos || null, dim: e.dim || null };
    }
    let world = null;
    if (hit) world = (await this.worlds.list(pid).catch(() => [])).find((w) => w.folder === hit.folder)?.name || hit.folder;
    const st = await fsp.stat(file).catch(() => null);
    return { world, day: hit?.day ?? null, pos: hit?.pos || null, dim: hit?.dim || null, at: st ? new Date(st.mtimeMs).toISOString() : null, build: (await this.store.getProfile(pid)).name };
  }

  /** Статистика для трофеев — по всему, что лаунчер записывает о всех сборках. */
  async trophyStats() {
    const profiles = await this.store.listProfiles();
    const s = { hours: 0, launches: 0, builds: profiles.filter((p) => p.kind !== 'room').length, maxMods: 0, maxDay: 0, deaths: 0, advTitles: new Set(), friendSessions: 0, challenges: 0, clips: 0, screenshots: 0 };
    let seconds = 0;
    for (const p of profiles) {
      for (const e of await this.playlog.read(p.id)) {
        seconds += e.seconds || 0;
        if (e.mode === 'friends' || e.mode === 'guest') s.friendSessions++;
        else s.launches++;
      }
      if (p.kind !== 'room') {
        const lock = await this.store.getLock(p.id).catch(() => ({ mods: [] }));
        s.maxMods = Math.max(s.maxMods, lock.mods.length + (p.loader === 'vanilla' ? 0 : (await this.folderFiles(p.id)).length));
      }
      const chr = await this.chronicle.data(p.id).catch(() => ({ worlds: {} }));
      for (const w of Object.values(chr.worlds || {})) {
        for (const e of w.events || []) {
          if (Number.isFinite(e.day)) s.maxDay = Math.max(s.maxDay, e.day);
          if (e.kind === 'death') s.deaths++;
          if (['advancement', 'goal', 'challenge'].includes(e.kind) && e.title) s.advTitles.add(trophyNorm(e.title));
        }
      }
      s.screenshots += (await fsp.readdir(path.join(this.store.gameDir(p.id), 'screenshots')).catch(() => [])).filter((f) => IMG_RE.test(f)).length;
    }
    s.hours = seconds / 3600;
    s.advancements = s.advTitles.size;
    s.challenges = (await this.challenges.data()).history.filter((h) => h.done).length;
    s.clips = (await this.memories.list().catch(() => [])).length;
    return s;
  }

  /** Трофеи: список с прогрессом и только что полученные. */
  async trophies() {
    const stats = await this.trophyStats();
    const r = await this.trophyBook.evaluate(stats);
    return { ...r, hours: Math.floor(stats.hours), nick: (await this.settings()).nickname || null };
  }
  /** Достижение или смерть: в летопись мира, вызову и камере воспоминаний; ролик потом привязывается к событию. */
  async onMoment(ev) {
    const s = this.worldSession;
    const mine = s && s.pid === ev.profileId;
    const entry = mine ? await this.chronicle.moment(s, ev).catch(() => null) : null;
    if (mine) {
      const done = await this.challenges.moment(s.pid, s.folder, ev, this.launcher.client?.player || 'Player').catch(() => null);
      if (done) {
        await this.chronicle.add(s.pid, s.folder, { kind: 'challenge-done', title: done.goal.text, seconds: done.done.seconds, inTime: done.done.inTime, day: this.chronicle.dayNow(s) });
        this.emit('event', { type: 'challenge', profileId: s.pid, challenge: done });
      }
    }
    const r = await this.memories.moment(ev).catch(() => null);
    if (entry && r?.clip) await this.chronicle.update(s.pid, s.folder, entry.id, { clip: r.clip.id });
    if (entry) this.emit('event', { type: 'worlds-changed', profileId: s.pid });
  }
  // ---------- карта мира ----------
  mapDir(pid, folder) {
    checkFolder(folder);
    return path.join(this.store.profileDir(pid), 'maps', Buffer.from(folder).toString('hex').slice(0, 80));
  }

  /** Что есть на карте: регионы верхнего мира, точка появления, игрок, последняя смерть, события летописи с местом. */
  async mapInfo(pid, folder) {
    const w = await this.worlds.get(pid, folder);
    const info = await readWorld(this.worlds.dir(pid, folder), { uuids: this.myUuids() });
    if (!info.dataVersion || info.dataVersion < FLATTENING) return { supported: false, world: w, reason: 'Карта рисуется для миров Minecraft 1.13 и новее: в старых мирах другой формат файлов.' };
    let names = [];
    try {
      names = await fsp.readdir(info.regionDir);
    } catch {}
    const regions = [];
    for (const n of names) {
      const c = regionCoords(n);
      if (!c) continue;
      const st = await fsp.stat(path.join(info.regionDir, n));
      if (st.size > 8192) regions.push({ ...c, size: st.size }); // меньше 8 КБ — только заголовок, мира там нет
    }
    const over = (p) => p && (p.dim || 'overworld') === 'overworld';
    const events = (await this.chronicle.events(pid, folder)).filter((e) => e.pos && over(e));
    return {
      supported: true,
      world: w,
      regions,
      spawn: info.spawn,
      player: over(info.player) ? info.player.pos : null,
      lastDeath: over(info.lastDeath) ? info.lastDeath.pos : null,
      markers: events.map((e) => ({ id: e.id, kind: e.kind, title: e.title || '', at: e.at, day: e.day ?? null, pos: e.pos, approx: !!e.approx, clip: e.clip || null })),
    };
  }

  /**
   * Плитка региона (PNG 512×512) из кэша; если регион изменился после отрисовки — рисуется заново в отдельном
   * потоке. Плитки рисуются по одной, чтобы не занимать все ядра процессора.
   */
  async mapTile(pid, folder, x, z) {
    if (!Number.isInteger(x) || !Number.isInteger(z) || Math.abs(x) > 100000 || Math.abs(z) > 100000) throw new Error('Некорректный регион.');
    const info = await readWorld(this.worlds.dir(pid, folder));
    const mca = path.join(info.regionDir, `r.${x}.${z}.mca`);
    if (!fs.existsSync(mca)) return null;
    const dir = this.mapDir(pid, folder);
    const out = path.join(dir, `r.${x}.${z}.png`);
    const fresh = () => fs.existsSync(out) && fs.statSync(out).mtimeMs >= fs.statSync(mca).mtimeMs;
    if (fresh()) return out;
    const job = (this.mapQueue || Promise.resolve()).catch(() => {}).then(async () => {
      if (fresh()) return;
      await fsp.mkdir(dir, { recursive: true });
      await new Promise((resolve, reject) => {
        const worker = new Worker(path.join(__dirname, 'worldmap-worker.js'), { workerData: { mca, out, dataVersion: info.dataVersion } });
        let answered = false;
        worker.once('message', (m) => {
          answered = true;
          m.ok ? resolve() : reject(new Error('Карта не нарисовалась: ' + m.message));
        });
        worker.once('error', reject);
        worker.once('exit', (code) => !answered && reject(new Error(`Карта не нарисовалась (код ${code}).`)));
      });
    });
    this.mapQueue = job;
    await job;
    return out;
  }

  async chronicleList(pid, folder) {
    const w = await this.worlds.get(pid, folder);
    const clips = await this.memories.list().catch(() => []);
    return { world: w, events: await this.chronicle.list(pid, folder, { worldName: w.name, clips }) };
  }

  async onWorldSession({ profileId, level, shots }) {
    if (this.worldSession?.pid === profileId) await this.chronicleEnd(shots).catch(() => {});
    const w = await this.resolveWorld(profileId, level);
    if (!w) return;
    await this.worlds.recordSession(profileId, w.folder, { mode: 'single', shots: shots.length });
    const last = shots[shots.length - 1];
    if (!last) return;
    const file = path.join(this.store.gameDir(profileId), 'screenshots', path.basename(last));
    if (fs.existsSync(file)) await this.worlds.setCover(profileId, w.folder, file, { source: 'session', pinned: false });
    this.emit('event', { type: 'worlds-changed', profileId });
  }

  /** Пока в сборку ставятся моды, запускать её нельзя: папка mods ещё меняется. */
  assertNotInstalling(pid) {
    if (this.installer.activePid === pid) throw Object.assign(new Error('В эту сборку сейчас устанавливаются моды.'), { code: 'BUSY', action: 'Дождись окончания установки и нажми «Играть» ещё раз.' });
  }

  // ---------- запуск ----------
  /**
   * «Играть»: главное меню Minecraft. req: {profileId, world?: папка мира для быстрого входа,
   * server?: '127.0.0.1:порт' — хозяин заходит на свой сервер сессии}.
   */
  async play(req, auth) {
    const settings = await this.settings();
    const profile = await this.store.getProfile(req.profileId);
    if (profile.kind === 'room') throw new Error('Сборка комнаты запускается из «С друзьями».');
    this.assertNotInstalling(profile.id);
    const budget = this.memoryBudget('play', settings, profile);
    // связи модов по файлам: без обязательного мода игра всё равно вылетит — говорим заранее и предлагаем починку
    if (!req.skipLinks && profile.loader !== 'vanilla') {
      const report = await this.linkReport(profile.id).catch(() => null);
      if (Services.linkProblems(report)) {
        const task = await this.linkFixTask(profile.id, report).catch(() => null);
        throw Object.assign(new Error(`Моды сборки не сходятся: ${Services.linkText(report)}. С таким составом игра вылетит при запуске.`), {
          code: 'MISSING_DEPS',
          action: task ? 'Нажми «Исправить» — лаунчер подберёт подходящие версии, добавит недостающее из каталога или уберёт мод, которому не нашлось пары.' : 'Добавь недостающий мод в «Моды» или выключи мод, которому он нужен.',
          task,
        });
      }
    }
    // скин этой сборки: загружается в профиль Minecraft, если надет другой; ошибка не мешает игре
    const skinNote = profile.skinId ? await this.applyBuildSkin(profile, auth).catch((e) => `Скин сборки не надет: ${e.message}`) : null;
    // Модель помощника выгружается перед игрой, чтобы освободить память
    await this.ai.stop();
    this.rememberMe(auth);
    this.nickCache = settings.nickname || null;
    const r = await this.launcher.play({
      profileId: profile.id,
      auth,
      nickname: settings.nickname,
      ram: (this.launchRam = budget.client),
      options: settings.options || settings.window?.fullscreen ? { ...(settings.options || {}), fullscreen: !!settings.window?.fullscreen } : null,
      world: req.world || null,
      server: /^127\.0\.0\.1:\d{2,5}$/.test(req.server || '') ? req.server : null,
      jvmArgs: settings.jvmArgs ? settings.jvmArgs.split(/\s+/).filter(Boolean) : [],
      window: settings.window && !settings.window.fullscreen && settings.window.width ? settings.window : null,
      javaPath: settings.javaPath || null,
    });
    await this.saveSettings({ lastProfile: profile.id });
    return skinNote ? { ...r, skinNote } : r;
  }

  // ---------- пробный запуск: проверка после обновления и поиск виновника вылета ----------
  /** Пробный запуск сборки с теми же настройками, что «Играть», но в небольшом окне. opts — для launcher.probe. */
  async probeBuild(pid, auth, opts = {}) {
    const settings = await this.settings();
    const profile = await this.store.getProfile(pid);
    if (profile.kind === 'room') throw new Error('Сборку друга проверяет хозяин.');
    this.assertNotInstalling(pid);
    await this.ai.stop();
    return this.launcher.probe(
      {
        profileId: pid,
        auth,
        nickname: settings.nickname,
        ram: this.memoryBudget('play', settings, profile).client,
        options: { ...(settings.options || {}), fullscreen: false },
        jvmArgs: settings.jvmArgs ? settings.jvmArgs.split(/\s+/).filter(Boolean) : [],
        javaPath: settings.javaPath || null,
      },
      opts,
    );
  }

  /**
   * Проверка после обновления модов: пробный запуск; вылетела — прежний состав возвращается сам.
   * prevLock — состав до обновления (нужен, чтобы потом найти виноватое обновление).
   */
  async verifyUpdate(pid, auth) {
    const newLock = await this.store.getLock(pid);
    const r = await this.probeBuild(pid, auth);
    if (r.ok !== false) return { ok: r.ok, reason: r.reason, seconds: r.seconds };
    await this.rollbackMods(pid);
    const oldLock = await this.store.getLock(pid);
    const changed = Services.updatedKeys(oldLock, newLock);
    // для поиска виноватого обновления — новый состав, пока лаунчер открыт
    this.failedUpdate = { pid, newLock, changed, at: Date.now() };
    return { ok: false, reason: r.reason, rolledBack: true, changed: changed.map((k) => newLock.mods.find((m) => m.key === k)?.name).filter(Boolean), findings: diagnoseRules(r.crash), crash: r.crash.slice(-20000), seconds: r.seconds };
  }

  /** Какие моды поменялись между двумя составами: другая версия или новый мод. */
  static updatedKeys(oldLock, newLock) {
    const old = new Map(oldLock.mods.map((m) => [m.key, m]));
    return newLock.mods.filter((m) => m.enabled !== false && (!old.has(m.key) || old.get(m.key).versionId !== m.versionId)).map((m) => m.key);
  }

  /** Обязательные зависимости набора по цепочке (только моды этого состава). */
  static withDeps(lockMods, keys) {
    const byKey = new Map(lockMods.map((m) => [m.key, m]));
    const out = new Set(keys);
    const stack = [...keys];
    while (stack.length) {
      for (const d of byKey.get(stack.pop())?.dependencies || []) {
        if (d.kind !== 'required' || out.has(d.key) || !byKey.has(d.key)) continue;
        out.add(d.key);
        stack.push(d.key);
      }
    }
    return out;
  }

  /**
   * Поиск виновника вылета пробными запусками. mode: 'build' — среди всех включённых модов сборки и своих
   * файлов игрока; 'update' — среди модов последнего неудачного обновления (остальные — в прежних версиях).
   * Находит один мод или пару, которая падает только вместе. Ход поиска — событиями { type: 'bisect' }.
   */
  async findCulprit(pid, auth, mode = 'build') {
    if (this.bisect) throw Object.assign(new Error('Поиск уже идёт.'), { code: 'BUSY' });
    const ctl = { cancelled: false };
    this.bisect = ctl;
    const say = (x) => this.emit('event', { type: 'bisect', profileId: pid, ...x });
    try {
      const lock = await this.store.getLock(pid);
      let base = lock.mods.filter((m) => m.enabled !== false);
      let candidates;
      let folder = [];
      let fixedNew = null; // режим обновления: новые версии подозреваемых
      if (mode === 'update') {
        const fu = this.failedUpdate;
        if (!fu || fu.pid !== pid) throw Object.assign(new Error('Сведения о неудачном обновлении уже не в памяти — обнови моды ещё раз.'), { code: 'NO_UPDATE' });
        fixedNew = new Map(fu.newLock.mods.map((m) => [m.key, m]));
        candidates = fu.changed.map((k) => ({ id: k, kind: 'update', name: fixedNew.get(k)?.name || k }));
      } else {
        folder = (await this.syncFolder(pid).catch(() => ({ local: [] }))).local.filter((f) => f.enabled);
        candidates = [...base.map((m) => ({ id: m.key, kind: 'mod', name: m.name })), ...folder.map((f) => ({ id: f.file, kind: 'file', name: f.name }))];
      }
      if (!candidates.length) throw Object.assign(new Error('Искать не среди чего: в сборке нет модов.'), { code: 'EMPTY' });
      const total = Math.min(40, Math.ceil(Math.log2(candidates.length + 1)) * 2 + 2);
      let run = 0;
      let signature = null;
      /** Пробный запуск с набором подозреваемых (остальные выключены). */
      const probeSet = async (set) => {
        if (ctl.cancelled) throw Object.assign(new Error('Поиск остановлен.'), { code: 'CANCELLED' });
        run++;
        say({ state: 'run', run, total: Math.max(total, run), testing: set.length, of: candidates.length });
        let mods;
        let folderOff = [];
        if (mode === 'update') {
          // прежний состав, в котором у части подозреваемых — новые версии (и их новые зависимости)
          const ids = new Set(set.map((c) => c.id));
          const newMods = fu_mods(fixedNew, ids);
          mods = [...base.filter((m) => !newMods.has(m.key)), ...newMods.values()];
        } else {
          const keep = Services.withDeps(base, set.filter((c) => c.kind === 'mod').map((c) => c.id));
          mods = base.filter((m) => keep.has(m.key));
          const files = new Set(set.filter((c) => c.kind === 'file').map((c) => c.id));
          folderOff = folder.map((f) => f.file).filter((f) => !files.has(f));
        }
        const r = await this.probeBuild(pid, auth, { mods, folderOff });
        if (r.reason === 'cancelled' || ctl.cancelled) throw Object.assign(new Error('Поиск остановлен.'), { code: 'CANCELLED' });
        return r;
      };
      /** true — вылет, тот же, что искали. */
      const test = async (set) => {
        const r = await probeSet(set);
        if (r.ok !== false) return false;
        // набор без чьей-то библиотеки падает «не хватает мода» — это не тот вылет, который ищем
        if (!signature.missingDeps && diagnoseRules(r.crash).some((f) => f.id.startsWith('missing-dep'))) return false;
        return true;
      };
      // 0) вылет повторяется со всеми подозреваемыми?
      const first = await probeSet(candidates);
      if (first.ok !== false) return { reproduced: false, runs: run, reason: first.reason };
      signature = { missingDeps: diagnoseRules(first.crash).some((f) => f.id.startsWith('missing-dep')), crash: first.crash };
      // 1) делим пополам; если не падает ни одна половина — ищем пару
      const findIn = async (list, fixed = []) => {
        let cur = list;
        while (cur.length > 1) {
          const half = cur.slice(0, Math.ceil(cur.length / 2));
          cur = (await test([...fixed, ...half])) ? half : cur.slice(half.length);
        }
        return cur;
      };
      const find = async (list) => {
        if (list.length === 1) return list;
        const a = list.slice(0, Math.ceil(list.length / 2));
        const b = list.slice(a.length);
        if (await test(a)) return find(a);
        if (await test(b)) return find(b);
        // падают только вместе: из B — тот, что с A падает; из A — тот, что падает с ним
        const [y] = await findIn(b, a);
        const [x] = await findIn(a, [y]);
        return [x, y];
      };
      let culprits = await find(candidates);
      // мод запускается только со своими библиотеками: если те падают и без него — виновата библиотека
      if (mode === 'build' && culprits.length === 1 && culprits[0].kind === 'mod') {
        const deps = [...Services.withDeps(base, [culprits[0].id])].filter((k) => k !== culprits[0].id);
        const depCands = candidates.filter((c) => deps.includes(c.id));
        if (depCands.length && (await test(depCands))) culprits = await find(depCands);
      }
      say({ state: 'done', run, total: run });
      return { reproduced: true, runs: run, culprits, findings: diagnoseRules(signature.crash), mode };
    } finally {
      this.bisect = null;
      // в папке mods — последний проверенный набор: возвращаем сборку целиком (и после отмены, и после сбоя)
      const now = await this.store.getLock(pid).catch(() => null);
      if (now) await this.launcher.cache.materialize(path.join(this.store.gameDir(pid), 'mods'), now.mods.filter((m) => m.enabled !== false && lockLib.inGame(m))).catch(() => {});
    }

    function fu_mods(newByKey, ids) {
      // новые версии выбранных модов и всё, что им нужно из нового состава
      const keys = Services.withDeps([...newByKey.values()], [...ids]);
      return new Map([...keys].map((k) => [k, newByKey.get(k)]).filter(([, m]) => m));
    }
  }

  cancelCulprit() {
    if (this.bisect) this.bisect.cancelled = true;
    this.launcher.stopProbe();
  }

  /**
   * Скин сборки перед запуском. Загружается, только если в профиле надет другой (Mojang ограничивает частую смену).
   * Без входа в Microsoft — ничего: игра без входа показывает стандартный скин.
   */
  async applyBuildSkin(profile, auth) {
    if (!auth?.accessToken) return null;
    const list = await this.skins.list();
    const it = list.items.find((x) => x.id === profile.skinId);
    if (!it) return 'Скин этой сборки удалён из гардероба — играешь в своём обычном.';
    if (list.active === it.id) return null;
    await this.skins.apply(it.id, auth);
    return `Надет скин сборки «${it.name}».`;
  }

  // ---------- каталог и сборка ----------
  async catalogStatus() {
    const p = await this.providers();
    return { modrinth: p.modrinth.status(), curseforge: p.curseforge.status() };
  }
  /** Поиск; у каждого результата — состояние для выбранной сборки (установлен / можно поставить / несовместим). */
  async search(source, q, pid) {
    const p = await this.providers();
    if (!p[source]) throw new Error('Неизвестный источник.');
    const res = await p[source].search(q);
    if (pid) {
      const lock = await this.store.getLock(pid);
      const installed = new Map(lock.mods.map((m) => [m.key, m]));
      for (const h of res.hits) {
        const m = installed.get(h.key || `${source}:${h.id}`);
        h.installed = m ? { version: m.version, enabled: m.enabled !== false, addedBy: m.addedBy } : null;
      }
    }
    return res;
  }
  async categories(source) {
    return (await this.providers())[source].categories();
  }
  async projectPage(source, id, pid, { allVersions = false } = {}) {
    const p = await this.providers();
    const prov = p[source];
    const lock = await this.store.getLock(pid);
    const project = await prov.project(id);
    const versions = await prov.versions(id, { minecraft: lock.minecraft, loader: lock.loader, all: allVersions });
    const state = await modState({ lock, provider: prov, projectId: id, project });
    return { project, versions: versions.slice(0, 30), state };
  }

  /** План изменений сборки — хранится в главном процессе, интерфейс получает только его id и описание. */
  async planMods(pid, request) {
    const profile = await this.store.getProfile(pid);
    if (profile.kind === 'room') throw new Error('Состав сборки друга меняется только хозяином и обновляется по новому приглашению.');
    const lock = await this.store.getLock(pid);
    let base = lock;
    if (request.retarget) {
      // смена версии Minecraft/загрузчика: все моды перепроверяются под новую цель
      base = { ...lock, minecraft: request.retarget.minecraft || lock.minecraft, loader: request.retarget.loader || lock.loader, loaderVersion: null };
      if (base.loader === 'vanilla' && lock.mods.length) request = { ...request, remove: lock.mods.map((m) => m.key) };
      else request = { ...request, update: 'all' };
    }
    const providers = await this.providers();
    // проверка обновлений должна видеть свежие релизы, а не ответ каталога из кэша
    if (request.update) providers.modrinth.cache?.clear();
    let plan = await planChanges({ lock: base, request, providers });
    if (request.retarget && base.loader !== 'vanilla') {
      // моды без версии под новую версию игры или загрузчик — убираются (с предупреждением),
      // а не блокируют переход и не остаются несовместимыми
      const fits = (m) => (m.minecraft || []).includes(base.minecraft) && ((m.loaders || []).includes(base.loader) || (base.loader === 'quilt' && (m.loaders || []).includes('fabric')));
      const inLock = new Set(lock.mods.map((m) => m.key));
      const stuck = new Set([...plan.errors.filter((e) => inLock.has(e.key) && ['INCOMPATIBLE', 'PRERELEASE_ONLY'].includes(e.code)).map((e) => e.key), ...plan.nextLock.mods.filter((m) => !fits(m)).map((m) => m.key)]);
      if (stuck.size) {
        const names = lock.mods.filter((m) => stuck.has(m.key)).map((m) => m.name);
        plan = await planChanges({ lock: base, request: { ...request, remove: [...new Set([...(request.remove || []), ...stuck])] }, providers });
        plan.warnings.unshift({ code: 'DROPPED', message: `Нет версий для ${LOADER_LABEL[base.loader] || base.loader} ${base.minecraft}, поэтому будут убраны: ${names.join(', ')}. Их можно вернуть откатом.` });
      }
    }
    // значительное изменение: смена версии игры/загрузчика или удаление модов — перед ним копии миров
    plan.significant = !!(request.retarget || plan.changes.some((c) => c.type === 'remove'));
    const id = crypto.randomBytes(8).toString('hex');
    this.plans.set(id, { pid, plan });
    if (this.plans.size > 20) this.plans.delete(this.plans.keys().next().value);
    return Services.visible(plan, id);
  }

  /** Описание плана для интерфейса: без nextLock (адреса файлов и состав остаются в главном процессе). */
  static visible(plan, planId) {
    const { nextLock, ...visible } = plan;
    return { planId, ...visible, nextMinecraft: nextLock.minecraft, nextLoader: nextLock.loader, sizeBytes: nextLock.mods.filter((m) => plan.changes.some((c) => c.key === m.key && c.type !== 'remove')).reduce((a, m) => a + (m.file.size || 0), 0) };
  }

  /** Простой план (только добавления, без ошибок, вопросов, ручных файлов и предупреждений) применяется без подтверждения. */
  static isSimple(plan) {
    return plan.ok && !plan.significant && !plan.errors.length && !(plan.questions || []).length && !(plan.manual || []).length && !(plan.warnings || []).length && plan.changes.every((c) => c.type === 'add');
  }

  /** «Установить» из каталога: подходящий релиз и зависимости подбираются сами; подтверждение — только при сложностях. */
  async install(pid, item) {
    const plan = await this.planMods(pid, { add: [item] });
    if (!Services.isSimple(plan)) return { applied: false, plan };
    const r = await this.applyPlan(plan.planId);
    return { applied: true, plan, lock: r.lock, missing: r.missing };
  }

  async applyPlan(planId, imports = {}) {
    const rec = this.plans.get(planId);
    if (!rec) throw new Error('План устарел — построй его заново.');
    const ac = new AbortController();
    this.modsAbort = ac;
    try {
      let backups = [];
      if (rec.plan.significant) backups = await this.backupAllWorlds(rec.pid, 'before-mods', 'Перед изменением сборки');
      const lock = await this.installer.apply(rec.pid, rec.plan, { signal: ac.signal, imports, onProgress: (p) => this.emit('mods-progress', p) });
      this.plans.delete(planId);
      await this.refreshRoom(rec.pid);
      // связи по файлам: каталог мог не знать об обязательной библиотеке — говорим сразу, а не при вылете
      const links = await this.linkReport(rec.pid).catch(() => null);
      return { lock, backups, missing: links?.missing || [] };
    } finally {
      this.modsAbort = null;
    }
  }
  cancelMods() {
    this.modsAbort?.abort();
  }

  async backupAllWorlds(pid, reason, reasonText) {
    const out = [];
    for (const w of await this.worlds.list(pid)) {
      const b = await this.worlds.backup(pid, w.folder, { reason, reasonText, server: this.launcher.server });
      if (b) out.push({ folder: w.folder, name: w.name, id: b.id });
    }
    return out;
  }

  async setModEnabled(pid, key, on) {
    const profile = await this.store.getProfile(pid);
    if (profile.kind === 'room') throw new Error('Состав сборки друга менять нельзя.');
    const r = await this.installer.setEnabled(pid, key, on);
    await this.refreshRoom(pid);
    return r;
  }
  async setModPinned(pid, key, pinned) {
    const profile = await this.store.getProfile(pid);
    if (profile.kind === 'room') throw new Error('Состав сборки друга менять нельзя.');
    return this.installer.setPinned(pid, key, pinned);
  }
  async rollbackMods(pid) {
    const profile = await this.store.getProfile(pid);
    if (profile.kind === 'room') throw new Error('Состав сборки друга меняется только хозяином.');
    await this.backupAllWorlds(pid, 'before-rollback', 'Перед откатом сборки');
    const lock = await this.installer.rollback(pid);
    await this.refreshRoom(pid);
    return lock;
  }
  async refreshRoom(pid) {
    if (this.host && this.host.profileId === pid) {
      const lock = await this.store.getLock(pid);
      await this.host.updateManifest(lockLib.roomManifest(lock, { name: this.host.worldName, offlineGuests: this.host.offlineGuests === true })).catch(() => {});
    }
  }

  // ---------- с друзьями: хозяин ----------
  /**
   * Сессия: сервер на этом ПК открывает мир сборки (или создаёт новый), затем — комната для приглашений,
   * если настроен сервер easyLauncher. req: {profileId, folder?, create?, eula?, offlineGuests?}.
   */
  async startCoop(req, auth) {
    const settings = await this.settings();
    this.coopHostName = auth?.name || null; // в истории сессий хозяин не считается «другом»
    this.rememberMe(auth);
    const profile = await this.store.getProfile(req.profileId);
    if (profile.kind === 'room') throw new Error('Открыть сервер из чужой сборки нельзя. Попроси хозяина снова прислать приглашение.');
    this.assertNotInstalling(profile.id);
    const budget = this.memoryBudget('host', settings, profile);
    if (req.eula === true && !settings.eula) await this.saveSettings({ eula: true });
    await this.ai.stop();
    const r = await this.launcher.startSession({
      profileId: profile.id,
      folder: req.folder || null,
      create: req.folder ? null : req.create || { name: 'Мир с друзьями' },
      auth,
      eula: settings.eula || req.eula === true,
      serverRam: budget.server,
      options: settings.options,
      players: req.players,
      offlineGuests: req.offlineGuests === true,
    });
    let room = null;
    let roomError = null;
    if (settings.invites) {
      try {
        room = await this.openRoom(auth, profile.id, r.folder, { offlineGuests: req.offlineGuests === true });
      } catch (e) {
        roomError = e.message;
      }
    }
    return { ...r, room, roomError, backend: !!settings.invites };
  }

  /** Платформа EOS — одна на лаунчер, создаётся при первой игре с друзьями (вход по устройству — в start()). */
  eos(name) {
    if (!this.eosFactory) return null;
    if (!this.eosPlatform) this.eosPlatform = this.eosFactory(name);
    return this.eosPlatform;
  }

  async openRoom(auth, pid, folder, opts = {}) {
    const s = await this.settings();
    if (!s.invites) throw Object.assign(new Error('Приглашения через интернет в этой сборке лаунчера не настроены. Друзья в той же сети могут подключиться по локальному адресу.'), { code: 'NO_BACKEND' });
    const st = this.launcher.status();
    if (st.server !== 'running') throw new Error('Сначала запусти сессию.');
    if (this.host) return this.host.state('online');
    const name = (await this.worlds.list(pid)).find((w) => w.folder === folder)?.name || folder;
    const lock = await this.store.getLock(pid);
    const offlineGuests = opts.offlineGuests === true || this.launcher.lastSession?.offlineGuests === true;
    const hostName = auth?.name || s.nickname || '';
    const onGuest = async (guestName) => {
      if (this.launcher.server.state !== 'running') return 'Сервер хозяина сейчас не запущен.';
      // под ником хозяина друг зашёл бы с его правами и вещами (в сессии «без Microsoft» ник не проверяется)
      if (hostName && String(guestName).toLowerCase() === hostName.toLowerCase()) return 'Это ник хозяина сессии — выбери в настройках другой ник.';
      await this.launcher.allowPlayer(guestName);
      return true;
    };
    let host;
    if (s.invites === 'eos') host = new EosHostSession({ platform: this.eos(auth?.name || s.nickname), targetPort: st.port, onGuest });
    else {
      const transports = [new RelayHost()];
      if (this.rtc) transports.unshift(new this.rtc.RtcHost(this.rtc.engine));
      host = new HostSession({ backend: s.backend, transports, targetPort: st.port, onGuest });
    }
    host.worldName = name;
    host.profileId = pid;
    host.offlineGuests = offlineGuests;
    host.on('state', (state) => this.emit('room', state));
    // голосовой чат: узел у хозяина, голосовые потоки гостей приходят по тому же соединению
    const hub = new VoiceHub(auth?.name || s.nickname);
    host.on('voice-stream', (stream, guestName) => hub.addStream(stream, guestName));
    hub.on('audio', (a) => this.emit('voice', { type: 'audio', from: a.from, seq: a.seq, data: a.data }));
    // объёмный звук: пока в голосе двое и больше — сервер сессии сообщает, где стоят игроки (1.13+)
    const pos = new PositionTracker(this.launcher.server);
    pos.on('positions', (p) => {
      hub.sendPositions(p);
      this.emit('voice', { type: 'positions', players: p });
    });
    hub.on('roster', (r) => {
      this.emit('voice', { type: 'roster', roster: r, joined: hub.hostOn });
      if (r.length >= 2 && indicatorSupport(lock.minecraft).spatial) pos.start();
      else pos.stop();
    });
    host.voicePos = pos;
    // кто говорит — значок у ника в самой игре (сервер сессии на этом ПК) и подсветка в окне
    hub.on('speaking', (e) => {
      this.emit('voice', { type: 'speaking', name: e.name, on: e.on });
      this.voiceInGame(e.name, e.on).catch(() => {});
    });
    host.voice = hub;
    await host.open({ name, manifest: lockLib.roomManifest(lock, { name, offlineGuests }), hostName: auth?.name || s.nickname });
    this.host = host;
    // состояние ещё раз — уже когда комната записана: окно узнаёт, что голосовой чат доступен
    // (события во время open() приходят раньше, и через EOS других событий до прихода друга нет)
    this.emit('room', host.state('online'));
    return host.state('online');
  }

  // ---------- голосовой чат в сессии с друзьями ----------
  /** Кто в голосовом чате и можно ли войти: хозяин — когда открыта комната, гость — когда подключён. */
  voiceStatus() {
    if (this.host?.voice) return { available: true, role: 'host', me: this.host.voice.hostName, joined: this.host.voice.hostOn, roster: this.host.voice.roster(), test: !!this.launcher.testClient };
    const g = this.guest;
    if (g?.connected) return { available: true, role: 'guest', me: g.playerName, joined: !!g.voice, roster: g.voiceRoster || [] };
    return { available: false, role: null, joined: false, roster: [] };
  }
  async voiceJoin() {
    if (this.host?.voice) {
      this.host.voice.setHost(true);
      return this.voiceStatus();
    }
    const g = this.guest;
    if (!g?.connected) throw new Error('Голосовой чат работает в сессии с друзьями — сначала подключись.');
    if (!g.voice) {
      const v = await g.session.openVoice(g.playerName);
      g.voice = v;
      v.on('audio', (a) => this.emit('voice', { type: 'audio', from: a.from, seq: a.seq, data: a.data }));
      v.on('positions', (p) => this.emit('voice', { type: 'positions', players: p }));
      v.on('roster', (r) => {
        g.voiceRoster = r;
        this.emit('voice', { type: 'roster', roster: r, joined: true });
      });
      v.on('closed', () => {
        if (g.voice !== v) return;
        g.voice = null;
        g.voiceRoster = [];
        this.emit('voice', { type: 'roster', roster: [], joined: false });
      });
    }
    return this.voiceStatus();
  }
  voiceLeave() {
    if (this.host?.voice) this.host.voice.setHost(false);
    const g = this.guest;
    if (g?.voice) {
      const v = g.voice;
      g.voice = null;
      g.voiceRoster = [];
      v.close();
    }
    this.emit('voice', { type: 'roster', roster: this.host?.voice ? this.host.voice.roster() : [], joined: false });
    return this.voiceStatus();
  }
  /**
   * Значок говорящего в игре — командами сервера сессии (он на ПК хозяина): «♪» у ника в табе и над головой
   * (команда игроков с приставкой, 1.13+) и/или надпись над хотбаром (1.11+). Игроку ничего ставить не нужно.
   */
  async voiceInGame(name, on) {
    this.voiceTalking ||= new Set();
    if (on) this.voiceTalking.add(name);
    else this.voiceTalking.delete(name);
    const srv = this.launcher.server;
    if (!this.host || srv.state !== 'running') return;
    const cfg = (await this.settings()).voice;
    const mc = (await this.store.getLock(this.host.profileId).catch(() => null))?.minecraft;
    const sup = indicatorSupport(mc);
    const run = (cmds) => {
      for (const c of cmds) {
        try {
          srv.command(c);
        } catch {}
      }
    };
    if (cfg.tab && sup.tab) {
      if (!this.voiceTeam) {
        run(voiceCommands.setup());
        this.voiceTeam = true;
      }
      run(voiceCommands.speak(name, on));
    }
    // надпись над хотбаром гаснет сама через ~2 с — пока кто-то говорит, обновляем её
    clearInterval(this.voiceBar);
    this.voiceBar = null;
    if (cfg.actionbar && sup.actionbar && this.voiceTalking.size) {
      const show = () => this.voiceTalking.size && srv.state === 'running' && run(voiceCommands.actionbar([...this.voiceTalking]));
      show();
      this.voiceBar = setInterval(show, 1500);
      this.voiceBar.unref?.();
    }
  }
  /** Сессия закончилась — команда игроков для значка убирается с сервера. */
  voiceInGameOff() {
    clearInterval(this.voiceBar);
    this.voiceBar = null;
    this.voiceTalking?.clear();
    if (this.voiceTeam && this.launcher.server.state === 'running') {
      for (const c of voiceCommands.teardown()) {
        try {
          this.launcher.server.command(c);
        } catch {}
      }
    }
    this.voiceTeam = false;
  }

  /**
   * ВРЕМЕННО — проверка на одном компьютере: второй Minecraft под ником Test_2 заходит на сервер сессии,
   * а в голосовом чате Test_2 повторяет голос хозяина через секунду — видно значок ♪ у второго ника
   * и слышно себя со стороны его персонажа (объёмный звук). Только в сессии «без Microsoft»:
   * у второго игрока нет своего аккаунта.
   */
  async voiceTest(on) {
    const h = this.host;
    const name = 'Test_2';
    if (!on) {
      this.launcher.stopTestClient();
      h?.voice?.removeBot(name);
      return this.voiceStatus();
    }
    if (!h?.voice) throw new Error('Сначала открой комнату для друзей («Пригласить друзей») — проверка идёт через неё.');
    if (this.launcher.lastSession?.offlineGuests !== true)
      throw new Error('Второй игрок на этом компьютере заходит без аккаунта Microsoft. Заверши сессию и открой её снова с галочкой «Разрешить друзьям без Microsoft» — лучше на новом мире: в этом режиме у игроков другие ID и в старом мире все появятся без вещей.');
    if (h.voice.hostName === name) throw new Error('Твой ник совпадает с ником тестового игрока.');
    await this.launcher.allowPlayer(name);
    const s = await this.settings();
    const proc = await this.launcher.startTestClient({ profileId: h.profileId, name, options: s.options });
    h.voice.addBot(name);
    proc.once('close', () => {
      this.host?.voice?.removeBot(name);
      this.emit('voice', { type: 'test', running: false });
    });
    return this.voiceStatus();
  }

  /** Кадр Opus с микрофона (из окна). */
  voiceSend(buf) {
    if (this.host?.voice) return this.host.voice.hostSend(buf);
    this.guest?.voice?.send(buf);
  }
  async createInvite(opts) {
    if (!this.host) throw new Error('Комната ещё не открыта.');
    return this.host.invite(opts);
  }
  async listInvites() {
    return this.host ? this.host.invites() : [];
  }
  async revokeInvite(id) {
    if (!this.host) return [];
    const names = await this.host.revoke(id);
    for (const n of names) {
      try {
        await this.launcher.removePlayer(n);
      } catch {}
    }
    return names;
  }
  async stopRoom() {
    const h = this.host;
    this.host = null;
    this.launcher.stopTestClient();
    h?.voicePos?.stop();
    h?.voice?.close();
    this.voiceInGameOff();
    await h?.close();
    this.emit('room', null);
  }
  // ---------- админ-панель сервера хозяина ----------
  async adminInfo() {
    return this.admin.info();
  }
  async adminPlayer(action, name, extra) {
    if (action === 'whitelist-add') await this.launcher.allowPlayer(name);
    else if (action === 'whitelist-remove') await this.launcher.removePlayer(name);
    else this.admin.player(action, name, extra);
    // убрали из белого списка — и приглашение этого игрока больше не пустит
    return { ok: true };
  }
  async adminWorld(action, arg) {
    this.admin.world(action, arg);
    return { ok: true };
  }
  async adminProperties(patch) {
    return this.admin.setProperties(patch);
  }
  async adminGamerules() {
    return this.admin.gamerules();
  }
  async adminSetGamerule(rule, v) {
    return this.admin.setGamerule(rule, v);
  }
  /** Перезапуск сервера (тот же мир): настройки server.properties применяются; приглашения остаются. */
  async restartServer() {
    if (this.installer.activePid) throw new Error('Сейчас ставятся моды — перезапусти позже.');
    this.restarting = true;
    try {
      const r = await this.launcher.restartSession();
      if (this.host) this.host.targetPort = r.port;
      this.admin.pendingRestart = new Set();
      return r;
    } finally {
      this.restarting = false;
    }
  }

  /** Завершить сессию: комната закрывается, сервер сохраняет мир и останавливается. */
  async endCoop() {
    await this.stopRoom().catch(() => {});
    await this.launcher.endSession();
  }

  // ---------- с друзьями: гость ----------
  /** «Проверка приглашения»: комната, версия, нужные моды. Отдельная сборка комнаты, личная не меняется. */
  async openInvite(link, auth) {
    const settings = await this.settings();
    const playerName = auth?.name || settings.nickname;
    // без входа ник обязателен сразу: иначе ошибка всплыла бы только после скачивания сборки друга
    if (!auth && !/^[A-Za-z0-9_]{3,16}$/.test(playerName || '')) throw Object.assign(new Error('Чтобы зайти к другу без входа в Microsoft, задай ник в «Настройках»: 3–16 символов, латиница, цифры и _.'), { code: 'AUTH_REQUIRED' });
    const inv = parseInvite(link);
    // чужая ссылка, открытая посреди игры у друга, не должна молча оборвать текущую сессию
    // (только пока игра у друга запущена: если хозяин уже закрыл сессию, новое приглашение открывается как обычно)
    if (this.guest?.connected && this.launcher.client?.mode === 'guest') throw Object.assign(new Error('Ты сейчас в сессии у друга. Чтобы открыть другое приглашение, сначала нажми «Отключиться».'), { code: 'GUEST_ACTIVE' });
    await this.leaveGuest();
    let session;
    if (inv.kind === 'eos') {
      const platform = this.eos(playerName);
      if (!platform) throw new Error('Это приглашение через Epic Online Services, а в этой сборке лаунчера EOS нет. Обнови easyLauncher.');
      session = new EosGuestSession({ platform });
    } else {
      const transports = [new RelayGuest()];
      if (this.rtc) transports.unshift(new this.rtc.RtcGuest(this.rtc.engine));
      session = new GuestSession({ transports });
    }
    session.on('stage', (s) => this.emit('guest-stage', s));
    session.on('revoked', () => this.emit('guest-stage', 'revoked'));
    session.on('host-offline', () => this.emit('guest-stage', 'host-offline'));
    let joined;
    try {
      joined = await session.join(inv.kind === 'eos' ? inv : link, playerName);
    } catch (e) {
      await session.close().catch(() => {});
      throw e;
    }
    const { room, manifest } = joined;
    if (!auth && manifest?.room?.offlineGuests !== true) {
      await session.close().catch(() => {});
      throw Object.assign(new Error('Хозяин принимает только аккаунты Microsoft. Попроси его включить «Разрешить друзей без Microsoft» при запуске сессии.'), { code: 'AUTH_REQUIRED' });
    }
    const roomKey = 'room-' + crypto.createHash('sha256').update(inv.roomId).digest('hex').slice(0, 16);
    let existing = null;
    try {
      existing = await this.store.getLock(roomKey);
    } catch {}
    const compare = existing ? lockLib.compare(manifest, existing) : null;
    this.guest = { session, profileId: roomKey, manifest, room, playerName };
    const required = manifest.mods.filter((m) => m.requiredForGuest);
    const optional = manifest.mods.filter((m) => !m.requiredForGuest);
    return {
      room,
      minecraft: manifest.room.minecraft,
      loader: manifest.room.loader,
      required: required.map((m) => ({ key: m.key, name: m.name, version: m.version, size: m.file.size, manual: !m.file.url })),
      optional: optional.map((m) => ({ key: m.key, name: m.name, version: m.version, size: m.file.size })),
      prepared: !!compare?.ok,
      compare,
      offlineGuests: manifest.room.offlineGuests === true,
      playerName,
    };
  }

  /** «Подготовка»: сборка комнаты по манифесту; личные сборки не трогаются. */
  async prepareGuest(optionalKeys = []) {
    const g = this.guest;
    if (!g) throw new Error('Сначала открой приглашение.');
    const lock = lockLib.lockFromManifest(g.manifest, optionalKeys);
    let exists = true;
    try {
      await this.store.getProfile(g.profileId);
    } catch {
      exists = false;
    }
    const roomData = { name: g.room.name, host: g.room.hostName, lastJoined: new Date().toISOString() };
    if (!exists) await this.store.createProfile({ id: g.profileId, name: `Сборка друга — ${g.room.name}`, minecraft: lock.minecraft, loader: lock.loader, kind: 'room', room: roomData });
    else await this.store.updateProfile(g.profileId, { room: roomData });
    if (this.launcher.profileBusy(g.profileId)) throw new Error('Сборка комнаты сейчас используется.');
    await this.store.saveLock(g.profileId, lock);
    const cmp = lockLib.compare(g.manifest, lock);
    if (!cmp.ok) throw new Error('Сборка не совпадает с комнатой: ' + cmp.errors.join(' '));
    return { profileId: g.profileId, compare: cmp };
  }

  /** «Подключение»: допуск хозяином → транспорт → запуск Minecraft на локальный конец туннеля. */
  async connectGuest(auth) {
    const g = this.guest;
    if (!g) throw new Error('Сначала открой приглашение.');
    await this.ai.stop();
    const conn = await g.session.connect();
    g.route = conn.route;
    g.connected = true; // соединение с хозяином есть — можно и в голосовой чат
    this.emit('guest-stage', 'route-' + conn.route);
    const settings = await this.settings();
    const budget = this.memoryBudget('guest', settings);
    if (!auth && g.manifest.room.offlineGuests !== true) throw Object.assign(new Error('Хозяин не разрешил вход без Microsoft.'), { code: 'AUTH_REQUIRED' });
    await this.launcher.playGuest({ profileId: g.profileId, address: '127.0.0.1:' + conn.port, auth, offlineName: auth ? null : g.playerName, ram: (this.launchRam = budget.client), options: settings.options });
    return { route: conn.route };
  }

  async leaveGuest() {
    const g = this.guest;
    this.guest = null;
    g?.voice?.close();
    await g?.session.close();
  }

  // ---------- помощник (необязателен: всё остальное работает без него) ----------
  assistant() {
    return new Assistant({ llm: this.aiReady ? this.ai : null });
  }
  async aiStatus() {
    const st = await this.ai.status();
    this.aiReady = st.installed;
    return st;
  }

  /**
   * Запрос к помощнику. Помощник сам готовит всё действие целиком — новую сборку, моды, память и
   * графику, починку вылета — и возвращает его описание с task.id. Выполняется оно одной кнопкой
   * (runTask): игрок видит, что будет сделано, до того как что-то изменится.
   */
  async ask(text, pid, answers = null) {
    await this.aiStatus();
    const ans = cleanAnswers(answers);
    const chat = smallTalk(String(text));
    if (chat) return { understoodBy: 'rules', intent: { intent: 'question' }, kind: 'message', message: chat };
    const asst = this.assistant();
    const lock = await this.store.getLock(pid);
    const u = await asst.understand(String(text).slice(0, 4000));
    const intent = u.intent;
    const base = { understoodBy: u.by, rejected: u.rejected || null, intent };
    // текст ошибки (лог, стек) — сразу в диагностику, даже если модель решила иначе
    if (intent.intent === 'diagnose' || diagnoseRules(text).length || LOG_LIKE.test(text)) {
      const d = await asst.diagnose(text);
      const task = d.findings?.length ? await this.fixTask(pid, d.findings).catch(() => null) : null;
      return { ...base, kind: 'diagnose', ...d, task };
    }
    if (intent.intent === 'optimize') return { ...base, ...(await this.optimizeTask(pid, intent)) };
    const wishes = builder.buildWishes(text);
    if (intent.big) wishes.size = 'big';
    // «сделай новую сборку» без темы — тоже сборка (темы по умолчанию)
    if (wishes.wantsNew && intent.intent === 'question') intent.intent = 'build';
    const other = (wishes.minecraft && wishes.minecraft !== lock.minecraft) || (wishes.loader && wishes.loader !== lock.loader);
    let isNew = ['build', 'add'].includes(intent.intent) && (lock.loader === 'vanilla' || (intent.intent === 'build' && (wishes.wantsNew || other)));
    // в сборке уже есть загрузчик — игрок сам выбирает в анкете: ставить моды в неё или собрать новую
    if (isNew && lock.loader !== 'vanilla' && ans?.where === 'current') {
      isNew = false;
      if (!intent.themes.length && !intent.searchTerms.length) intent.themes = ['adventure', 'exploration'];
    }
    if (isNew) {
      // сначала уточняющие вопросы: куда ставить, размер, версия, загрузчик, оптимизация, удобства, шейдеры, настройка ПК
      if (!ans) {
        const p = await this.store.getProfile(pid);
        const current = lock.loader !== 'vanilla' ? { name: p.name, label: `${LOADER_LABEL[lock.loader] || lock.loader} ${lock.minecraft}`, preferNew: /нов|отдельн|с нуля|заново/i.test(text) || !!other } : null;
        return { ...base, kind: 'clarify', text: String(text).slice(0, 4000), questions: await this.buildQuestions(intent, wishes, current) };
      }
      if (ans.size) wishes.size = ans.size;
      if (ans.version) wishes.minecraft = ans.version === 'auto' ? null : ans.version;
      if (ans.loader) wishes.loader = ans.loader === 'auto' ? null : ans.loader;
      if (wishes.minecraft && wishes.loader) {
        const supported = await this.loaderSupport(wishes.loader).catch(() => null);
        if (supported && !supported.includes(wishes.minecraft))
          return { ...base, kind: 'message', message: `${LOADER_LABEL[wishes.loader] || wishes.loader} не выпускался для Minecraft ${wishes.minecraft}. Выбери другой загрузчик или версию игры.` };
      }
      if (ans.visuals && !intent.themes.includes('visuals')) intent.themes = [...intent.themes, 'visuals'];
      if (ans.style && ans.style !== 'surprise') intent.archetype = ans.style;
      const roles = ans.perf === undefined && ans.qol === undefined ? null : [...(ans.perf !== false ? ['performance'] : []), ...(ans.qol !== false ? ['qol'] : [])];
      const result = await this.newBuildTask(intent, wishes, { roles, setup: ans.setup !== false });
      const saved = result.task && this.tasks.get(result.task.id);
      if (saved) saved.retry = { intent: { ...intent, themes: [...intent.themes], avoid: [...intent.avoid], constraints: [...(intent.constraints || [])] }, wishes: { ...wishes }, roles, setup: ans.setup !== false, base };
      return { ...base, ...result };
    }
    if (intent.intent === 'remove') {
      const names = intent.searchTerms.map((t) => t.toLowerCase());
      const keys = lock.mods.filter((m) => names.some((n) => m.name.toLowerCase().includes(n))).map((m) => m.key);
      if (!keys.length) return { ...base, kind: 'message', message: 'Не понял, какой мод убрать. Напиши его название, как в списке модов сборки.' };
      const plan = await this.planMods(pid, { remove: keys });
      const task = plan.ok ? this.saveTask({ pid, planId: plan.planId, baseLock: lock, request: { remove: keys }, steps: plan.changes.map(stepOf) }) : null;
      return { ...base, kind: 'plan', plan, explanation: (await asst.explain(this.plans.get(plan.planId).plan)).text, task };
    }
    if (intent.intent === 'question' || (!intent.themes.length && !intent.searchTerms.length))
      return { ...base, kind: 'message', message: intent.clarify || 'Не понял, что сделать. Напиши, во что хочешь играть: «сделай сборку с зомби и оружием», «добавь приключений без сложной техники», «добавь Create», «подними FPS». Для ошибки — вставь текст из latest.log.' };

    // добавить к текущей сборке; по теме (а не по названиям: «добавь Create» — без вопросов) — сначала уточняющие вопросы
    if (intent.themes.length && !intent.searchTerms.length && !ans) return { ...base, kind: 'clarify', text: String(text).slice(0, 4000), questions: addQuestions(intent) };
    const provider = (await this.providers()).modrinth;
    const size = ans?.amount === 'more' || (!ans?.amount && intent.big) ? 'more' : 'add';
    const roles = ans?.perf || intent.lowEnd ? ['performance'] : [];
    const pick = await builder.pickMods({ intent, target: lock, lock, provider, size, roles });
    if (!pick.add.length) {
      const parts = [];
      if (pick.notFound.length) parts.push(`В каталоге нет модов для ${LOADER_LABEL[lock.loader] || lock.loader} ${lock.minecraft} с названием: ${pick.notFound.join(', ')}.`);
      if (pick.already.length) parts.push(`Уже в сборке: ${pick.already.join(', ')}.`);
      return { ...base, kind: 'message', message: parts.join(' ') || 'В каталоге не нашлось подходящих модов под эту версию игры.', notFound: pick.notFound, already: pick.already };
    }
    await builder.prefetch(provider, pick.add, lock);
    const { plan, items, dropped, request } = await builder.planPruned(this.planner(pid), pick.add);
    const visible = Services.visible(plan, plan.planId);
    const ex = items.length <= 10 ? await asst.explain(plan, { otherNames: [] }) : { text: `Подобрал ${items.length} модов под ${LOADER_LABEL[lock.loader] || lock.loader} ${lock.minecraft}. Совместимость, зависимости и конфликты проверены.`, by: 'template' };
    const steps = plan.changes.map(stepOf);
    // большая добавка — игре может не хватить памяти: поднимаем, если нужно
    const s = await this.settings();
    const budget = this.memoryBudget('play', s, await this.store.getProfile(pid));
    const setup = builder.gameSetup({ totalGb: budget.total, reserveGb: budget.reserve, mods: plan.nextLock.mods.length, lowEnd: intent.lowEnd });
    const ram = setup.ram > budget.client && ans?.setup !== false ? setup.ram : null;
    if (ram) steps.push(`Выделить игре ${ram} ГБ памяти`);
    const task = plan.ok && plan.changes.length ? this.saveTask({ pid, planId: plan.planId, baseLock: lock, request, ram, steps }) : null;
    return { ...base, kind: 'plan', plan: visible, explanation: ex.text, explainedBy: ex.by, notFound: pick.notFound, already: pick.already, dropped: dropped.map(droppedText), task };
  }

  /** План для существующей сборки в форме, нужной отсеву: полный (с nextLock) и с planId. */
  planner(pid) {
    return async (request) => {
      const v = await this.planMods(pid, request);
      return { ...this.plans.get(v.planId).plan, planId: v.planId };
    };
  }

  /** Задание помощника хранится здесь; интерфейс получает только id и список шагов. */
  saveTask(task) {
    const id = crypto.randomBytes(8).toString('hex');
    this.tasks.set(id, task);
    if (this.tasks.size > 20) this.tasks.delete(this.tasks.keys().next().value);
    return { id, steps: task.steps };
  }

  async variantHistory() {
    const list = await readJson(path.join(this.root, 'ai', 'variants.json'));
    return Array.isArray(list) ? list.slice(-40) : [];
  }

  async rememberVariant(v) {
    if (!v) return;
    const file = path.join(this.root, 'ai', 'variants.json');
    const list = await this.variantHistory();
    list.push({ at: new Date().toISOString(), variantId: v.variantId, archetype: v.archetype, themes: v.themes, slugs: v.slugs, applied: true });
    await writeJson(file, list.slice(-40));
  }

  /** Новый безопасный вариант: состав снова строит ядро, окно передаёт только id прежнего задания. */
  async rerollTask(taskId) {
    const old = this.tasks.get(String(taskId));
    if (!old?.retry) throw new Error('Это предложение устарело — попроси помощника ещё раз.');
    const x = old.retry;
    const result = await this.newBuildTask(x.intent, x.wishes, { roles: x.roles, setup: x.setup, variantId: crypto.randomBytes(4).toString('hex').toUpperCase() });
    const saved = result.task && this.tasks.get(result.task.id);
    if (saved) {
      saved.retry = x;
      this.tasks.delete(String(taskId));
    }
    return { ...x.base, ...result };
  }

  /**
   * Уточняющие вопросы перед сборкой; ответы по умолчанию — из того, что игрок уже написал.
   * current — выбранная сборка с загрузчиком: тогда первый вопрос «куда ставить моды», а вопросы
   * только для новой сборки (only: 'new') или только для текущей (only: 'current') окно показывает по ответу.
   */
  async buildQuestions(intent, wishes, current = null) {
    let latest = null;
    let releases = [];
    try {
      releases = (await this.launcher.versions()).filter((v) => v.type === 'release').map((v) => v.id);
      latest = releases[0] || null;
    } catch {}
    const versions = [...new Set([latest, '1.21.1', '1.20.1', wishes.minecraft].filter(Boolean))];
    // «Другая версия»: все релизы до 1.7.10 — ниже модов под загрузчики почти нет
    const oldest = releases.indexOf('1.7.10');
    const more = (oldest >= 0 ? releases.slice(0, oldest + 1) : releases).filter((v) => !versions.includes(v));
    const loaderIds = ['fabric', 'quilt', 'forge', 'neoforge'];
    const support = {};
    await Promise.all(loaderIds.map(async (loader) => {
      const list = await this.loaderSupport(loader).catch(() => null);
      support[loader] = list ? new Set(list) : null;
    }));
    const hasSupport = loaderIds.some((loader) => support[loader]);
    const allowedByVersion = hasSupport
      ? Object.fromEntries([...versions, ...more].map((version) => [version, loaderIds.filter((loader) => !support[loader] || support[loader].has(version))]))
      : null;
    const yes = (v) => [
      { value: true, label: 'Да' },
      { value: false, label: 'Нет' },
    ].map((o) => ({ ...o, selected: o.value === v }));
    const q = (id, title, hint, options, value, only) => ({ id, title, hint, only: current ? only || null : null, options: options.map((o) => ('selected' in o ? o : { ...o, selected: o.value === value })) });
    // для самых свежих версий модов ещё мало — говорим об этом прямо в варианте
    const vLabel = (v) => (['1.21.1', '1.20.1'].includes(v) ? v : v === latest ? `${v} (новая — модов пока мало)` : v);
    return [
      ...(current ? [q('where', 'Куда ставить моды', `Сейчас выбрана сборка «${current.name}» (${current.label})`, [{ value: 'current', label: `В «${current.name}»` }, { value: 'new', label: 'В новую сборку' }], current.preferNew ? 'new' : 'current')] : []),
      q('amount', 'Сколько модов добавить', '', [{ value: 'few', label: 'Немного (до 8)' }, { value: 'more', label: 'Побольше (до 20)' }], wishes.size === 'big' ? 'more' : 'few', 'current'),
      q('size', 'Размер сборки', 'Чем больше модов, тем дольше первый запуск и тем больше нужно памяти', [{ value: 'small', label: 'Маленькая (до 15 модов)' }, { value: 'normal', label: 'Обычная (до 35)' }, { value: 'big', label: 'Большая (до 70)' }], wishes.size, 'new'),
      { ...q('version', 'Версия Minecraft', 'Под 1.21.1 и 1.20.1 модов больше всего', [{ value: 'auto', label: 'Подбери сам' }, ...versions.map((v) => ({ value: v, label: vLabel(v) }))], wishes.minecraft || 'auto', 'new'), more },
      { ...q('loader', 'Загрузчик модов', 'Показываются только загрузчики, которые выходили для выбранной версии игры', [{ value: 'auto', label: 'Подбери сам' }, { value: 'fabric', label: 'Fabric' }, { value: 'quilt', label: 'Quilt' }, { value: 'forge', label: 'Forge' }, { value: 'neoforge', label: 'NeoForge' }], wishes.loader || 'auto', 'new'), ...(allowedByVersion ? { allowedByVersion } : {}) },
      ...(intent.themes.includes('zombies')
        ? [q('style', 'Какой характер сборки', 'Это меняет игровые моды, а не только название', [
            { value: 'surprise', label: 'Удиви меня' },
            { value: 'night_horror', label: 'Хоррор и напряжение' },
            { value: 'base_defense', label: 'Орды и защита базы' },
            { value: 'scarcity', label: 'Реалистичное выживание' },
            { value: 'ruined_world', label: 'Исследование мёртвого мира' },
            { value: 'tactical', label: 'Оружие и сражения' },
          ], intent.archetype && intent.archetype !== 'auto' ? intent.archetype : 'surprise', 'new')]
        : []),
      q('perf', 'Моды оптимизации (больше FPS)', 'Sodium/Embeddium, Lithium, FerriteCore и др. — игра не меняется, только быстрее', yes(true)),
      q('qol', 'Удобства', 'Миникарта, книга рецептов, подсказки о блоках', yes(wishes.size !== 'small'), null, 'new'),
      q('visuals', 'Шейдеры и красивая графика', 'Нужна хорошая видеокарта', yes(intent.themes.includes('visuals')), null, 'new'),
      q('setup', 'Настроить память и графику под мой ПК', 'Сколько памяти дать игре и какую дальность прорисовки поставить', yes(true)),
    ].filter((x) => current || x.id !== 'amount');
  }

  /** Новая сборка: версия и загрузчик под темы, подборка модов, проверенный план, память и графика. */
  async newBuildTask(intent, wishes, { roles = null, setup: doSetup = true, variantId = null } = {}) {
    variantId ||= crypto.randomBytes(4).toString('hex').toUpperCase();
    const provider = (await this.providers()).modrinth;
    const history = await this.variantHistory();
    const recent = history.slice(-8).flatMap((x) => x.slugs || []);
    let releases = [];
    try {
      releases = (await this.launcher.versions()).filter((v) => v.type === 'release').map((v) => v.id);
    } catch {}
    // свежая версия, если под неё уже есть моды; иначе — версии, под которые модов больше всего
    const versions = [releases[0], '1.21.1', '1.20.1'].filter(Boolean);
    let targets;
    try {
      const supported = async (l) => {
        const list = await this.loaderSupport(l);
        return list ? new Set(list) : null;
      };
      targets = await builder.rankTargets({ intent, wishes, provider, versions, supported });
    } catch (e) {
      return { kind: 'message', message: 'Каталог модов сейчас недоступен: ' + e.message + ' Проверь интернет и попробуй ещё раз.' };
    }
    if (!targets.length)
      return { kind: 'message', message: wishes.minecraft ? `Для Minecraft ${wishes.minecraft}${wishes.loader ? ' и ' + (LOADER_LABEL[wishes.loader] || wishes.loader) : ''} я не нашёл подходящих модов. Попробуй 1.21.1 или 1.20.1 — под них модов больше всего.` : 'Каталог модов не ответил — не из чего собирать. Проверь интернет и попробуй ещё раз.' };
    // Каталог указывает версии и загрузчики проекта в целом, а не по релизам: если проверка отсеяла
    // больше четверти подборки — пробуем следующую пару и берём ту, где модов осталось больше
    const providers = await this.providers();
    let best = null;
    for (const target of targets.slice(0, 2)) {
      const lock = emptyLock(target.minecraft, target.loader);
      const pick = await builder.pickMods({ intent, target, lock, provider, size: wishes.size, roles, variantId, recent });
      if (!pick.add.length) continue;
      await builder.prefetch(provider, pick.add, target);
      const r = await builder.planPruned((request) => planChanges({ lock, request, providers }), pick.add);
      if (r.plan.ok && (!best || r.items.length > best.items.length)) best = { target, pick, lock, ...r };
      if (best && best.dropped.length <= best.items.length / 4) break;
    }
    if (!best) return { kind: 'message', message: `Не получилось собрать проверенный набор под ${targets.map((t) => `${LOADER_LABEL[t.loader]} ${t.minecraft}`).slice(0, 2).join(' или ')}. Попробуй другую тему или версию.` };
    const { target, pick, plan, items, dropped, request, lock: baseLock } = best;
    const s = await this.settings();
    const budget = this.memoryBudget('play', s);
    const setup = builder.gameSetup({ totalGb: budget.total, reserveGb: budget.reserve, mods: plan.nextLock.mods.length, lowEnd: intent.lowEnd });
    // общие настройки графики меняем, только если игрок их ещё не задавал или просил про FPS (и не отказался от настройки)
    const options = doSetup && (!s.options || intent.lowEnd || intent.themes.includes('performance')) ? setup.options : null;
    const ram = doSetup ? setup.ram : null;
    const name = pick.concept.id === 'auto' ? builder.buildName(pick.themes.filter((t) => t !== 'visuals' || pick.themes.length === 1)) : pick.concept.title;
    const deps = plan.changes.filter((c) => c.dependencyOf).length;
    const steps = [
      `Создать сборку «${name}»: Minecraft ${target.minecraft}, ${LOADER_LABEL[target.loader]}`,
      `Поставить ${items.length} ${plural(items.length, 'мод', 'мода', 'модов')}${deps ? ` и ${deps} ${plural(deps, 'библиотеку', 'библиотеки', 'библиотек')}, ${deps === 1 ? 'нужную' : 'нужных'} им` : ''}`,
      'Проверить файлы модов: всё ли нужное для запуска на месте',
      ram ? `Выделить игре ${ram} ГБ памяти` : null,
      options ? `Настроить графику: прорисовка ${options.render} чанков, ${options.graphics ? 'детальная' : 'быстрая'} графика, до ${options.fps} FPS` : null,
    ].filter(Boolean);
    const variantLog = { variantId, archetype: pick.concept.id, themes: pick.themes, slugs: items.map((x) => x.slug || x.id) };
    const task = this.saveTask({ pid: null, create: { name, minecraft: target.minecraft, loader: target.loader }, plan, baseLock, request, ram, options, steps, variantLog });
    const groups = [];
    for (const a of items) {
      const title = groupTitle(a.reason);
      const g = groups.find((x) => x.title === title) || groups[groups.push({ title, names: [] }) - 1];
      g.names.push(a.name);
    }
    return {
      kind: 'build',
      build: { name, minecraft: target.minecraft, loader: target.loader, mods: items.length, deps, variantId },
      concept: { title: pick.concept.title, summary: pick.concept.summary, archetype: pick.concept.id, variantId },
      groups,
      plan: Services.visible(plan, null),
      notFound: pick.notFound,
      dropped: dropped.map(droppedText),
      note: wishes.size === 'big' ? 'Большая сборка: каждый мод проверен на версию, зависимости и заявленные авторами конфликты. Первый запуск будет долгим — игра готовит много модов.' : null,
      task,
    };
  }

  /** «Подними FPS»: моды оптимизации, память и графика под этот ПК. */
  async optimizeTask(pid, intent) {
    const lock = await this.store.getLock(pid);
    const s = await this.settings();
    const budget = this.memoryBudget('play', s, await this.store.getProfile(pid));
    const setup = builder.gameSetup({ totalGb: budget.total, reserveGb: budget.reserve, mods: lock.mods.length, lowEnd: intent.lowEnd, fps: true, gpuTier: intent.gpuTier || null });
    let plan = null;
    let request = null;
    if (lock.loader !== 'vanilla') {
      const provider = (await this.providers()).modrinth;
      const pick = await builder.pickMods({ intent: { ...intent, themes: [], searchTerms: [], lowEnd: true }, target: lock, lock, provider, size: 'add' });
      if (pick.add.length) {
        const r = await builder.planPruned(this.planner(pid), pick.add);
        if (r.plan.ok && r.plan.changes.length) ({ plan, request } = r);
      }
    }
    const o = setup.options;
    // память только добавляем: уменьшать то, что игрок выставил сам, ради FPS незачем
    const ram = setup.ram > budget.client ? setup.ram : null;
    const steps = [...(plan ? plan.changes.map(stepOf) : []), ...(ram ? [`Выделить игре ${ram} ГБ памяти`] : []), `Графика: прорисовка ${o.render} чанков, симуляция ${o.simulation}, ${o.graphics ? 'детальная' : 'быстрая'}, до ${o.fps} FPS`];
    const task = this.saveTask({ pid, planId: plan?.planId || null, baseLock: lock, request, ram, options: o, steps });
    return { kind: 'optimize', options: o, ram: ram || budget.client, plan: plan ? Services.visible(plan, plan.planId) : null, note: 'Это стартовые настройки, а не замер. Сравни один и тот же мир до и после.', task };
  }

  /**
   * «Ускорить сборку»: лаунчер узнаёт компьютер (видеокарта, память, ядра) и готовит одно действие —
   * моды оптимизации под эту версию и загрузчик, память и графику под мощность. Выполняется кнопкой (runTask).
   */
  async boostTask(pid, hw) {
    const profile = await this.store.getProfile(pid);
    if (profile.kind === 'room') throw new Error('Сборку друга меняет только хозяин.');
    const hardware = classify({ gpu: hw?.gpu || null, ramGb: Math.round(os.totalmem() / 1024 ** 3), cores: os.cpus().length });
    const intent = { ...ruleIntent('подними fps'), intent: 'optimize', lowEnd: hardware.tier === 'weak', gpuTier: hardware.tier };
    const r = await this.optimizeTask(pid, intent);
    return { ...r, hardware };
  }

  /**
   * Починка по найденным причинам вылета: недостающая зависимость — добавить, несовместимые моды —
   * убрать позже добавленный, сбой Mixin — обновить мод (нет обновления — убрать), мод для другой
   * версии — обновить всё, нехватка памяти — добавить. null — исправить автоматически нечего.
   */
  async fixTask(pid, findings) {
    const lock = await this.store.getLock(pid);
    // зависимости и версии надёжнее проверить по самим файлам модов, чем по словам из журнала
    if (lock.loader !== 'vanilla' && findings.some((f) => /^(missing-dep|wrong-dep|incompatible|mixin-java)/.test(f.id))) {
      const report = await this.linkReport(pid).catch(() => null);
      if (Services.linkProblems(report)) {
        const task = await this.linkFixTask(pid, report).catch(() => null);
        if (task) return task;
      }
    }
    const provider = (await this.providers()).modrinth;
    const norm = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
    const findMod = (name) => lock.mods.find((m) => [m.slug, m.name, m.projectId].some((x) => x && norm(x) === norm(name)));
    const add = [];
    const remove = [];
    let update = [];
    let updateAll = false;
    let mixinKey = null;
    let ram = null;
    for (const f of findings) {
      const d = f.data || {};
      if (f.id.startsWith('missing-dep') && lock.loader !== 'vanilla') {
        const p = await this.findDependency(provider, lock, d.depId, d.depName);
        if (p && !lock.mods.some((m) => m.key === p.key)) add.push({ source: 'modrinth', projectId: p.id });
      } else if (f.id === 'incompatible' && d.a && d.b) {
        // из пары убираем тот, что добавлен в сборку позже
        const pair = [findMod(d.a), findMod(d.b)].filter(Boolean).sort((x, y) => lock.mods.indexOf(y) - lock.mods.indexOf(x));
        if (pair[0]) remove.push(pair[0].key);
      } else if (f.id === 'mixin' && d.modId) {
        const m = findMod(d.modId);
        if (m) update.push((mixinKey = m.key));
      } else if ((f.id === 'wrong-mc' || f.id === 'java-version') && lock.mods.length) updateAll = true;
      else if (f.id === 'oom') {
        const s = await this.settings();
        const budget = this.memoryBudget('play', s, await this.store.getProfile(pid));
        const more = Math.min(budget.client + 2, budget.total - budget.reserve);
        if (more > budget.client) ram = more;
      }
    }
    let plan = null;
    let request = null;
    if (add.length || remove.length || update.length || updateAll) {
      request = { add, remove, update: updateAll ? 'all' : update };
      plan = await this.planMods(pid, request);
      // у мода со сбоем Mixin нет обновления — убираем его
      if (mixinKey && !plan.changes.some((c) => c.key === mixinKey && c.type === 'update')) {
        update = update.filter((k) => k !== mixinKey);
        request = { add, remove: [...remove, mixinKey], update: updateAll ? 'all' : update };
        plan = await this.planMods(pid, request);
      }
      if (!plan.ok || !plan.changes.length) plan = null;
    }
    if (!plan && !ram) return null;
    const steps = [...(plan ? plan.changes.map(stepOf) : []), ...(ram ? [`Выделить игре ${ram} ГБ памяти`] : [])];
    return { ...this.saveTask({ pid, planId: plan?.planId || null, baseLock: lock, request: plan ? request : null, ram, steps }), significant: !!plan?.significant };
  }

  /** Недостающая зависимость по id мода из журнала (обычно совпадает со slug Modrinth) или по названию. */
  async findDependency(provider, lock, depId, depName) {
    const ALIAS = { fabric: 'fabric-api', 'cloth-config2': 'cloth-config', cloth_config: 'cloth-config', architectury: 'architectury-api', geckolib3: 'geckolib' };
    if (['minecraft', 'java', 'fabricloader', 'forge', 'neoforge', 'quilt_loader'].includes(depId)) return null;
    for (const slug of [...new Set([ALIAS[depId] || depId, depId && depId.replace(/_/g, '-')])].filter(Boolean)) {
      try {
        const p = await provider.project(slug);
        if (builder.fits(p, lock)) return p;
      } catch {}
    }
    // по названию или по id без разделителей: puzzleslib → «Puzzles Lib» (slug puzzles-lib)
    const n = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
    for (const q of [...new Set([depName, depId].filter(Boolean))]) {
      try {
        const hits = (await provider.search({ query: q, minecraft: lock.minecraft, loader: lock.loader, limit: 10 })).hits;
        const hit = hits.find((h) => [h.name, h.slug].some((x) => n(x) === n(depName) || n(x) === n(depId)));
        if (hit) return hit;
      } catch {}
    }
    return null;
  }

  /**
   * Обязательная библиотека по id мода из его файла: сначала Modrinth, затем CurseForge (часть библиотек
   * есть только там). Версия — стабильный релиз, иначе тестовый (лучше, чем вылет); файл должен
   * скачиваться автоматически. → { source, project, version } или null.
   */
  async findLibrary(providers, lock, id) {
    const target = { minecraft: lock.minecraft, loader: lock.loader };
    const pick = async (source, p) => {
      if (!p) return null;
      const vs = await providers[source].versions(p.id, target).catch(() => []);
      vs.sort((a, b) => String(b.published).localeCompare(String(a.published)));
      const v = vs.find((x) => x.type === 'release') || vs[0];
      const f = v && (v.files.find((x) => x.primary) || v.files[0]);
      return f?.url ? { source, project: p, version: v } : null;
    };
    const mr = await pick('modrinth', await this.findDependency(providers.modrinth, lock, id, null));
    if (mr || !providers.curseforge?.status().available) return mr;
    const n = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
    try {
      const hits = (await providers.curseforge.search({ query: id, minecraft: lock.minecraft, loader: lock.loader, limit: 10 })).hits;
      return await pick('curseforge', hits.find((h) => [h.name, h.slug].some((x) => n(x) === n(id))));
    } catch {
      return null;
    }
  }

  /** Файлы модов для проверки связей: состав сборки (из кэша) и свои JAR игрока из папки mods. */
  linkEntries(lock, pid = null) {
    const cache = this.launcher.cache;
    // мод только для выделенного сервера в папку игры не попадает: на него в игре рассчитывать нельзя
    const entries = lock.mods.filter((m) => m.enabled !== false && cache.has(m.file)).map((m) => ({ name: m.name, key: m.key, file: cache.pathFor(m.file), offGame: !lockLib.inGame(m) }));
    if (pid) {
      const dir = path.join(this.store.gameDir(pid), 'mods');
      let managed = [];
      try {
        managed = JSON.parse(fs.readFileSync(path.join(dir, '.easylauncher-managed.json'), 'utf8')).files || [];
      } catch {}
      let files = [];
      try {
        files = fs.readdirSync(dir).filter((f) => /\.jar$/i.test(f) && !managed.includes(f));
      } catch {}
      // файл, положенный игроком вручную: что он даёт — учитываем, его требования исправить не можем
      for (const f of files) entries.push({ name: f, file: path.join(dir, f), providerOnly: true });
    }
    return entries;
  }

  /** Проверка связей модов сборки по файлам: каких обязательных модов не хватает. */
  async linkReport(pid) {
    const lock = await this.store.getLock(pid);
    const none = { missing: [], conflicts: [], wrong: [], java: [] };
    if (lock.loader === 'vanilla') return none;
    const on = lock.mods.filter((m) => m.enabled !== false);
    if (on.some((m) => !this.launcher.cache.has(m.file))) await this.fetchFiles(on).catch(() => {});
    // без всех файлов сравнивать нечестно: не скачанный мод выглядел бы «недостающим»
    if (on.some((m) => !this.launcher.cache.has(m.file))) return none;
    return checkLinks(this.linkEntries(lock, pid), lock.loader, lock.minecraft);
  }

  /** Есть ли в отчёте то, из-за чего игра не запустится. */
  static linkProblems(report) {
    return !!report && (report.missing.length > 0 || (report.wrong || []).some((w) => w.provider.key || w.nested) || report.conflicts.some((c) => c.aKey || c.bKey) || (report.java || []).length > 0);
  }

  /** Текст для игрока: чего не хватает и что не той версии. */
  static linkText(report) {
    const parts = [
      ...report.missing.map((m) => `«${m.by.map((b) => b.name).join('», «')}» требует «${m.id}»`),
      ...(report.wrong || []).map((w) => `«${w.by.map((b) => b.name).join('», «')}» требует ${w.provider.name} ${w.needText}, а стоит ${w.have}`),
      ...report.conflicts.map((c) => `«${c.a}» несовместим с «${c.b}»${c.have ? ` ${c.have}` : ''}`),
      ...(report.java || []).map((j) => `«${j.name}» требует Java ${j.need}, а Minecraft этой версии работает на Java ${j.have}`),
    ];
    return parts.join('; ');
  }

  /**
   * Версия мода из каталога, которая подходит под диапазон из файла другого мода (Iris требует Sodium 0.6.x).
   * Номер версии Modrinth не равен версии в файле (mc1.21.1-0.6.13-fabric), поэтому сверяем числа из номера;
   * итог всё равно проверяется по скачанному файлу. → версия каталога или null.
   */
  async versionFor(providers, lock, key, range, tried) {
    const i = String(key || '').indexOf(':');
    const source = key.slice(0, i);
    if (!providers[source]) return null;
    const target = { minecraft: lock.minecraft, loader: lock.loader };
    const vs = (await providers[source].versions(key.slice(i + 1), target).catch(() => [])).filter((v) => compatible(v, target) && !tried.has(v.id) && v.files?.some((f) => f.url));
    vs.sort((a, b) => String(b.published).localeCompare(String(a.published)));
    const fits = (v) =>
      String(v.number || '')
        .split(/[\s_+-]+/)
        .map((t) => t.replace(/^(?:mc|v)/i, ''))
        .some((t) => /^\d+(\.\d+)+$/.test(t) && !(v.minecraft || []).includes(t) && satisfies(range, t));
    return vs.find((v) => v.type === 'release' && fits(v)) || vs.find(fits) || null;
  }

  /**
   * Что поменять в составе по отчёту проверки файлов: недостающее — найти в каталоге, не та версия —
   * подобрать подходящую, несовместимые — убрать один из пары. Не нашлось — убрать мод, которому это нужно.
   * → { add: [запросы], drop: Set(ключей), added: [названия], changed: [описания] }
   */
  async linkActions(providers, lock, report, tried) {
    const add = [];
    const drop = new Set();
    const added = [];
    const changed = [];
    const has = (key) => add.some((a) => lockLib.keyOf(a.source, a.projectId) === key);
    for (const j of report.java || []) if (j.key) drop.add(j.key);
    for (const miss of report.missing) {
      const lib = await this.findLibrary(providers, lock, miss.id);
      const key = lib && lockLib.keyOf(lib.source, lib.project.id);
      if (lib && !lock.mods.some((m) => m.key === key) && !has(key)) {
        add.push({ source: lib.source, projectId: String(lib.project.id), versionId: lib.version.id });
        added.push(`${lib.project.name}${lib.version.type === 'release' ? '' : ` (тестовая версия ${lib.version.number} — другой нет)`}${lib.source === 'curseforge' ? ' с CurseForge' : ''}`);
      } else for (const b of miss.by) if (b.key) drop.add(b.key);
    }
    for (const w of report.wrong || []) {
      if (w.nested && !tried.has('id:' + w.id)) {
        // подходящая версия есть только внутри другого мода — ставим библиотеку отдельно (Fabric возьмёт новую)
        tried.add('id:' + w.id);
        const lib = await this.findLibrary(providers, lock, w.id);
        const key = lib && lockLib.keyOf(lib.source, lib.project.id);
        if (lib && !lock.mods.some((m) => m.key === key) && !has(key)) {
          add.push({ source: lib.source, projectId: String(lib.project.id), versionId: lib.version.id });
          changed.push(`${lib.project.name} ${lib.version.number} — нужна новее встроенной (${w.have}) для ${w.by.map((b) => b.name).join(', ')}`);
        } else for (const b of w.by) if (b.key) drop.add(b.key);
        continue;
      }
      if (w.nested) {
        for (const b of w.by) if (b.key) drop.add(b.key);
        continue;
      }
      if (!w.provider.key || has(w.provider.key)) continue;
      // версию этого мода уже подбирали под другой мод — второй раз не перебиваем, убираем требующего
      const v = tried.has('key:' + w.provider.key) ? null : await this.versionFor(providers, lock, w.provider.key, w.need, tried);
      if (v) {
        tried.add(v.id);
        tried.add('key:' + w.provider.key);
        const i = w.provider.key.indexOf(':');
        add.push({ source: w.provider.key.slice(0, i), projectId: w.provider.key.slice(i + 1), versionId: v.id });
        changed.push(`${w.provider.name} ${v.number} — эту версию требует ${w.by.map((b) => b.name).join(', ')}`);
      } else for (const b of w.by) if (b.key) drop.add(b.key);
    }
    // несовместимость разбираем, когда версии уже подобраны: часто её снимает смена версии
    if (!add.length && !drop.size) {
      const inBase = new Set(lock.mods.filter((m) => m.addedBy === 'user').map((m) => m.key));
      for (const c of report.conflicts) {
        // убираем того, кого «не терпят»; если его выбрал сам игрок, а второй — нет, убираем второго
        const k = c.bKey && !(inBase.has(c.bKey) && c.aKey && !inBase.has(c.aKey)) ? c.bKey : c.aKey || c.bKey;
        if (k) drop.add(k);
      }
    }
    return { add, drop, added, changed };
  }

  /** Скачать файлы модов в общий кэш (установка потом возьмёт их оттуда) — с прогрессом, как у установки. */
  async fetchFiles(mods) {
    const cache = this.launcher.cache;
    const todo = mods.filter((m) => m.file?.url && !cache.has(m.file));
    const total = todo.reduce((a, m) => a + (m.file.size || 0), 0);
    let done = 0;
    for (const m of todo) {
      await cache.ensure(m, {
        onBytes: (b) => {
          done += b;
          this.emit('mods-progress', { phase: 'download', done, total, name: m.name });
        },
      });
    }
  }

  /**
   * Проверка связей перед установкой задания помощника: скачанные файлы читаются, недостающий
   * обязательный мод ищется в каталоге и добавляется; не нашёлся — убирается мод, которому он нужен.
   * → { plan, added: [названия], removed: [названия] }
   */
  async resolveLinks(t, plan) {
    const providers = await this.providers();
    const base = t.baseLock;
    let request = { ...t.request };
    const added = [];
    const removed = [];
    const changed = [];
    const tried = new Set();
    const names = new Map(plan.nextLock.mods.map((m) => [m.key, m.name]));
    const dropAdds = (keys) => {
      for (const k of keys) if (names.has(k) && !removed.includes(names.get(k))) removed.push(names.get(k));
      request = { ...request, add: (request.add || []).filter((a) => !keys.has(lockLib.keyOf(a.source, a.projectId))) };
    };
    for (let round = 0; round < 6; round++) {
      if (!plan.ok) {
        // после добавления библиотеки план не сошёлся (например, её нет под эту версию) — убираем виновный мод
        const explicit = new Map((request.add || []).map((a) => [lockLib.keyOf(a.source, a.projectId), a]));
        const bad = new Set(plan.errors.flatMap((e) => builder.culprits(plan, e, explicit)));
        if (!bad.size) throw new Error('После проверки файлов модов план не сходится: ' + plan.errors.map((e) => e.message).slice(0, 2).join(' '));
        dropAdds(bad);
        plan = await planChanges({ lock: base, request, providers });
        continue;
      }
      await this.fetchFiles(plan.nextLock.mods.filter((m) => m.enabled !== false));
      const report = checkLinks(this.linkEntries(plan.nextLock, t.pid), plan.nextLock.loader, plan.nextLock.minecraft);
      if (!Services.linkProblems(report)) break;
      const act = await this.linkActions(providers, plan.nextLock, report, tried);
      const { add, drop } = act;
      added.push(...act.added);
      changed.push(...act.changed);
      if (!add.length && !drop.size) break;
      const addKeys = new Set(add.map((a) => lockLib.keyOf(a.source, a.projectId)));
      // убрать мод — значит убрать и те, кому он обязательно нужен
      const mods = plan.nextLock.mods;
      let grew = true;
      while (grew) {
        grew = false;
        for (const m of mods) {
          if (drop.has(m.key) || !(m.dependencies || []).some((d) => d.kind === 'required' && drop.has(d.key))) continue;
          drop.add(m.key);
          grew = true;
        }
      }
      for (const k of drop) {
        const m = mods.find((x) => x.key === k);
        if (m && m.addedBy !== 'dependency' && !removed.includes(m.name)) removed.push(m.name);
      }
      const inBase = new Set(base.mods.map((m) => m.key));
      request = {
        ...request,
        // запрос той же сборки с конкретной версией заменяет прежний «последний релиз»
        add: [...(request.add || []).filter((a) => !drop.has(lockLib.keyOf(a.source, a.projectId)) && !addKeys.has(lockLib.keyOf(a.source, a.projectId))), ...add],
        remove: [...new Set([...(request.remove || []), ...[...drop].filter((k) => inBase.has(k))])],
      };
      plan = await planChanges({ lock: base, request, providers });
      plan.significant = plan.changes.some((c) => c.type === 'remove');
    }
    if (!plan.ok) throw new Error('После проверки файлов модов план не сходится: ' + plan.errors.map((e) => e.message).slice(0, 2).join(' '));
    return { plan, added, removed, changed };
  }

  /** Задание «исправить связи» для сборки: добавить недостающие обязательные моды из каталога, иначе убрать требующий. */
  async linkFixTask(pid, report) {
    const lock = await this.store.getLock(pid);
    const providers = await this.providers();
    const { add, drop } = await this.linkActions(providers, lock, report, new Set());
    if (!add.length && !drop.size) return null;
    const request = { add, remove: [...drop] };
    const plan = await this.planMods(pid, request);
    if (!plan.ok || !plan.changes.length) return null;
    return { ...this.saveTask({ pid, planId: plan.planId, baseLock: lock, request, steps: plan.changes.map(stepOf) }), significant: !!plan.significant };
  }

  /**
   * Выполнить задание помощника: создать сборку, поставить моды (с проверкой файлов и откатом при сбое),
   * выставить память и графику. Сбой после создания сборки — повтор продолжит в ту же сборку.
   */
  async runTask(taskId) {
    const t = this.tasks.get(String(taskId));
    if (!t) throw new Error('Это предложение устарело — попроси помощника ещё раз.');
    if (this.runningTask) throw new Error('Помощник уже выполняет задание — дождись окончания.');
    this.runningTask = t;
    try {
      let links = { added: [], removed: [] };
      // проверка связей по самим файлам модов — до создания сборки и до изменения состава
      let plan = t.plan || (t.planId ? this.plans.get(t.planId)?.plan : null);
      if (t.planId && !plan) throw new Error('Это предложение устарело — попроси помощника ещё раз.');
      if (plan && t.request && t.baseLock && !t.linksChecked) {
        links = await this.resolveLinks(t, plan);
        plan = links.plan;
        t.linksChecked = true;
        t.plan = plan;
        t.planId = null;
      }
      if (t.create) {
        const p = await this.createProfile(t.create);
        t.pid = p.id;
        t.created = true;
        t.create = null;
      }
      let backups = [];
      if (plan && plan.changes.length) {
        if (!t.planId) {
          t.planId = crypto.randomBytes(8).toString('hex');
          this.plans.set(t.planId, { pid: t.pid, plan });
        }
        backups = (await this.applyPlan(t.planId)).backups;
        t.planId = null;
        t.plan = null;
      }
      if (t.ram) await this.updateProfile(t.pid, { ram: t.ram });
      if (t.options) await this.saveSettings({ options: t.options });
      await this.saveSettings({ lastProfile: t.pid });
      await this.rememberVariant(t.variantLog);
      this.tasks.delete(String(taskId));
      return { profileId: t.pid, created: !!t.created, backups, linksAdded: links.added || [], linksRemoved: links.removed || [], linksChanged: links.changed || [] };
    } finally {
      this.runningTask = null;
    }
  }

  async shutdown() {
    this.memories.gameStopped();
    await this.stopRoom().catch(() => {});
    await this.leaveGuest().catch(() => {});
    await this.ai.stop();
    await this.launcher.shutdown();
    this.eosPlatform?.stop();
  }
}

module.exports = { parseNews, Services };
