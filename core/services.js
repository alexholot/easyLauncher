'use strict';
// Слой сервисов главного процесса: сборки, их миры, запуск, каталог модов, игра с друзьями и помощник.
// Не зависит от Electron (кроме необязательного движка WebRTC), поэтому проверяется в Node.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { Launcher } = require('./launcher');
const loaders = require('./loaders');
const LOADER_LABEL = loaders.LABELS;
const { ModInstaller } = require('./modinstall');
const { planChanges, modState } = require('./modplan');
const { latestScreenshot } = require('./worlds');
const { PlayLog } = require('./playlog');
const http = require('./http');
const { ModrinthProvider } = require('./catalog/modrinth');
const { CurseForgeProvider } = require('./catalog/curseforge');
const lockLib = require('./lock');
const { readJson, writeJson, emptyLock } = require('./store');
const { HostSession, GuestSession, parseInvite } = require('./net/session');
const { RelayHost, RelayGuest } = require('./net/relay');
const { AiManager } = require('./ai/manager');
const { Assistant, smallTalk } = require('./ai/assistant');
const { diagnose: diagnoseRules } = require('./ai/diagnose');
const builder = require('./ai/builder');
const { checkLinks } = require('./modlinks');
const { DEFAULTS } = require('./defaults');

const GiB = 1024 ** 3;

