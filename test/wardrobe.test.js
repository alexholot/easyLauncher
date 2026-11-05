'use strict';
// Гардероб (скины и плащи) и «Камера воспоминаний» (расписание, захват, ротация) — без сети и без FFmpeg
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const http = require('../core/http');
const { Skins, pngSize, checkSkin, textureUrl } = require('../core/skins');
const { Memories, normalizeMemories, pickFfmpeg, captureArgs } = require('../core/memories');
const { Services } = require('../core/services');
const { SessionTracker, parseMoment } = require('../core/sessionlog');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'easy-'));
/** Заголовок PNG нужного размера (ядро смотрит только сигнатуру и IHDR). */
function png(w, h, salt = 0) {
  const b = Buffer.alloc(40);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  b.writeUInt32BE(salt, 36);
  return b;
}

test('скин: проверка PNG и размера', () => {
  assert.deepEqual(pngSize(png(64, 64)), { width: 64, height: 64 });
  assert.equal(pngSize(Buffer.from('not a png at all, definitely not')), null);
  assert.doesNotThrow(() => checkSkin(png(64, 32)));
  assert.throws(() => checkSkin(png(128, 128)), /64×64/);
  assert.throws(() => checkSkin(Buffer.from('GIF89a-----------------------')), /не картинка PNG/);
  assert.equal(textureUrl('http://textures.minecraft.net/texture/abcdef0123456789abcdef'), 'https://textures.minecraft.net/texture/abcdef0123456789abcdef');
  assert.equal(textureUrl('https://evil.example/texture/abcdef0123456789abcdef'), null);
});

test('гардероб: добавить, повтор, модель, избранное, удалить, чтение только своих файлов', async () => {
  const root = tmp();
  const s = new Skins(root);
  const a = await s.add({ name: 'Рыцарь.png', model: 'slim', bytes: png(64, 64, 1) });
  assert.equal(a.name, 'Рыцарь');
  assert.equal(a.model, 'slim');
  const again = await s.add({ name: 'копия', bytes: png(64, 64, 1) });
  assert.equal(again.duplicate, true);
  assert.equal(again.id, a.id);
  await s.add({ name: 'Второй', bytes: png(64, 64, 2) });
  let list = await s.list();
  assert.equal(list.items.length, 2);
  await s.update(a.id, { model: 'classic', favorite: true });
  list = await s.list();
  assert.equal(list.items.find((x) => x.id === a.id).model, 'classic');
  assert.equal(list.items.find((x) => x.id === a.id).favorite, true);
  await assert.rejects(s.update(a.id, { model: 'giant' }));
  assert.equal((await s.read(a.file)).length, 40);
  await assert.rejects(s.read(path.join(root, 'settings.png')), /не из гардероба/);
  await assert.rejects(s.read(path.join(s.dir, '..', '..', 'x.png')), /не из гардероба/);
  await s.remove(a.id);
  list = await s.list();
  assert.equal(list.items.length, 1);
  assert.equal(fs.existsSync(a.file), false);
});

test('гардероб: «Надеть» без входа — только выбор; со входом — загрузка в профиль Minecraft', async (t) => {
  const s = new Skins(tmp());
  const it = await s.add({ name: 'Alex', model: 'slim', bytes: png(64, 64, 3) });
  assert.deepEqual(await s.apply(it.id, null), { uploaded: false });
  assert.equal((await s.list()).active, it.id);
  const calls = [];
  http.setFetch(async (url, o) => {
    calls.push({ url, method: o.method, auth: o.headers.Authorization, body: o.body });
    return new Response('{}', { status: 200 });
  });
  t.after(() => http.setFetch((...a) => globalThis.fetch(...a)));
  assert.deepEqual(await s.apply(it.id, { accessToken: 'tok' }), { uploaded: true });
  assert.equal(calls[0].url, 'https://api.minecraftservices.com/minecraft/profile/skins');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].auth, 'Bearer tok');
  assert.equal(calls[0].body.get('variant'), 'slim');
  assert.equal(calls[0].body.get('file').size, 40);
  http.setFetch(async () => new Response('{}', { status: 401 }));
  await assert.rejects(s.apply(it.id, { accessToken: 'old' }), (e) => e.code === 'AUTH_REQUIRED');
});

