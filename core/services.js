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
const { readJson, writeJson } = require('./store');
const { HostSession, GuestSession, parseInvite } = require('./net/session');
const { RelayHost, RelayGuest } = require('./net/relay');
const { AiManager } = require('./ai/manager');
const { Assistant, proposeMods, smallTalk } = require('./ai/assistant');
const { diagnose: diagnoseRules } = require('./ai/diagnose');
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
      dim: Number.isFinite(s.dim) ? Math.max(0.2, Math.min(0.9, s.dim)) : 0.55,
    };
  }
  async saveSettings(patch) {
    const cur = (await readJson(this.settingsFile)) || {};
    // только известные поля: настройки не превращаются в склад произвольных данных из интерфейса
    const KNOWN = ['backend', 'cfProxy', 'ram', 'serverRam', 'eula', 'motion', 'lastProfile', 'nickname', 'options', 'offlineOk', 'dim', 'appearance', 'background'];
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
    // Модель помощника выгружается перед игрой, чтобы освободить память
    await this.ai.stop();
    const r = await this.launcher.play({
      profileId: profile.id,
      auth,
      nickname: settings.nickname,
      ram: budget.client,
      options: settings.options,
      world: req.world || null,
      server: /^127\.0\.0\.1:\d{2,5}$/.test(req.server || '') ? req.server : null,
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
    const { nextLock, ...visible } = plan;
    return { planId: id, ...visible, nextMinecraft: nextLock.minecraft, nextLoader: nextLock.loader, sizeBytes: nextLock.mods.filter((m) => plan.changes.some((c) => c.key === m.key && c.type !== 'remove')).reduce((a, m) => a + (m.file.size || 0), 0) };
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
    return { applied: true, plan, lock: r.lock };
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
      return { lock, backups };
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

  /** Запрос к помощнику. Результат — понятие запроса, проверенный план (по id) или диагностика. */
  async ask(text, pid) {
    await this.aiStatus();
    const chat = smallTalk(String(text));
    if (chat) return { understoodBy: 'rules', intent: { intent: 'question' }, kind: 'message', message: chat };
    const asst = this.assistant();
    const lock = await this.store.getLock(pid);
    const u = await asst.understand(String(text).slice(0, 4000));
    const intent = u.intent;
    const base = { understoodBy: u.by, rejected: u.rejected || null, intent };
    // текст ошибки (лог, стек) — сразу в диагностику, даже если модель решила иначе
    if (intent.intent === 'diagnose' || diagnoseRules(text).length || /Exception|\w+Error\b|Caused by:|\[(ERROR|FATAL)\]/.test(text)) return { ...base, kind: 'diagnose', ...(await asst.diagnose(text)) };
    if (intent.intent === 'optimize') {
      const s = await this.settings();
      const budget = this.memoryBudget('play', s);
      const options = { render: intent.lowEnd ? 6 : 10, simulation: intent.lowEnd ? 4 : 6, fps: 120, graphics: intent.lowEnd ? 0 : 1 };
      const perf = lock.loader === 'vanilla' ? null : await proposeMods({ ...intent, themes: ['performance'] }, { search: (q) => this.searchForProfile(q, lock), lock });
      let plan = null;
      if (perf?.add.length) plan = await this.planMods(pid, { add: perf.add.map((p) => ({ source: p.source, projectId: p.id })) });
      return { ...base, kind: 'optimize', options, ram: budget.client, plan, note: 'Это стартовые настройки, а не замер. Сравни один и тот же мир до и после.' };
    }
    if (lock.loader === 'vanilla' && ['build', 'add'].includes(intent.intent))
      return { ...base, kind: 'needs-loader', message: 'Это сборка Vanilla — моды ставятся в сборку с загрузчиком (Fabric, Quilt, Forge или NeoForge). Создай её в «Сборки».' };
    if (intent.intent === 'remove') {
      const names = intent.searchTerms.map((t) => t.toLowerCase());
      const keys = lock.mods.filter((m) => names.some((n) => m.name.toLowerCase().includes(n))).map((m) => m.key);
      if (!keys.length) return { ...base, kind: 'message', message: 'Не понял, какой мод убрать. Открой «Сборки» → сборка → «Моды» и выбери его в списке.' };
      const plan = await this.planMods(pid, { remove: keys });
      return { ...base, kind: 'plan', plan, explanation: (await asst.explain(this.plans.get(plan.planId).plan)).text };
    }
    if (intent.intent === 'question' || (!intent.themes.length && !intent.searchTerms.length))
      return { ...base, kind: 'message', message: intent.clarify || 'Не понял, что подобрать. Напиши тему или названия модов: например «выживание с зомби и оружием», «приключения без сложной техники», «добавь Create». Для ошибки — вставь текст из latest.log.' };
    const prop = await proposeMods(intent, { search: (q) => this.searchForProfile(q, lock), lock });
    if (!prop.add.length) {
      const parts = [];
      if (prop.notFound.length) parts.push(`В каталоге нет модов для ${lock.loader} ${lock.minecraft} с названием: ${prop.notFound.join(', ')}.`);
      if (prop.already.length) parts.push(`Уже в сборке: ${prop.already.join(', ')}.`);
      return { ...base, kind: 'message', message: parts.join(' ') || 'В каталоге не нашлось подходящих модов под эту версию игры.', notFound: prop.notFound, already: prop.already };
    }
    const plan = await this.planMods(pid, { add: prop.add.map((p) => ({ source: p.source, projectId: p.id })) });
    const ex = await asst.explain(this.plans.get(plan.planId).plan, { otherNames: [] });
    const note = intent.big
      ? `Сразу сто модов я не собираю: у каждого проверяются версия, зависимости и конфликты, а большой непроверенный набор почти всегда не запускается. Это основа из ${prop.add.length} модов — попроси ещё («добавь оружие», «больше зомби») или добавь в разделе «Моды».`
      : null;
    return { ...base, kind: 'plan', plan, explanation: ex.text, explainedBy: ex.by, notFound: prop.notFound, already: prop.already, note };
  }

  async searchForProfile(q, lock) {
    const p = await this.providers();
    return (await p.modrinth.search({ query: q, minecraft: lock.minecraft, loader: lock.loader, limit: 10 })).hits;
  }

  async shutdown() {
    await this.stopRoom().catch(() => {});
    await this.leaveGuest().catch(() => {});
    await this.ai.stop();
    await this.launcher.shutdown();
  }
}

module.exports = { parseNews, Services };