/** Внешний вид лаунчера: только известные значения, остальное — по умолчанию. */
const APPEARANCE = {
  // стиль оформления: живой фон и стеклянные панели или строгий минимализм
  style: ['glass', 'aurora', 'neon', 'sunset', 'pixel', 'minimal'],
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
  out.accent = /^#[0-9a-f]{6}$/i.test(a?.accent || '') ? a.accent.toLowerCase() : '#8ec5ff';
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
  return `${c.type === 'add' ? 'Добавить' : c.type === 'update' ? 'Обновить' : 'Убрать'} ${c.name}${c.dependencyOf ? ` (нужен для ${c.dependencyOf})` : ''}`;
}

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
  return builder.THEME_RU[theme] || 'Другое';
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
    this.launcher = opts.launcher || new Launcher(root);
    this.store = this.launcher.store;
    this.worlds = this.launcher.worlds;
    this.installer = new ModInstaller(this.store, this.launcher.cache, { isBusy: (pid) => this.launcher.profileBusy(pid) });
    this.ai = opts.ai || new AiManager(root);
    this.rtc = opts.rtc || null;
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
    this.launcher.on('event', (ev) => {
      this.emit('event', ev);
      this.trackPlay(ev);
      // сервер остановлен — комната закрывается, приглашения перестают работать
      if (ev.type === 'server' && ev.state === 'stopped' && this.host) this.stopRoom().catch(() => {});
      if (ev.type === 'world-session') this.onWorldSession(ev).catch(() => {});
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
    };
  }
  async saveSettings(patch) {
    const cur = (await readJson(this.settingsFile)) || {};
    // только известные поля: настройки не превращаются в склад произвольных данных из интерфейса
    const KNOWN = ['backend', 'cfProxy', 'ram', 'serverRam', 'eula', 'motion', 'lastProfile', 'nickname', 'options', 'offlineOk', 'dim', 'appearance', 'background', 'window', 'jvmArgs', 'javaPath', 'afterLaunch', 'showNews', 'checkUpdates'];
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
    for (const k of ['showNews', 'checkUpdates']) if (patch[k] !== undefined) next[k] = patch[k] !== false;
    if (patch.appearance !== undefined) next.appearance = normalizeAppearance({ ...normalizeAppearance(cur.appearance), ...patch.appearance });
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
    const cover = p.cover && fs.existsSync(p.cover) ? p.cover : null;
    return {
      ...p,
      mods: lock.mods.length,
      modsOff: lock.mods.filter((m) => m.enabled === false).length,
      cover,
      // обложка карточки: закреплённая игроком, иначе последний скриншот этой сборки
      shot: cover ? null : await latestScreenshot(this.store, p.id),
      busy: this.launcher.profileBusy(p.id),
    };
  }

  async overview() {
    const [list, settings] = await Promise.all([this.store.listProfiles(), this.settings()]);
    const profiles = [];
    for (const p of list.filter((x) => x.kind !== 'room')) profiles.push(await this.cardFor(p));
    let selected = settings.lastProfile && profiles.find((p) => p.id === settings.lastProfile) ? settings.lastProfile : profiles[0]?.id || null;
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
    await this.store.getProfile(pid);
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
    const p = await this.createProfile({ name: pack.name, minecraft: pack.minecraft, loader: pack.loader });
    const add = pack.mods
      .filter((m) => ['modrinth', 'curseforge'].includes(m.source) && /^[\w-]{1,64}$/.test(String(m.projectId)))
      .slice(0, 500)
      .map((m) => ({ source: m.source, projectId: String(m.projectId), versionId: m.versionId ? String(m.versionId) : undefined }));
    const plan = add.length ? await this.planMods(p.id, { add }) : null;
    return { profile: p, plan };
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
    return {
      stats: {
        seconds: log.seconds,
        launches: log.launches,
        lastPlayed: profile.lastPlayed || null,
        worlds: worlds.length,
        screenshots: shotsAll.length,
        mods: lock.mods.length,
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
    return this.worlds.remove(pid, folder, confirmName);
  }

  /**
   * Сессия в одиночном мире закончилась (по журналу клиента). Если имя мира однозначно соответствует
   * одной папке — запоминаем сессию и обновляем незакреплённую обложку последним скриншотом из неё.
   * Неоднозначно — скриншоты остаются только «скриншотами сборки».
   */
  async onWorldSession({ profileId, level, shots }) {
    if (!level) return;
    const matches = (await this.worlds.list(profileId)).filter((w) => w.name === level || w.folder === level);
    if (matches.length !== 1) return;
    const w = matches[0];
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
      if (report?.missing.length) {
        const task = await this.linkFixTask(profile.id, report).catch(() => null);
        const list = report.missing.map((m) => `«${m.by.map((b) => b.name).join('», «')}» требует «${m.id}»`).join('; ');
        throw Object.assign(new Error(`В сборке не хватает обязательных модов: ${list}. С таким составом игра вылетит при запуске.`), {
          code: 'MISSING_DEPS',
          action: task ? 'Нажми «Исправить» — лаунчер добавит недостающее из каталога или уберёт мод, которому его не хватает.' : 'Добавь недостающий мод в «Моды» или выключи мод, которому он нужен.',
          task,
        });
      }
    }
    // Модель помощника выгружается перед игрой, чтобы освободить память
    await this.ai.stop();
    const r = await this.launcher.play({
      profileId: profile.id,
      auth,
      nickname: settings.nickname,
      ram: budget.client,
      options: settings.options || settings.window?.fullscreen ? { ...(settings.options || {}), fullscreen: !!settings.window?.fullscreen } : null,
      world: req.world || null,
      server: /^127\.0\.0\.1:\d{2,5}$/.test(req.server || '') ? req.server : null,
      jvmArgs: settings.jvmArgs ? settings.jvmArgs.split(/\s+/).filter(Boolean) : [],
      window: settings.window && !settings.window.fullscreen && settings.window.width ? settings.window : null,
      javaPath: settings.javaPath || null,
    });
    await this.saveSettings({ lastProfile: profile.id });
    return r;
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
    const r = await this.installer.setEnabled(pid, key, on);
    await this.refreshRoom(pid);
    return r;
  }
  async setModPinned(pid, key, pinned) {
    return this.installer.setPinned(pid, key, pinned);
  }
  async rollbackMods(pid) {
    await this.backupAllWorlds(pid, 'before-rollback', 'Перед откатом сборки');
    const lock = await this.installer.rollback(pid);
    await this.refreshRoom(pid);
    return lock;
  }
  async refreshRoom(pid) {
    if (this.host && this.host.profileId === pid) {
      const lock = await this.store.getLock(pid);
      await this.host.updateManifest(lockLib.roomManifest(lock, { name: this.host.worldName })).catch(() => {});
    }
  }

  // ---------- с друзьями: хозяин ----------
  /**
   * Сессия: сервер на этом ПК открывает мир сборки (или создаёт новый), затем — комната для приглашений,
   * если настроен сервер easyLauncher. req: {profileId, folder?, create?, eula?}.
   */
  async startCoop(req, auth) {
    const settings = await this.settings();
    this.coopHostName = auth?.name || null; // в истории сессий хозяин не считается «другом»
    const profile = await this.store.getProfile(req.profileId);
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
    });
    let room = null;
    let roomError = null;
    if (settings.backend) {
      try {
        room = await this.openRoom(auth, profile.id, r.folder);
      } catch (e) {
        roomError = e.message;
      }
    }
    return { ...r, room, roomError, backend: !!settings.backend };
  }

  async openRoom(auth, pid, folder) {
    const s = await this.settings();
    if (!s.backend) throw Object.assign(new Error('Сервер easyLauncher для приглашений не настроен. Друзья в той же сети могут подключиться по локальному адресу.'), { code: 'NO_BACKEND' });
    const st = this.launcher.status();
    if (st.server !== 'running') throw new Error('Сначала запусти сессию.');
    if (this.host) return this.host.state('online');
    const name = (await this.worlds.list(pid)).find((w) => w.folder === folder)?.name || folder;
    const lock = await this.store.getLock(pid);
    const transports = [new RelayHost()];
    if (this.rtc) transports.unshift(new this.rtc.RtcHost(this.rtc.engine));
    const host = new HostSession({
      backend: s.backend,
      transports,
      targetPort: st.port,
      onGuest: async (guestName) => {
        if (this.launcher.server.state !== 'running') return 'Сервер хозяина сейчас не запущен.';
        this.launcher.allowPlayer(guestName);
        return true;
      },
    });
    host.worldName = name;
    host.profileId = pid;
    host.on('state', (state) => this.emit('room', state));
    await host.open({ name, manifest: lockLib.roomManifest(lock, { name }), hostName: auth?.name || s.nickname });
    this.host = host;
    return host.state('online');
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
        this.launcher.removePlayer(n);
      } catch {}
    }
    return names;
  }
  async stopRoom() {
    const h = this.host;
    this.host = null;
    await h?.close();
    this.emit('room', null);
  }
  /** Завершить сессию: комната закрывается, сервер сохраняет мир и останавливается. */
  async endCoop() {
    await this.stopRoom().catch(() => {});
    await this.launcher.endSession();
  }

  // ---------- с друзьями: гость ----------
  /** «Проверка приглашения»: комната, версия, нужные моды. Отдельная сборка комнаты, личная не меняется. */
  async openInvite(link, auth) {
    if (!auth) throw Object.assign(new Error('Для подключения к другу нужен вход через Microsoft.'), { code: 'AUTH_REQUIRED' });
    parseInvite(link);
    await this.leaveGuest();
    const transports = [new RelayGuest()];
    if (this.rtc) transports.unshift(new this.rtc.RtcGuest(this.rtc.engine));
    const session = new GuestSession({ transports });
    session.on('stage', (s) => this.emit('guest-stage', s));
    session.on('revoked', () => this.emit('guest-stage', 'revoked'));
    session.on('host-offline', () => this.emit('guest-stage', 'host-offline'));
    const { room, manifest } = await session.join(link, auth.name);
    const roomKey = 'room-' + crypto.createHash('sha256').update(parseInvite(link).roomId).digest('hex').slice(0, 16);
    let existing = null;
    try {
      existing = await this.store.getLock(roomKey);
    } catch {}
    const compare = existing ? lockLib.compare(manifest, existing) : null;
    this.guest = { session, profileId: roomKey, manifest, room };
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
    if (!exists) await this.store.createProfile({ id: g.profileId, name: `Комната «${g.room.name}»`, minecraft: lock.minecraft, loader: lock.loader, kind: 'room', room: { name: g.room.name, host: g.room.hostName } });
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
    this.emit('guest-stage', 'route-' + conn.route);
    const settings = await this.settings();
    const budget = this.memoryBudget('guest', settings);
    await this.launcher.playGuest({ profileId: g.profileId, address: '127.0.0.1:' + conn.port, auth, ram: budget.client, options: settings.options });
    return { route: conn.route };
  }

  async leaveGuest() {
    const g = this.guest;
    this.guest = null;
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
    if (intent.intent === 'diagnose' || diagnoseRules(text).length || /Exception|\w+Error\b|Caused by:|\[(ERROR|FATAL)\]/.test(text)) {
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
      if (ans.visuals && !intent.themes.includes('visuals')) intent.themes = [...intent.themes, 'visuals'];
      const roles = ans.perf === undefined && ans.qol === undefined ? null : [...(ans.perf !== false ? ['performance'] : []), ...(ans.qol !== false ? ['qol'] : [])];
      return { ...base, ...(await this.newBuildTask(intent, wishes, { roles, setup: ans.setup !== false })) };
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

  /**
   * Уточняющие вопросы перед сборкой; ответы по умолчанию — из того, что игрок уже написал.
   * current — выбранная сборка с загрузчиком: тогда первый вопрос «куда ставить моды», а вопросы
   * только для новой сборки (only: 'new') или только для текущей (only: 'current') окно показывает по ответу.
   */
  async buildQuestions(intent, wishes, current = null) {
    let latest = null;
    try {
      latest = (await this.launcher.versions()).find((v) => v.type === 'release')?.id || null;
    } catch {}
    const versions = [...new Set([latest, '1.21.1', '1.20.1', wishes.minecraft].filter(Boolean))];
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
      q('version', 'Версия Minecraft', 'Под 1.21.1 и 1.20.1 модов больше всего', [{ value: 'auto', label: 'Подбери сам' }, ...versions.map((v) => ({ value: v, label: vLabel(v) }))], wishes.minecraft || 'auto', 'new'),
      q('loader', 'Загрузчик модов', 'Fabric — лёгкий и быстрый; Forge и NeoForge — большие моды', [{ value: 'auto', label: 'Подбери сам' }, { value: 'fabric', label: 'Fabric' }, { value: 'forge', label: 'Forge' }, { value: 'neoforge', label: 'NeoForge' }], wishes.loader || 'auto', 'new'),
      q('perf', 'Моды оптимизации (больше FPS)', 'Sodium/Embeddium, Lithium, FerriteCore и др. — игра не меняется, только быстрее', yes(true)),
      q('qol', 'Удобства', 'Миникарта, книга рецептов, подсказки о блоках', yes(wishes.size !== 'small'), null, 'new'),
      q('visuals', 'Шейдеры и красивая графика', 'Нужна хорошая видеокарта', yes(intent.themes.includes('visuals')), null, 'new'),
      q('setup', 'Настроить память и графику под мой ПК', 'Сколько памяти дать игре и какую дальность прорисовки поставить', yes(true)),
    ].filter((x) => current || x.id !== 'amount');
  }

  /** Новая сборка: версия и загрузчик под темы, подборка модов, проверенный план, память и графика. */
  async newBuildTask(intent, wishes, { roles = null, setup: doSetup = true } = {}) {
    const provider = (await this.providers()).modrinth;
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
      const pick = await builder.pickMods({ intent, target, lock, provider, size: wishes.size, roles });
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
    const name = builder.buildName(pick.themes.filter((t) => t !== 'visuals' || pick.themes.length === 1));
    const deps = plan.changes.filter((c) => c.dependencyOf).length;
    const steps = [
      `Создать сборку «${name}»: Minecraft ${target.minecraft}, ${LOADER_LABEL[target.loader]}`,
      `Поставить ${items.length} ${plural(items.length, 'мод', 'мода', 'модов')}${deps ? ` и ${deps} ${plural(deps, 'библиотеку', 'библиотеки', 'библиотек')}, ${deps === 1 ? 'нужную' : 'нужных'} им` : ''}`,
      'Проверить файлы модов: всё ли нужное для запуска на месте',
      ram ? `Выделить игре ${ram} ГБ памяти` : null,
      options ? `Настроить графику: прорисовка ${options.render} чанков, ${options.graphics ? 'детальная' : 'быстрая'} графика, до ${options.fps} FPS` : null,
    ].filter(Boolean);
    const task = this.saveTask({ pid: null, create: { name, minecraft: target.minecraft, loader: target.loader }, plan, baseLock, request, ram, options, steps });
    const groups = [];
    for (const a of items) {
      const title = groupTitle(a.reason);
      const g = groups.find((x) => x.title === title) || groups[groups.push({ title, names: [] }) - 1];
      g.names.push(a.name);
    }
    return {
      kind: 'build',
      build: { name, minecraft: target.minecraft, loader: target.loader, mods: items.length, deps },
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
    const setup = builder.gameSetup({ totalGb: budget.total, reserveGb: budget.reserve, mods: lock.mods.length, lowEnd: intent.lowEnd, fps: true });
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
   * Починка по найденным причинам вылета: недостающая зависимость — добавить, несовместимые моды —
   * убрать позже добавленный, сбой Mixin — обновить мод (нет обновления — убрать), мод для другой
   * версии — обновить всё, нехватка памяти — добавить. null — исправить автоматически нечего.
   */
  async fixTask(pid, findings) {
    const lock = await this.store.getLock(pid);
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
    const entries = lock.mods.filter((m) => m.enabled !== false && cache.has(m.file)).map((m) => ({ name: m.name, key: m.key, file: cache.pathFor(m.file) }));
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
    if (lock.loader === 'vanilla') return { missing: [], conflicts: [] };
    const on = lock.mods.filter((m) => m.enabled !== false);
    if (on.some((m) => !this.launcher.cache.has(m.file))) await this.fetchFiles(on).catch(() => {});
    // без всех файлов сравнивать нечестно: не скачанный мод выглядел бы «недостающим»
    if (on.some((m) => !this.launcher.cache.has(m.file))) return { missing: [], conflicts: [] };
    return checkLinks(this.linkEntries(lock, pid), lock.loader);
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
      const report = checkLinks(this.linkEntries(plan.nextLock, t.pid), base.loader);
      if (!report.missing.length) break;
      const add = [];
      const drop = new Set();
      for (const miss of report.missing) {
        const lib = await this.findLibrary(providers, plan.nextLock, miss.id);
        const key = lib && lockLib.keyOf(lib.source, lib.project.id);
        if (lib && !plan.nextLock.mods.some((m) => m.key === key) && !add.some((a) => lockLib.keyOf(a.source, a.projectId) === key)) {
          add.push({ source: lib.source, projectId: String(lib.project.id), versionId: lib.version.id });
          added.push(`${lib.project.name}${lib.version.type === 'release' ? '' : ` (тестовая версия ${lib.version.number} — другой нет)`}${lib.source === 'curseforge' ? ' с CurseForge' : ''}`);
          names.set(key, lib.project.name);
        } else for (const b of miss.by) if (b.key) drop.add(b.key);
      }
      if (!add.length && !drop.size) break;
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
        add: [...(request.add || []).filter((a) => !drop.has(lockLib.keyOf(a.source, a.projectId))), ...add],
        remove: [...new Set([...(request.remove || []), ...[...drop].filter((k) => inBase.has(k))])],
      };
      plan = await planChanges({ lock: base, request, providers });
      plan.significant = plan.changes.some((c) => c.type === 'remove');
    }
    if (!plan.ok) throw new Error('После проверки файлов модов план не сходится: ' + plan.errors.map((e) => e.message).slice(0, 2).join(' '));
    return { plan, added, removed };
  }

  /** Задание «исправить связи» для сборки: добавить недостающие обязательные моды из каталога, иначе убрать требующий. */
  async linkFixTask(pid, report) {
    const lock = await this.store.getLock(pid);
    const providers = await this.providers();
    const add = [];
    const remove = [];
    for (const miss of report.missing) {
      const lib = await this.findLibrary(providers, lock, miss.id);
      if (lib && !lock.mods.some((m) => m.key === lockLib.keyOf(lib.source, lib.project.id))) add.push({ source: lib.source, projectId: String(lib.project.id), versionId: lib.version.id });
      else remove.push(...miss.by.map((b) => b.key).filter(Boolean));
    }
    if (!add.length && !remove.length) return null;
    const request = { add, remove: [...new Set(remove)] };
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
      this.tasks.delete(String(taskId));
      return { profileId: t.pid, created: !!t.created, backups, linksAdded: links.added || [], linksRemoved: links.removed || [] };
    } finally {
      this.runningTask = null;
    }
  }

  async shutdown() {
    await this.stopRoom().catch(() => {});
    await this.leaveGuest().catch(() => {});
    await this.ai.stop();
    await this.launcher.shutdown();
  }
}

module.exports = { parseNews, Services };