test('гардероб: скин и плащи аккаунта скачиваются только с textures.minecraft.net', async (t) => {
  const s = new Skins(tmp());
  const urls = [];
  http.setFetch(async (url) => {
    urls.push(url);
    if (url.endsWith('/minecraft/profile'))
      return new Response(
        JSON.stringify({
          name: 'Steve',
          skins: [{ state: 'ACTIVE', url: 'http://textures.minecraft.net/texture/aaaaaaaaaaaaaaaaaaaa11', variant: 'SLIM' }],
          capes: [
            { id: 'cape-1', state: 'ACTIVE', alias: 'Migrator', url: 'http://textures.minecraft.net/texture/bbbbbbbbbbbbbbbbbbbb22' },
            { id: 'cape-2', state: 'INACTIVE', alias: 'Чужой', url: 'https://evil.example/texture/cccccccccccccccccccc33' },
          ],
        }),
        { status: 200 },
      );
    return new Response(png(64, 64), { status: 200 });
  });
  t.after(() => http.setFetch((...a) => globalThis.fetch(...a)));
  const acc = await s.account({ accessToken: 'tok' });
  assert.equal(acc.skin.model, 'slim');
  assert.ok(fs.existsSync(acc.skin.file));
  assert.deepEqual(acc.capes.map((c) => [c.id, c.active]), [['cape-1', true]]);
  assert.ok(!urls.some((u) => u.includes('evil.example')));
  assert.ok(urls.filter((u) => u.includes('textures')).every((u) => u.startsWith('https://')));
  assert.equal(await s.account(null), null);
});

test('камера: настройки только из известных значений', () => {
  assert.deepEqual(normalizeMemories({}), { record: false, background: true, moments: true, deaths: true, interval: 15, keep: 20, quality: 720, length: 15 });
  assert.deepEqual(normalizeMemories({ record: true, background: false, deaths: false, interval: 7, keep: 30, quality: 1080, length: 99 }), { record: true, background: false, moments: true, deaths: false, interval: 15, keep: 30, quality: 1080, length: 15 });
});

