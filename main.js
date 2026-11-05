'use strict';
const { app, BrowserWindow, ipcMain, shell, net, dialog, safeStorage, session, Tray, Menu, nativeImage, protocol, globalShortcut } = require('electron');
const { pathToFileURL } = require('url');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('./core/http');
const { Services } = require('./core/services');
const { Accounts } = require('./core/accounts');
const auth = require('./core/auth');
const { RtcEngine, RtcHost, RtcGuest } = require('./core/net/webrtc');
const eosSdk = require('./core/net/eos/sdk');

// Ссылки-приглашения easylauncher://join?... открываются в лаунчере
if (process.defaultApp) app.setAsDefaultProtocolClient('easylauncher', process.execPath, [path.resolve(process.argv[1] || '.')]);
else app.setAsDefaultProtocolClient('easylauncher');
// Кандидаты WebRTC с локальными адресами вместо mDNS-имён: иначе прямое соединение часто не находится
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');

// easyimg://img/?f=<путь> — показ обложек и скриншотов из папки лаунчера (только изображения, только внутри неё)
// и роликов камеры воспоминаний (только .mp4 из её папки; stream — чтобы <video> мог читать файл частями)
protocol.registerSchemesAsPrivileged([{ scheme: 'easyimg', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);

/** Видео по частям (Range): без этого Chromium не всегда начинает показ ролика с собственного протокола. */
function videoResponse(file, range) {
  const size = fs.statSync(file).size;
  const m = /^bytes=(\d*)-(\d*)$/.exec(range || '');
  if (!m || (!m[1] && !m[2])) return new Response(require('stream').Readable.toWeb(fs.createReadStream(file)), { headers: { 'content-type': 'video/mp4', 'content-length': String(size), 'accept-ranges': 'bytes' } });
  let start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
  let end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  if (start >= size || start > end) return new Response('', { status: 416, headers: { 'content-range': `bytes */${size}` } });
  return new Response(require('stream').Readable.toWeb(fs.createReadStream(file, { start, end })), {
    status: 206,
    headers: { 'content-type': 'video/mp4', 'content-length': String(end - start + 1), 'content-range': `bytes ${start}-${end}/${size}`, 'accept-ranges': 'bytes' },
  });
}

// Вторая копия (например, ярлык нажат, пока лаунчер уже открыт после установки) только передаёт фокус
// первой и сразу выходит — без запуска сервисов, окна и записи в общие файлы
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

let win = null;
let svc = null;
let accounts = null;
let tray = null;
let quitting = false;
let pendingInvite = (process.argv.find((a) => a.startsWith('easylauncher://')) || null);

// Журнал лаунчера: ошибки действий и неожиданные сбои — чтобы игрок мог прислать файл, а не пересказывать
const ROOT = process.env.EASYLAUNCHER_HOME || path.join(app.getPath('appData'), '.easylauncher');
const LOG_FILE = path.join(ROOT, 'logs', 'launcher.log');
function logError(where, e) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 1024 * 1024) fs.renameSync(LOG_FILE, LOG_FILE + '.old');
    const line = `[${new Date().toISOString()}] ${app.getVersion()} ${where}: ${e?.code ? e.code + ' ' : ''}${e?.stack || e?.message || e}\n`;
    fs.appendFileSync(LOG_FILE, line);
  } catch {}
}
process.on('uncaughtException', (e) => {
  logError('сбой', e);
  // После неизвестного сбоя состояние процесса ненадёжно: объясняем, где журнал, и завершаемся.
  dialog.showErrorBox('easyLauncher: что-то пошло не так', `${e?.message || e}\n\nЕсли повторяется — перезапусти лаунчер. Подробности записаны в журнал:\n${LOG_FILE}`);
  quitting = true;
  app.exit(1);
});
process.on('unhandledRejection', (e) => logError('необработано', e));

function send(channel, data) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, data);
}