test('камера: выбор сборки FFmpeg по списку хешей выпуска', () => {
  const h = (c) => c.repeat(64);
  const list = [
    `${h('a')}  ffmpeg-master-latest-win64-gpl-shared.zip`,
    `${h('b')}  ffmpeg-n8.1-latest-win64-gpl-shared-8.1.zip`,
    `${h('c')}  ffmpeg-n9.0-latest-win64-gpl-shared-9.0.zip`,
    `${h('d')}  ffmpeg-n9.0-latest-win64-lgpl-shared-9.0.zip`,
    `${h('f')}  ffmpeg-n8.1-latest-win64-lgpl-shared-8.1.zip`,
    `${h('e')}  ffmpeg-n9.0-latest-linux64-lgpl-shared-9.0.tar.xz`,
  ].join('\n');
  const p = pickFfmpeg(list);
  assert.equal(p.name, 'ffmpeg-n9.0-latest-win64-lgpl-shared-9.0.zip');
  assert.equal(p.sha256, h('d'));
  assert.equal(p.url, 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n9.0-latest-win64-lgpl-shared-9.0.zip');
  assert.equal(pickFfmpeg('мусор'), null);
});

test('камера: аргументы захвата — область окна, чётные размеры, смещения ddagrab/gdigrab', () => {
  const rect = { x: 101, y: 51, width: 1281, height: 721 };
  const dda = captureArgs({ grabber: 'ddagrab', encoder: 'h264_nvenc', rect, screens: { left: 0, top: 0, width: 1920, height: 1080 }, seconds: 15, quality: 720, out: 'o.mp4' });
  assert.ok(dda.includes('ddagrab=output_idx=0:framerate=30:draw_mouse=0:offset_x=101:offset_y=51:video_size=1280x720'));
  assert.ok(dda.includes('hwdownload,format=bgra,scale=-2:720:flags=bilinear,format=yuv420p'));
  assert.ok(dda.includes('-an'));
  assert.deepEqual(dda.slice(dda.indexOf('-c:v'), dda.indexOf('-c:v') + 4), ['-c:v', 'h264_nvenc', '-preset', 'p1']);
  // второй монитор слева: окно частично за краем виртуального экрана — пишем видимую часть
  const gdi = captureArgs({ grabber: 'gdigrab', encoder: 'libx264', rect: { x: -1930, y: 0, width: 1920, height: 1080 }, screens: { left: -1920, top: 0, width: 3840, height: 1080 }, seconds: 10, quality: 1080, out: 'o.mp4' });
  assert.deepEqual(gdi.slice(gdi.indexOf('-offset_x'), gdi.indexOf('-offset_x') + 6), ['-offset_x', '-1920', '-offset_y', '0', '-video_size', '1910x1080']);
  assert.ok(gdi.includes('ultrafast'));
});

/** Поддельный FFmpeg: пишет файл-ролик и завершается сам или по «q». */
function fakeSpawn(log) {
  return (exe, args, opts) => {
    const p = new EventEmitter();
    p.pid = 0;
    p.stderr = new EventEmitter();
    const out = args[args.length - 1];
    const isProbe = args.includes('null');
    const isThumb = out.endsWith('.jpg');
    log.push(isProbe ? 'probe' : isThumb ? 'thumb' : 'record');
    let done = false;
    const finish = (code) => {
      if (done) return;
      done = true;
      if (!isProbe) fs.writeFileSync(out, Buffer.alloc(isThumb ? 100 : 20000));
      setImmediate(() => p.emit('close', code));
    };
    p.stdin = { write: (c) => c === 'q' && finish(0) };
    p.kill = () => finish(1);
    const t = Number(args[args.indexOf('-t') + 1]);
    setTimeout(() => finish(0), isProbe || isThumb ? 5 : t * 20);
    return p;
  };
}

test('камера: пишет только активное окно игры в мире, по расписанию; короткие ролики не сохраняет; ротация бережёт закреплённые', async () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, 'ffmpeg', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'ffmpeg', 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'), '');
  const settings = { record: true, background: true, interval: 5, keep: 2, quality: 720, length: 10 };
  const win = { fg: { pid: 77, minimized: false, rect: { x: 0, y: 0, width: 1280, height: 720 } } };
  const log = [];
  const m = new Memories(root, {
    settings: async () => settings,
    window: { foreground: () => win.fg, screens: () => ({ left: 0, top: 0, width: 1920, height: 1080, monitors: 1 }), available: () => true },
    spawn: fakeSpawn(log),
    tickMs: 60000,
    guardMs: 10,
  });
  m.supported = () => true;
  let level = null;
  m.gameStarted({ pid: 77, profileId: 'p1', profileName: 'Сборка', level: () => level });
  clearInterval(m.timer); // такты вызываем вручную
  // в главном меню время не идёт
  for (let i = 0; i < 5; i++) await m.tick();
  assert.equal(m.game.activeMs, 0);
  level = 'Мой мир';
  await m.tick();
  await m.tick();
  assert.equal(log.filter((x) => x === 'record').length, 0, 'до первого ролика нужно 3 минуты игры');
  await m.tick(); // 3 минуты
  assert.deepEqual(log, ['probe', 'record', 'thumb']);
  let clips = await m.list();
  assert.equal(clips.length, 1);
  assert.equal(clips[0].world, 'Мой мир');
  assert.equal(clips[0].profile, 'Сборка');
  assert.ok(clips[0].thumb);
  // другое окно активно — время не считается
  win.fg = { pid: 5, rect: { x: 0, y: 0, width: 800, height: 600 } };
  for (let i = 0; i < 10; i++) await m.tick();
  assert.equal(m.game.activeMs, 3 * 60000);
  // ещё два ролика по интервалу 5 минут
  win.fg = { pid: 77, minimized: false, rect: { x: 0, y: 0, width: 1280, height: 720 } };
  await m.pin(clips[0].id, true);
  for (let i = 0; i < 10; i++) await m.tick();
  clips = await m.list();
  assert.equal(clips.length, 2, 'хранится не больше keep');
  assert.ok(clips.some((c) => c.pinned), 'закреплённый ролик не удаляется ротацией');
  // окно свернули во время записи — ролик короче 6 с не сохраняется
  const before = (await m.list()).length;
  const rec = m.record({ rect: win.fg.rect, seconds: 10, quality: 720, watch: true, meta: {} });
  await new Promise((r) => setTimeout(r, 30));
  win.fg = { pid: 77, minimized: true };
  const r = await rec;
  assert.equal(r.ok, false);
  assert.equal(r.short, true);
  assert.equal((await m.list()).length, before);
  m.gameStopped();
  assert.equal(m.timer, null);
});

test('камера: FFmpeg из установщика — сразу готов, не удаляется; смена FFmpeg — новая проба кодировщика', async () => {
  const root = tmp();
  const bundled = path.join(root, 'app-resources', 'ffmpeg');
  fs.mkdirSync(bundled, { recursive: true });
  fs.writeFileSync(path.join(bundled, 'ffmpeg.exe'), 'v1');
  const log = [];
  const m = new Memories(root, {
    bundled,
    settings: async () => normalizeMemories({ record: true }),
    window: { foreground: () => null, screens: () => ({ left: 0, top: 0, width: 1920, height: 1080, monitors: 1 }), available: () => true },
    spawn: fakeSpawn(log),
  });
  assert.equal(m.ffmpeg(), path.join(bundled, 'ffmpeg.exe'));
  assert.equal(m.installed(), true);
  assert.equal((await m.status()).bundled, true);
  await assert.rejects(m.uninstall(), /входит в лаунчер/);
  const rect = { x: 0, y: 0, width: 1280, height: 720 };
  await m.record({ rect, seconds: 1, quality: 720, test: true });
  await m.record({ rect, seconds: 1, quality: 720, test: true });
  assert.equal(log.filter((x) => x === 'probe').length, 1, 'кодировщик ищется один раз');
  fs.writeFileSync(path.join(bundled, 'ffmpeg.exe'), 'v2 — новый FFmpeg после обновления');
  await m.record({ rect, seconds: 1, quality: 720, test: true });
  assert.equal(log.filter((x) => x === 'probe').length, 2, 'после обновления FFmpeg — новая проба');
});