function openInvite(link) {
  if (!/^easylauncher:\/\//.test(link || '')) return;
  if (win) {
    send('invite:open', link);
    win.show();
    win.focus();
  } else pendingInvite = link;
}

function createWindow() {
  const rendererUrl = pathToFileURL(path.join(__dirname, 'renderer', 'index.html'));
  const trustedRenderer = (raw) => {
    try {
      const u = new URL(raw);
      return u.protocol === 'file:' && u.pathname === rendererUrl.pathname;
    } catch {
      return false;
    }
  };
  win = new BrowserWindow({
    width: 1300,
    height: 900,
    minWidth: 1020,
    minHeight: 680,
    frame: false,
    backgroundColor: '#141814',
    title: 'easyLauncher',
    icon: path.join(__dirname, 'build', 'icon.png'),
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => {
    win.show();
    if (pendingInvite) setTimeout(() => send('invite:open', pendingInvite), 800);
    pendingInvite = null;
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!trustedRenderer(url)) {
      e.preventDefault();
      if (/^https:\/\//.test(url)) shell.openExternal(url);
    }
  });
  win.on('close', (e) => {
    if (quitting || !svc) return;
    const st = svc.launcher.status();
    if (st.server === 'stopped') return;
    e.preventDefault();
    // Сервер работает — явно объясняем варианты; мир доступен друзьям, только пока ПК хозяина включён
    const r = dialog.showMessageBoxSync(win, {
      type: 'question',
      buttons: ['Свернуть — сервер продолжит работу', 'Сохранить мир и выйти', 'Отмена'],
      defaultId: 0,
      cancelId: 2,
      title: 'easyLauncher',
      message: 'Сессия с друзьями ещё идёт.',
      detail: 'Если свернуть, друзья смогут играть, пока включён этот компьютер — значок останется рядом с часами. Если выйти, лаунчер сохранит мир и завершит сессию.',
    });
    if (r === 0) {
      ensureTray();
      win.hide();
    } else if (r === 1) app.quit();
  });
  win.on('maximize', () => send('win:state', { maximized: true }));
  win.on('unmaximize', () => send('win:state', { maximized: false }));
}

function ensureTray() {
  if (tray) return;
  const img = nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.png')).resize({ width: 16, height: 16 });
  tray = new Tray(img);
  tray.setToolTip('easyLauncher — идёт сессия с друзьями');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Открыть easyLauncher', click: () => win.show() },
      { label: 'Сохранить мир и выйти', click: () => app.quit() },
    ]),
  );
  tray.on('click', () => win.show());
}

/** Окно входа Microsoft. Возвращает код авторизации, перехваченный на redirect. */
function microsoftLogin() {
  const reqst = auth.createLoginRequest(accounts.clientId);
  return new Promise((resolve, reject) => {
    const loginWin = new BrowserWindow({
      parent: win,
      modal: true,
      width: 520,
      height: 700,
      title: 'Вход через Microsoft',
      autoHideMenuBar: true,
      backgroundColor: '#ffffff',
      webPreferences: { session: session.fromPartition('msauth-' + Date.now()), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    let finished = false;
    const finish = (err, code) => {
      if (finished) return;
      finished = true;
      if (!loginWin.isDestroyed()) loginWin.close();
      err ? reject(err) : resolve({ code, verifier: reqst.verifier });
    };
    const check = (e, url) => {
      try {
        const code = auth.parseRedirect(url, reqst.state);
        if (code === null) return;
        e?.preventDefault?.();
        finish(null, code);
      } catch (err) {
        e?.preventDefault?.();
        finish(err);
      }
    };
    loginWin.webContents.on('will-redirect', check);
    loginWin.webContents.on('will-navigate', check);
    loginWin.webContents.on('did-navigate', (e, url) => check(null, url));
    loginWin.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https:\/\//.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    loginWin.on('closed', () => finish(Object.assign(new Error('Вход отменён.'), { code: 'access_denied' })));
    loginWin.loadURL(reqst.url);
  });
}

app.on('second-instance', (_e, argv) => {
  const link = argv.find((a) => a.startsWith('easylauncher://'));
  if (link) openInvite(link);
  else if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
});
app.on('open-url', (e, url) => {
  e.preventDefault();
  openInvite(url);
});

/** Ошибки из главного процесса уходят в интерфейс с кодом — он показывает причину и следующее действие. */
function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: true, value: await fn(...args) };
    } catch (e) {
      if (e?.code !== 'CANCELLED') logError(channel, e);
      return { ok: false, error: { message: e.message, code: e.code || null, action: e.action || null, missing: e.missing || null, status: e.status || null, task: e.task || null } };
    }
  });
}