test('моменты из журнала игры: достижения, испытания, цели, смерти; не путает вход, чат и чужие события', () => {
  const P = 'AlexHolot052';
  const kind = (l) => parseMoment(l, P)?.kind || null;
  // Minecraft 26.x: сервер пишет «System chat:», клиент — «[System] [CHAT]», официальный журнал — XML
  assert.deepEqual(parseMoment('[01:20:05] [Server thread/INFO]: System chat: AlexHolot052 получил достижение «[Каменный век]»', P), { kind: 'advancement', title: 'Каменный век', text: 'AlexHolot052 получил достижение «[Каменный век]»' });
  assert.equal(parseMoment('<log4j:Message><![CDATA[[System] [CHAT] AlexHolot052 завершил испытание «[Как мы сюда попали?]»]]></log4j:Message>', P).kind, 'challenge');
  assert.equal(parseMoment('[12:00:00] [Render thread/INFO]: [CHAT] AlexHolot052 has reached the goal [The End?]', P).title, 'The End?');
  assert.equal(kind('[12:00:00] [Server thread/INFO]: AlexHolot052 has made the advancement [Diamonds!]'), 'advancement'); // старые версии
  assert.equal(kind('[12:00:00] [Server thread/INFO]: System chat: AlexHolot052 был убит Зомби'), 'death');
  assert.equal(kind('[12:00:00] [Render thread/INFO]: [System] [CHAT] AlexHolot052 fell from a high place'), 'death');
  assert.equal(kind('[12:00:00] [Server thread/INFO]: AlexHolot052 drowned'), 'death'); // без пометки чата — по глаголу
  assert.equal(kind('[00:44:46] [Server thread/INFO]: System chat: AlexHolot052 присоединился к игре'), null);
  assert.equal(kind('[00:58:20] [Server thread/INFO]: System chat: AlexHolot052 покинул игру'), null);
  assert.equal(kind('[12:00:00] [Server thread/INFO]: AlexHolot052[local:E:1a2b] logged in with entity id 5 at (1, 2, 3)'), null);
  assert.equal(kind('[12:00:00] [Server thread/INFO]: AlexHolot052 lost connection: Disconnected'), null);
  assert.equal(kind('[12:00:00] [Render thread/INFO]: [System] [CHAT] <AlexHolot052> получил достижение лол'), null); // своё сообщение в чат
  assert.equal(kind('[12:00:00] [Server thread/INFO]: System chat: Friend1 получил достижение «[Алмазы!]»'), null); // чужое
  assert.equal(kind('[12:00:00] [Server thread/INFO]: AlexHolot052 joined the game'), null);
  assert.equal(parseMoment('AlexHolot052 получил достижение «[X]»', null), null);
  // одно событие от сервера и клиента — один момент
  const tr = new SessionTracker({ player: P });
  const got = [];
  tr.on('moment', (m) => got.push(m.kind));
  tr.feed('[01:20:05] [Server thread/INFO]: System chat: AlexHolot052 получил достижение «[Каменный век]»');
  tr.feed('[01:20:05] [Render thread/INFO]: [System] [CHAT] AlexHolot052 получил достижение «[Каменный век]»');
  tr.feed('[01:20:09] [Server thread/INFO]: System chat: AlexHolot052 разбился вдребезги');
  assert.deepEqual(got, ['advancement', 'death']);
});

/** Поддельный FFmpeg с буфером: кольцо кусков и их список; склейка concat пишет ролик. */
function bufferSpawn(log, { crash = false } = {}) {
  return (exe, args) => {
    const p = new EventEmitter();
    p.pid = 0;
    p.stderr = new EventEmitter();
    const out = args[args.length - 1];
    let done = false;
    const finish = (code) => {
      if (done) return;
      done = true;
      setImmediate(() => p.emit('close', code));
    };
    p.stdin = { write: (c) => c === 'q' && finish(0) };
    p.kill = () => finish(1);
    if (args.includes('segment')) {
      log.push('buffer');
      if (crash) {
        p.stderr.emit('data', 'Error: frames not supported');
        setTimeout(() => finish(1), 5);
        return p;
      }
      const dir = path.dirname(out);
      const names = [];
      for (let i = 0; i < 8; i++) {
        const n = `buf${String(i).padStart(2, '0')}.ts`;
        fs.writeFileSync(path.join(dir, n), Buffer.alloc(5000));
        names.push(`${n},${i * 2},${i * 2 + 2}`);
      }
      fs.writeFileSync(path.join(dir, 'list.csv'), names.join('\n'));
      return p; // работает, пока не скажут «q»
    }
    const kind = args.includes('null') ? 'probe' : args.includes('concat') ? 'concat' : out.endsWith('.jpg') ? 'thumb' : 'record';
    log.push(kind);
    if (kind === 'concat') {
      const list = fs.readFileSync(args[args.indexOf('-i') + 1], 'utf8');
      log.push('pieces:' + list.split('\n').length);
    }
    if (kind !== 'probe') fs.writeFileSync(out, Buffer.alloc(kind === 'thumb' ? 100 : 20000));
    const t = Number(args[args.indexOf('-t') + 1]) || 0;
    setTimeout(() => finish(0), kind === 'record' ? t * 20 : 5);
    return p;
  };
}

test('камера: буфер моментов — достижение даёт ролик из последних секунд, серия подряд — один ролик, окно ушло — буфер стоп', async () => {
  const root = tmp();
  const bundled = path.join(root, 'res');
  fs.mkdirSync(bundled, { recursive: true });
  fs.writeFileSync(path.join(bundled, 'ffmpeg.exe'), 'x');
  const settings = normalizeMemories({ record: true, length: 10 });
  const win = { fg: { pid: 77, minimized: false, rect: { x: 0, y: 0, width: 1920, height: 1080 } } };
  const log = [];
  const m = new Memories(root, {
    bundled,
    settings: async () => settings,
    window: { foreground: () => win.fg, screens: () => ({ left: 0, top: 0, width: 1920, height: 1080, monitors: 1 }), available: () => true },
    spawn: bufferSpawn(log),
    tickMs: 5000,
    cutDelayMs: 5,
  });
  m.gameStarted({ pid: 77, profileId: 'p1', profileName: 'Сборка', level: () => 'Мой мир' });
  clearInterval(m.timer);
  await m.tick();
  assert.ok(m.buffer, 'буфер запущен');
  assert.equal((await m.status()).momentsMode, 'buffer');
  m.buffer.started -= 30000;
  const r = await m.moment({ kind: 'advancement', title: 'Каменный век' });
  assert.equal(r.ok, true);
  assert.ok(log.includes('pieces:5'), 'ролик 10 с = 5 последних кусков по 2 с');
  assert.deepEqual(r.clip.moment, { kind: 'advancement', title: 'Каменный век' });
  assert.equal((await m.moment({ kind: 'death', title: 'утонул' })).cooldown, true);
  assert.equal((await m.list()).length, 1);
  assert.ok(!fs.readdirSync(m.dir).some((n) => n.startsWith('cut-')), 'временные куски убраны');
  // игрок свернул игру — буфер останавливается
  win.fg = { pid: 5, rect: { x: 0, y: 0, width: 800, height: 600 } };
  await m.tick();
  assert.equal(m.buffer, null);
  m.gameStopped();
});

test('камера: кодировщик без прямых кадров — буфер отключается сам, моменты пишутся после события', async () => {
  const root = tmp();
  const bundled = path.join(root, 'res');
  fs.mkdirSync(bundled, { recursive: true });
  fs.writeFileSync(path.join(bundled, 'ffmpeg.exe'), 'x');
  const settings = normalizeMemories({ record: true, length: 10 });
  const win = { fg: { pid: 77, minimized: false, rect: { x: 0, y: 0, width: 1280, height: 720 } } };
  const log = [];
  const m = new Memories(root, {
    bundled,
    settings: async () => settings,
    window: { foreground: () => win.fg, screens: () => ({ left: 0, top: 0, width: 1920, height: 1080, monitors: 1 }), available: () => true },
    spawn: bufferSpawn(log, { crash: true }),
    tickMs: 5000,
    guardMs: 10,
  });
  m.gameStarted({ pid: 77, profileId: 'p1', profileName: 'Сборка', level: () => 'Мой мир' });
  clearInterval(m.timer);
  await m.tick();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(m.buffer, null);
  assert.equal((await m.status()).momentsMode, 'after');
  await m.tick();
  assert.equal(log.filter((x) => x === 'buffer').length, 1, 'после отказа буфер больше не запускается');
  const r = await m.moment({ kind: 'challenge', title: 'Как мы сюда попали?' });
  assert.equal(r.ok, true);
  assert.equal(r.clip.moment.kind, 'challenge');
  assert.ok(log.includes('record'));
  m.gameStopped();
});