app.whenReady().then(async () => {
  if (!gotLock) return;
  http.setFetch((url, opts) => net.fetch(url, opts));
  const root = ROOT;
  fs.mkdirSync(root, { recursive: true });
  accounts = new Accounts(root, {
    available: safeStorage.isEncryptionAvailable(),
    encrypt: (t) => {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('Защищённое хранилище ОС недоступно.');
      return safeStorage.encryptString(t);
    },
    decrypt: (b) => {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('Защищённое хранилище ОС недоступно.');
      return safeStorage.decryptString(b);
    },
  });
  const engine = new RtcEngine();
  // Epic Online Services: DLL и ключи лежат рядом с приложением (resources/eos) — тогда приглашения идут через Epic
  const eosFiles = eosSdk.locate({ resources: app.isPackaged ? process.resourcesPath : null, projectRoot: __dirname });
  const eos = eosFiles ? (name) => new eosSdk.EosPlatform({ ...eosFiles, name, version: app.getVersion(), cacheDir: path.join(root, 'eos-cache') }) : null;
  // FFmpeg для «Камеры воспоминаний» ставится вместе с лаунчером (resources/ffmpeg); при разработке — ffmpeg-dist/
  const ffmpegDir = app.isPackaged ? path.join(process.resourcesPath, 'ffmpeg') : path.join(__dirname, 'ffmpeg-dist');
  svc = new Services(root, { rtc: { engine, RtcHost, RtcGuest }, eos, ffmpegDir });
  // строки журнала интерфейсу не нужны (журнал читается по запросу), а прогресс загрузки
  // приходит сотни раз в секунду — отправляем не чаще 10 раз в секунду, смену этапа — сразу
  let lastStage = { key: '', at: 0 };
  let hiddenForGame = false;
  svc.on('event', (ev) => {
    if (ev.type === 'log') return;
    // «Настройки» → «Когда игра запущена»: свернуть или спрятать лаунчер, вернуть после закрытия игры
    if (ev.type === 'client' && win && !win.isDestroyed()) {
      svc
        .settings()
        .then((s) => {
          if (ev.state === 'running' && s.afterLaunch === 'minimize') win.minimize();
          else if (ev.state === 'running' && s.afterLaunch === 'hide') {
            hiddenForGame = true;
            win.hide();
          } else if (ev.state === 'stopped' && hiddenForGame) {
            hiddenForGame = false;
            win.show();
          }
        })
        .catch(() => {});
    }
    if (ev.type === 'stage') {
      const key = ev.stage + '|' + (ev.detail || '').split(':')[0];
      const now = Date.now();
      if (key === lastStage.key && now - lastStage.at < 100 && ev.percent !== 100) return;
      lastStage = { key, at: now };
    }
    send('mc:event', ev);
  });
  let lastMods = 0;
  svc.on('mods-progress', (p) => {
    const now = Date.now();
    if (p.phase === 'download' && p.done < p.total && now - lastMods < 100) return;
    lastMods = now;
    send('mods:progress', p);
  });
  svc.on('room', (st) => send('room:state', st));
  svc.on('memories', (st) => st && send('memories:state', st));
  svc.on('guest-stage', (s) => send('guest:stage', s));
  // голосовой чат: звук и состав участников — в окно; кадры с микрофона — из окна (без ожидания ответа)
  svc.on('voice', (ev) => send('voice:event', ev));
  ipcMain.on('voice:send', (e, buf) => {
    if (!win || e.sender !== win.webContents || !(buf instanceof Uint8Array) || buf.length > 4000) return;
    svc.voiceSend(Buffer.from(buf));
  });
  // разрешения окна: микрофон (без камеры) — для голосового чата; запись картинки в буфер обмена
  // (в Electron 44 картинку копирует само окно — navigator.clipboard); всё остальное запрещено
  const ALLOWED_PERMS = ['fullscreen', 'clipboard-sanitized-write'];
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb, details) => {
    if (permission === 'media') return cb(!(details.mediaTypes || []).includes('video'));
    cb(ALLOWED_PERMS.includes(permission));
  });
  session.defaultSession.setPermissionCheckHandler((wc, permission, origin, details) => (permission === 'media' ? details?.mediaType !== 'video' : ALLOWED_PERMS.includes(permission)));
  // Только для сквозных тестов интерфейса: подмена сети Mojang/каталогов локальными заглушками
  let e2e = null;
  if (!app.isPackaged && process.env.EASYLAUNCHER_E2E_SETUP) e2e = await require(path.resolve(process.env.EASYLAUNCHER_E2E_SETUP))({ svc, accounts });
  await svc.init();
  // прозрачный 1×1 PNG — для картинки, которую только что заменили (старая обложка уже удалена)
  const EMPTY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
  protocol.handle('easyimg', (req) => {
    const file = new URL(req.url).searchParams.get('f') || '';
    if (svc.mediaAllowed(file)) return videoResponse(file, req.headers.get('range'));
    if (svc.imageAllowed(file)) return net.fetch(pathToFileURL(file).toString());
    if (svc.imagePathAllowed(file)) return new Response(EMPTY_PNG, { headers: { 'content-type': 'image/png' } });
    return new Response('', { status: 404 });
  });

  const launchAuth = () => accounts.launchAuth();
  const pickImage = async (title) => {
    const r = await dialog.showOpenDialog(win, { title, filters: [{ name: 'Изображение', extensions: ['png', 'jpg', 'jpeg', 'webp'] }], properties: ['openFile'] });
    return r.canceled ? null : r.filePaths[0];
  };
  // скриншот для обложки — только из папки скриншотов этой же сборки
  const ownShot = (pid, file) => {
    const dir = path.join(svc.store.gameDir(pid), 'screenshots');
    if (path.dirname(path.resolve(file)) !== path.resolve(dir)) throw new Error('Скриншот не из этой сборки.');
    return file;
  };

  // фото-режим: картинка скриншота (data URL — холст окна можно сохранить) и откуда он (мир, день — из летописи)
  handle('shots:data', async (pid, file) => {
    const f = ownShot(pid, file);
    const buf = await fs.promises.readFile(f);
    if (buf.length > 40 * 1024 * 1024) throw new Error('Скриншот слишком большой.');
    return `data:image/${/\.png$/i.test(f) ? 'png' : /\.webp$/i.test(f) ? 'webp' : 'jpeg'};base64,${buf.toString('base64')}`;
  });
  handle('shots:info', (pid, file) => svc.shotInfo(pid, ownShot(pid, file)));
  handle('win:minimize', () => win.minimize());
  handle('win:maximize', () => (win.isMaximized() ? win.unmaximize() : win.maximize()));
  handle('win:close', () => win.close());
  handle('sys:info', () => ({ totalRamGiB: Math.round(os.totalmem() / 1024 ** 3), platform: process.platform, root, version: app.getVersion(), defaultBg: fs.existsSync(path.join(__dirname, 'renderer', 'assets', 'default-bg.jpg')) }));

  handle('auth:status', () => accounts.status());
  handle('auth:logout', () => (accounts.logout(), accounts.status()));
  handle('auth:login', async () => {
    const code = await (e2e?.microsoftLogin || microsoftLogin)();
    return (e2e?.completeLogin || accounts.completeLogin.bind(accounts))(code.code, code.verifier);
  });

  handle('settings:get', () => svc.settings());
  handle('settings:set', (patch) => svc.saveSettings(patch));
  handle('storage:info', () => svc.storageInfo());
  handle('storage:clean', () => svc.cleanModCache());
  handle('java:pick', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Файл Java (java.exe из папки bin)', filters: [{ name: 'Java', extensions: process.platform === 'win32' ? ['exe'] : ['*'] }], properties: ['openFile'] });
    return r.canceled ? null : svc.saveSettings({ javaPath: r.filePaths[0] });
  });
  handle('bg:set', async (mode) => {
    if (mode !== 'custom') return svc.setBackground(mode);
    const file = await pickImage('Картинка для фона');
    return file ? svc.setBackground('custom', file) : null;
  });
  handle('bg:for', (pid) => svc.backgroundFor(pid));

  handle('profiles:overview', () => svc.overview());
  handle('profiles:first', () => svc.ensureFirstProfile());
  handle('profiles:select', (pid) => svc.selectProfile(pid));
  handle('profiles:details', (pid) => svc.profileDetails(pid));
  handle('profiles:create', (data) => svc.createProfile(data));
  handle('profiles:update', (pid, patch) => svc.updateProfile(pid, patch));
  handle('profiles:delete', (pid, name) => svc.deleteProfile(pid, name));
  handle('profiles:screenshots', (pid) => svc.screenshots(pid));
  handle('home:info', (pid) => svc.homeInfo(pid));
  handle('home:updates', (pid, force) => svc.modUpdates(pid, { force: !!force }));
  handle('home:news', () => svc.news());
  handle('home:newsBody', (contentPath) => svc.newsBody(contentPath));
  handle('bg:shot', (pid, file) => svc.setBackground('custom', ownShot(pid, file)));
  handle('profiles:export', async (pid) => {
    const p = await svc.store.getProfile(pid);
    const r = await dialog.showSaveDialog(win, { title: 'Экспорт сборки', defaultPath: p.name.replace(/[\\/:*?"<>|]/g, '_') + '.easypack', filters: [{ name: 'Сборка easyLauncher', extensions: ['easypack'] }] });
    return r.canceled ? null : svc.exportProfile(pid, r.filePath);
  });
  handle('profiles:import', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Импорт сборки',
      filters: [
        { name: 'Сборка: Modrinth, CurseForge, easyLauncher', extensions: ['mrpack', 'zip', 'easypack'] },
        { name: 'Все файлы', extensions: ['*'] },
      ],
      properties: ['openFile'],
    });
    if (r.canceled) return null;
    svc.emit('mods-progress', { phase: 'import' }); // файл выбран — окно показывает ожидание
    return svc.importPack(r.filePaths[0]);
  });
  handle('profiles:coverPick', async (pid) => {
    const file = await pickImage('Обложка сборки');
    return file ? svc.setProfileCover(pid, file) : null;
  });
  handle('profiles:coverShot', (pid, file) => svc.setProfileCover(pid, ownShot(pid, file)));
  handle('profiles:coverClear', (pid) => svc.setProfileCover(pid, null));

  handle('worlds:list', (pid) => svc.listWorlds(pid));
  handle('worlds:coverPick', async (pid, folder) => {
    const file = await pickImage('Обложка мира');
    return file ? svc.setWorldCover(pid, folder, file) : null;
  });
  handle('worlds:coverShot', (pid, folder, file) => svc.setWorldCover(pid, folder, ownShot(pid, file)));
  handle('worlds:coverPin', (pid, folder, v) => svc.pinWorldCover(pid, folder, v));
  handle('worlds:coverClear', (pid, folder) => svc.clearWorldCover(pid, folder));
  handle('worlds:backups', (pid, folder) => svc.worldBackups(pid, folder));
  handle('worlds:backup', (pid, folder) => svc.backupWorld(pid, folder));
  handle('worlds:restore', (pid, folder, id) => svc.restoreWorld(pid, folder, id));
  handle('worlds:delete', (pid, folder, name) => svc.deleteWorld(pid, folder, name));
  handle('worlds:chronicle', (pid, folder) => svc.chronicleList(pid, folder));
  handle('worlds:map', (pid, folder) => svc.mapInfo(pid, folder));
  handle('perf:last', (pid) => svc.perfLast(pid));
  handle('challenge:status', () => svc.challenges.status());
  handle('challenge:catalog', () => svc.challengeCatalog());
  handle('challenge:create', (opts) => svc.challengeCreate({ goal: opts?.goal, limitMin: opts?.limitMin, rules: opts?.rules, random: !!opts?.random }));
  handle('challenge:accept', (code) => svc.challenges.accept(code));
  handle('challenge:abandon', () => svc.challenges.abandon());
  handle('challenge:compare', (code) => svc.challengeCompare(code));
  handle('perf:dismiss', (pid) => svc.perfDismiss(pid));
  handle('worlds:mapTile', (pid, folder, x, z) => svc.mapTile(pid, folder, x, z));

  handle('mc:versions', () => svc.launcher.versions());
  handle('loaders:versions', (loader, mc) => svc.loaderVersions(loader, mc));
  handle('loaders:support', (loader) => svc.loaderSupport(loader));
  handle('mc:status', () => svc.launcher.status());
  handle('mc:play', async (req) => svc.play(req, await launchAuth()));
  handle('mc:cancel', () => svc.launcher.cancel());
  // пробный запуск, проверка после обновления, поиск виновника вылета
  handle('game:probe', async (pid) => svc.probeBuild(pid, await launchAuth()).then(({ ok, reason, seconds, evidence }) => ({ ok, reason, seconds, evidence })));
  handle('mods:verify', async (pid) => svc.verifyUpdate(pid, await launchAuth()));
  handle('mods:culprit', async (pid, mode) => svc.findCulprit(pid, await launchAuth(), mode === 'update' ? 'update' : 'build'));
  handle('mods:culpritCancel', () => svc.cancelCulprit());
  // трофеи и их карточка картинкой (PNG из окна, только в выбранный игроком файл)
  handle('trophies:list', () => svc.trophies());
  handle('voice:status', () => svc.voiceStatus());
  // кнопка микрофона во время игры (окно лаунчера не в фокусе): глобальная клавиша из короткого списка
  let voiceKey = null;
  handle('voice:hotkey', (key) => {
    const { HOTKEYS } = require('./core/voicecfg');
    if (voiceKey) globalShortcut.unregister(voiceKey);
    voiceKey = null;
    if (key === null) return { key: null };
    if (!HOTKEYS.includes(key)) throw new Error('Эту клавишу нельзя назначить.');
    if (!globalShortcut.register(key, () => send('voice:event', { type: 'hotkey' }))) throw new Error(`Клавиша ${key} уже занята другой программой — выбери другую.`);
    voiceKey = key;
    return { key };
  });
  handle('voice:join', () => svc.voiceJoin());
  handle('voice:leave', () => svc.voiceLeave());
  // временно: второй игрок на этом же компьютере для проверки голоса
  handle('voice:test', (on) => svc.voiceTest(on === true));
  handle('image:save', async (dataUrl, name) => {
    const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
    if (!m || m[1].length > 30 * 1024 * 1024) throw new Error('Картинка не получилась.');
    const r = await dialog.showSaveDialog(win, { title: 'Сохранить картинку', defaultPath: String(name || 'easyLauncher').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) + '.png', filters: [{ name: 'Картинка PNG', extensions: ['png'] }] });
    if (r.canceled || !r.filePath) return null;
    await fs.promises.writeFile(r.filePath, Buffer.from(m[1], 'base64'));
    return r.filePath;
  });
  // «Ускорить сборку»: модель видеокарты знает Chromium (имя рендерера), память и ядра — Node
  let gpuRenderer;
  handle('perf:boost', async (pid) => {
    if (gpuRenderer === undefined) gpuRenderer = await app.getGPUInfo('complete').then((i) => i?.auxAttributes?.glRenderer || null, () => null);
    return svc.boostTask(pid, { gpu: gpuRenderer });
  });
  handle('mc:stopClient', () => svc.launcher.stopClient());
  handle('mc:clientLog', () => svc.launcher.clientLines.slice(-500).join('\n'));
  handle('server:command', (cmd) => svc.launcher.server.command(cmd));
  handle('server:log', () => svc.launcher.server.lines.slice(-500).join('\n'));
  handle('admin:info', () => svc.adminInfo());
  handle('admin:player', (action, name, extra) => svc.adminPlayer(action, name, extra));
  handle('admin:world', (action, arg) => svc.adminWorld(action, arg));
  handle('admin:props', (patch) => svc.adminProperties(patch));
  handle('admin:rules', () => svc.adminGamerules());
  handle('admin:rule', (rule, v) => svc.adminSetGamerule(rule, v));
  handle('admin:restart', () => svc.restartServer());

  handle('catalog:status', () => svc.catalogStatus());
  handle('catalog:search', (source, q, pid) => svc.search(source, q, pid));
  handle('catalog:categories', (source) => svc.categories(source));
  handle('catalog:project', (source, id, pid, o) => svc.projectPage(source, id, pid, o));
  handle('mods:install', (pid, item) => svc.install(pid, item));
  handle('mods:plan', (pid, request) => svc.planMods(pid, request));
  handle('mods:apply', (planId, imports) => svc.applyPlan(planId, imports));
  handle('mods:cancel', () => svc.cancelMods());
  handle('mods:rollback', (pid) => svc.rollbackMods(pid));
  handle('mods:pin', (pid, key, v) => svc.setModPinned(pid, key, v));
  handle('mods:enable', (pid, key, v) => svc.setModEnabled(pid, key, v));
  handle('mods:icons', (pid) => svc.modIcons(pid));
  handle('mods:graph', (pid, key) => svc.modGraph(pid, key));
  handle('mods:folder', (pid) => svc.syncFolder(pid));
  handle('mods:folderToggle', (pid, file, on) => svc.folderToggle(pid, file, !!on));
  // удалить мод из папки — в корзину, а не насовсем: файл игрок принёс сам
  handle('mods:folderRemove', async (pid, file) => {
    if (svc.launcher.profileBusy(pid)) throw Object.assign(new Error('Сборку нельзя менять во время игры или работы сервера.'), { code: 'SESSION_ACTIVE' });
    await shell.trashItem(await svc.folderPath(pid, file));
    return true;
  });
  handle('mods:folderOpen', async (pid) => {
    await svc.store.getProfile(pid);
    const dir = path.join(svc.store.gameDir(pid), 'mods');
    await fs.promises.mkdir(dir, { recursive: true });
    const err = await shell.openPath(dir);
    if (err) throw new Error(err);
    return true;
  });
  handle('mods:pickFile', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Файл мода', filters: [{ name: 'Мод Minecraft', extensions: ['jar'] }], properties: ['openFile'] });
    return r.canceled ? null : r.filePaths[0];
  });

  handle('coop:start', async (req) => svc.startCoop(req, await launchAuth()));
  handle('coop:end', () => svc.endCoop());
  handle('room:open', async () => {
    const st = svc.launcher.status();
    return svc.openRoom(await launchAuth(), st.serverProfile, st.serverFolder);
  });
  handle('room:invite', (o) => svc.createInvite(o));
  handle('room:invites', () => svc.listInvites());
  handle('room:revoke', (id) => svc.revokeInvite(id));
  handle('guest:open', async (link) => svc.openInvite(link, await launchAuth()));
  handle('guest:prepare', (keys) => svc.prepareGuest(keys));
  handle('guest:connect', async () => svc.connectGuest(await launchAuth()));
  handle('guest:leave', () => svc.leaveGuest());

  handle('ai:status', () => svc.aiStatus());
  handle('ai:plan', (modelId) => svc.ai.plan(modelId));
  handle('ai:install', async (plan) => {
    // ставим только план, который лаунчер сам получил в ai:plan: адреса и пути из окна не принимаются
    const own = svc.ai.lastPlan;
    if (svc.ai.installing) throw new Error(`Уже скачивается ${svc.ai.installing.label} — дождись окончания.`);
    if (!own || own.model.id !== plan?.model?.id) throw new Error('Сначала узнай размер модели.');
    const r = await svc.ai.install(own, { onProgress: (p) => send('ai:progress', p) });
    await svc.aiStatus();
    return r;
  });
  handle('ai:uninstall', () => svc.ai.uninstall());
  handle('ai:unload', () => svc.ai.stop());
  handle('ai:ask', (text, pid, answers) => svc.ask(text, pid, answers));
  handle('ai:reroll', (taskId) => svc.rerollTask(taskId));
  // выполняется только задание, которое помощник сам подготовил в ai:ask: окно передаёт лишь его id
  handle('ai:run', (taskId) => svc.runTask(taskId));

  // гардероб: скины из окна приходят байтами (перетаскивание) и проверяются в ядре; скин аккаунта — только с токеном лаунчера
  handle('skins:list', () => svc.skins.list());
  handle('skins:add', (data) => svc.skins.add({ name: data?.name, model: data?.model, bytes: data?.bytes instanceof Uint8Array ? data.bytes : null }));
  handle('skins:pick', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Скин Minecraft (PNG 64×64)', filters: [{ name: 'Скин', extensions: ['png'] }], properties: ['openFile'] });
    return r.canceled ? null : svc.skins.addFile(r.filePaths[0]);
  });
  handle('skins:read', (file) => svc.skins.read(file));
  handle('skins:update', (id, patch) => svc.skins.update(id, patch));
  handle('skins:remove', (id) => svc.skins.remove(id));
  handle('skins:apply', async (id) => svc.skins.apply(id, await launchAuth()));
  handle('skins:account', async () => svc.skins.account(await launchAuth()));
  handle('skins:cape', async (capeId) => svc.skins.setCape(capeId, await launchAuth()));

  // камера воспоминаний: FFmpeg ставится только по кнопке игрока, адрес берёт ядро
  handle('memories:status', () => svc.memories.status());
  handle('memories:list', () => svc.memories.list());
  handle('memories:remove', (id) => svc.memories.remove(id));
  handle('memories:pin', (id, v) => svc.memories.pin(id, v));
  handle('memories:plan', () => svc.memories.plan());
  handle('memories:install', () => svc.memories.install({ onProgress: (p) => send('memories:progress', p) }));
  handle('memories:uninstall', () => svc.memories.uninstall());
  // проверка: 4 секунды окна самого лаунчера — его pid совпадает с главным процессом
  handle('memories:test', () => svc.memories.test(process.pid));
  handle('memories:film', (pid, from, to) => svc.memories.film({ profileId: String(pid || ''), from, to }));
  handle('memories:filmFolder', (file) => {
    // показать фильм в папке — только файл из папки фильмов камеры
    if (!svc.mediaAllowed(file)) throw new Error('Файл не из папки роликов.');
    shell.showItemInFolder(file);
  });
  handle('memories:folder', () => (fs.mkdirSync(svc.memories.dir, { recursive: true }), shell.openPath(svc.memories.dir)));

  handle('open:folder', (kind, pid, folder) => {
    let dir = root;
    if (kind === 'game') dir = svc.store.gameDir(pid);
    else if (kind === 'mods') dir = path.join(svc.store.gameDir(pid), 'mods');
    else if (kind === 'screenshots') dir = path.join(svc.store.gameDir(pid), 'screenshots');
    else if (kind === 'world') dir = svc.worlds.dir(pid, folder);
    else if (kind === 'backups') dir = svc.worlds.backupsDir(pid, folder);
    else if (kind === 'logs') dir = path.dirname(LOG_FILE);
    fs.mkdirSync(dir, { recursive: true });
    return shell.openPath(dir);
  });
  handle('open:external', (url) => {
    if (!/^https:\/\/(modrinth\.com|www\.curseforge\.com|aka\.ms|portal\.azure\.com|www\.minecraft\.net|ai\.google\.dev)\//.test(url)) throw new Error('Ссылка не разрешена.');
    return shell.openExternal(url);
  });
  handle('clipboard:write', (text) => require('electron').clipboard.writeText(String(text).slice(0, 2000)));

  createWindow();
});

// Перед выходом мир сохраняется штатной остановкой сервера, модель помощника выгружается
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('before-quit', async (e) => {
  if (quitting || !svc) return;
  e.preventDefault();
  quitting = true;
  await svc.shutdown().catch(() => {});
  app.quit();
});

app.on('window-all-closed', () => {
  if (!tray) app.quit();
});