test('камера: такты не накладываются, момент во время сохранения не тратит паузу', async () => {
  const root = tmp();
  const bundled = path.join(root, 'res');
  fs.mkdirSync(bundled, { recursive: true });
  fs.writeFileSync(path.join(bundled, 'ffmpeg.exe'), 'x');
  const m = new Memories(root, {
    bundled,
    settings: async () => normalizeMemories({ record: true }),
    window: { foreground: () => ({ pid: 77, rect: { x: 0, y: 0, width: 1280, height: 720 } }), screens: () => ({ monitors: 1, left: 0, top: 0, width: 1920, height: 1080 }), available: () => true },
    spawn: bufferSpawn([]),
  });
  let inside = 0;
  let maxInside = 0;
  m.tickNow = async () => {
    inside++;
    maxInside = Math.max(maxInside, inside);
    await new Promise((r) => setTimeout(r, 30));
    inside--;
  };
  await Promise.all([m.tick(), m.tick(), m.tick()]);
  assert.equal(maxInside, 1);
  m.game = { pid: 77, profileId: 'p', profileName: '', level: () => 'Мир', activeMs: 0, nextAt: 0, failures: 0 };
  m.saving = true;
  assert.equal((await m.moment({ kind: 'advancement', title: 'А' })).busy, true);
  assert.equal(m.lastMomentAt, undefined, 'пауза между моментами не началась');
  m.saving = false;
});

test('настройки: своё окно игры без правильного размера не сохраняется молча', async () => {
  const svc = new Services(tmp());
  await assert.rejects(svc.saveSettings({ window: { width: 100, height: 900, fullscreen: false } }), /Размер окна/);
  assert.equal((await svc.settings()).window, null);
  assert.deepEqual((await svc.saveSettings({ window: { width: 1600, height: 900, fullscreen: false } })).window, { width: 1600, height: 900, fullscreen: false });
  assert.equal((await svc.saveSettings({ window: { fullscreen: true } })).window.fullscreen, true);
});

test('момент из журнала игры доходит до камеры: событие лаунчера → Services → Memories.moment', async () => {
  const got = [];
  const memories = Object.assign(new EventEmitter(), { moment: async (m) => got.push(m), gameStarted() {}, gameStopped() {}, dir: tmp() });
  const svc = new Services(tmp(), { memories });
  const tr = new SessionTracker({ player: 'Steve' });
  tr.on('moment', (m) => svc.launcher.emit('event', { type: 'moment', profileId: 'p1', ...m }));
  tr.feed('[10:00:00] [Server thread/INFO]: Steve has completed the challenge [How Did We Get Here?]');
  await new Promise((r) => setImmediate(r));
  assert.equal(got.length, 1);
  assert.equal(got[0].kind, 'challenge');
  assert.equal(got[0].title, 'How Did We Get Here?');
});

test('настройки: камера и новые темы проходят через белый список; видео — только из папки роликов', async () => {
  const root = tmp();
  const svc = new Services(root);
  let s = await svc.settings();
  assert.equal(s.appearance.style, 'lush');
  assert.equal(s.memories.record, false);
  s = await svc.saveSettings({ memories: { record: true, interval: 10 }, appearance: { style: 'deepdark' } });
  assert.equal(s.memories.record, true);
  assert.equal(s.memories.interval, 10);
  assert.equal(s.memories.keep, 20);
  assert.equal(s.appearance.style, 'deepdark');
  s = await svc.saveSettings({ appearance: { style: 'nope' } });
  assert.equal(s.appearance.style, 'lush');
  fs.mkdirSync(svc.memories.dir, { recursive: true });
  const clip = path.join(svc.memories.dir, 'a1b2c3d4.mp4');
  fs.writeFileSync(clip, 'x');
  fs.writeFileSync(path.join(root, 'other.mp4'), 'x');
  assert.equal(svc.mediaAllowed(clip), true);
  assert.equal(svc.mediaAllowed(path.join(root, 'other.mp4')), false);
  assert.equal(svc.mediaAllowed(path.join(svc.memories.dir, '..', 'other.mp4')), false);
  assert.equal(svc.mediaAllowed(path.join(svc.memories.dir, 'index.json')), false);
});
