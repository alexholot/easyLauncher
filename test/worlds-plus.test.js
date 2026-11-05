'use strict';
// Летопись мира, карта, «Почему тормозило», вызовы, фильм сессии, скин сборки — на поддельных мирах обоих форматов
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { EventEmitter } = require('events');
const { write, parse } = require('../core/nbt');
const { readWorld, uuidFromInts } = require('../core/worlddata');
const { renderRegion, encodePng, packed, chunkTops, colorOf } = require('../core/worldmap');
const { Chronicle } = require('../core/chronicle');
const { PerfWatch } = require('../core/perf');
const { Challenges, parseChallenge, parseResult } = require('../core/challenges');
const { Memories, normalizeMemories } = require('../core/memories');
const { Services } = require('../core/services');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'easy-'));

/** Упаковать значения в 64-битные слова (как игра 1.16+: без переноса через границу слова). */
function pack(values, bits, count) {
  const per = Math.floor(64 / bits);
  const out = new BigInt64Array(Math.ceil(count / per));
  const words = new Array(out.length).fill(0n);
  values.forEach((v, i) => (words[Math.floor(i / per)] |= BigInt(v) << BigInt((i % per) * bits)));
  words.forEach((w, i) => (out[i] = BigInt.asIntN(64, w)));
  return out;
}

/** Чанк 1.18+: всё на высоте topY — блок palette[1], выше — воздух. */
function chunk({ dv = 3465, top = 70, palette = [{ Name: 'minecraft:air' }, { Name: 'minecraft:grass_block' }], status = 'minecraft:full' } = {}) {
  const sec = Math.floor(top / 16);
  const data = new Array(4096).fill(0);
  for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) data[((top & 15) * 16 + z) * 16 + x] = 1;
  return {
    DataVersion: dv,
    Status: status,
    xPos: 0,
    zPos: 0,
    yPos: -4,
    Heightmaps: { WORLD_SURFACE: pack(new Array(256).fill(top + 64 + 1), 9, 256) },
    sections: [{ Y: sec, block_states: { palette, data: pack(data, 4, 4096) } }],
  };
}

/** Файл региона с одним чанком в позиции 0 (сжатие zlib, как у игры). */
function region(chunkObj) {
  const body = zlib.deflateSync(write(chunkObj, { gzip: false }));
  const sectors = Math.ceil((body.length + 5) / 4096);
  const buf = Buffer.alloc(8192 + sectors * 4096);
  buf[0] = 0;
  buf[1] = 0;
  buf[2] = 2; // смещение: сектор 2
  buf[3] = sectors;
  buf.writeUInt32BE(body.length + 1, 8192);
  buf[8196] = 2;
  body.copy(buf, 8197);
  return buf;
}

test('мир: старый формат (level.dat с игроком) и 26.x (spawn, world_clocks, players/data)', async () => {
  const old = tmp();
  fs.writeFileSync(
    path.join(old, 'level.dat'),
    write({ Data: { LevelName: 'Старый', DataVersion: 3465, DayTime: 24000 * 6 + 100, Time: 300000, SpawnX: 10, SpawnY: 64, SpawnZ: -20, Player: { Pos: new Float64Array([1.5, 70, -3.2]), Dimension: 'minecraft:overworld', LastDeathLocation: { pos: new Int32Array([100, 12, -40]), dimension: 'minecraft:overworld' } } } }),
  );
  const a = await readWorld(old);
  assert.equal(a.day, 7);
  assert.deepEqual(a.spawn, [10, 64, -20]);
  assert.deepEqual(a.player, { pos: [1, 70, -4], dim: 'overworld' });
  assert.deepEqual(a.lastDeath, { pos: [100, 12, -40], dim: 'overworld' });
  assert.equal(a.regionDir, path.join(old, 'region'));

  const nw = tmp();
  const uuid = [228785654, -1372697503, -1644709693, 832079944];
  fs.writeFileSync(path.join(nw, 'level.dat'), write({ Data: { LevelName: 'Новый мир', DataVersion: 5023, Time: 17472, spawn: { pos: new Int32Array([0, 75, 32]), dimension: 'minecraft:overworld' }, singleplayer_uuid: new Int32Array(uuid) } }));
  fs.mkdirSync(path.join(nw, 'data', 'minecraft'), { recursive: true });
  fs.writeFileSync(path.join(nw, 'data', 'minecraft', 'world_clocks.dat'), write({ data: { 'minecraft:overworld': { total_ticks: 24000 * 3 + 5 } }, DataVersion: 5023 }));
  fs.mkdirSync(path.join(nw, 'players', 'data'), { recursive: true });
  fs.writeFileSync(path.join(nw, 'players', 'data', uuidFromInts(uuid) + '.dat'), write({ Pos: new Float64Array([9.5, 74, 22.5]), Dimension: 'minecraft:overworld', LastDeathLocation: { pos: new Int32Array([8906, 48, 1498]), dimension: 'minecraft:overworld' } }));
  fs.mkdirSync(path.join(nw, 'dimensions', 'minecraft', 'overworld', 'region'), { recursive: true });
  const b = await readWorld(nw);
  assert.equal(uuidFromInts(uuid), '0da2fdf6-ae2e-4c61-9df7-b8c331988848');
  assert.equal(b.day, 4);
  assert.equal(b.ticks, 24000 * 3 + 5);
  assert.deepEqual(b.spawn, [0, 75, 32]);
  assert.deepEqual(b.player, { pos: [9, 74, 22], dim: 'overworld' });
  assert.deepEqual(b.lastDeath, { pos: [8906, 48, 1498], dim: 'overworld' });
  assert.equal(b.regionDir, path.join(nw, 'dimensions', 'minecraft', 'overworld', 'region'));
});

test('карта: упаковка значений с переносом и без, верхний блок чанка, палитра 26.x, PNG', () => {
  // без переноса: 7 значений по 9 бит в слове
  const w = pack([5, 300, 511, 0, 1, 2, 3, 77], 9, 8);
  const buf = Buffer.alloc(w.length * 8);
  w.forEach((v, i) => buf.writeBigInt64BE(v, i * 8));
  assert.deepEqual([0, 1, 2, 7].map((i) => packed(buf, i, 9, false)), [5, 300, 511, 77]);
  // с переносом (1.13–1.15): значение номер 7 при 9 битах пересекает границу слова
  const sp = Buffer.alloc(16);
  let big = 0n;
  [1, 2, 3, 4, 5, 6, 7, 300].forEach((v, i) => (big |= BigInt(v) << BigInt(i * 9)));
  sp.writeBigUInt64BE(big & ((1n << 64n) - 1n), 0);
  sp.writeBigUInt64BE(big >> 64n, 8);
  assert.equal(packed(sp, 7, 9, true), 300);
  // верхний блок
  const tops = chunkTops(write(chunk(), { gzip: false }));
  assert.equal(tops[0].name, 'minecraft:grass_block');
  assert.equal(tops[0].y, 70);
  // 26.x: палитра {"": имя} и {id, properties}
  const t26 = chunkTops(write(chunk({ dv: 5023, palette: [{ '': 'minecraft:air' }, { id: 'minecraft:oak_leaves', properties: { distance: '2' } }] }), { gzip: false }));
  assert.equal(t26[255].name, 'minecraft:oak_leaves');
  // недогенерированный чанк не рисуется
  assert.equal(chunkTops(write(chunk({ status: 'minecraft:terrain' }), { gzip: false })), null);
  // регион → плитка: левый верхний чанк закрашен цветом травы, остальное прозрачно
  const r = renderRegion(region(chunk()), 3465);
  assert.equal(r.chunks, 1);
  const [gr, gg, gb] = colorOf('minecraft:grass_block');
  assert.deepEqual([...r.rgba.subarray(0, 4)], [gr, gg, gb, 255]);
  assert.equal(r.rgba[(20 * 512 + 20) * 4 + 3], 0);
  // PNG: подпись, размер и сжатые данные читаются обратно
  const png = encodePng(r.rgba, r.width, r.height);
  assert.deepEqual([...png.subarray(1, 4)], [0x50, 0x4e, 0x47]);
  assert.equal(png.readUInt32BE(16), 512);
  const idatLen = png.readUInt32BE(33);
  assert.equal(png.toString('latin1', 37, 41), 'IDAT');
  assert.equal(zlib.inflateSync(png.subarray(41, 41 + idatLen)).length, (512 * 4 + 1) * 512);
});

function fakeWorlds(root) {
  const store = { profileDir: (pid) => path.join(root, 'profiles', pid), gameDir: (pid) => path.join(root, 'profiles', pid, 'game') };
  return { store, worlds: { dir: (pid, folder) => path.join(root, 'profiles', pid, 'game', 'saves', folder) } };
}

test('летопись: первый вход, достижение с примерным местом, смерть с точным местом, сессия со скриншотами', async () => {
  const root = tmp();
  const { store, worlds } = fakeWorlds(root);
  const wdir = worlds.dir('p1', 'Мир');
  fs.mkdirSync(wdir, { recursive: true });
  const level = (pos, death) => fs.writeFileSync(path.join(wdir, 'level.dat'), write({ Data: { LevelName: 'Мир', DataVersion: 3465, DayTime: 24000 * 4, Time: 120, Player: { Pos: new Float64Array(pos), Dimension: 'minecraft:overworld', ...(death ? { LastDeathLocation: { pos: new Int32Array(death), dimension: 'minecraft:overworld' } } : {}) } } }));
  level([5, 64, 5]);
  const c = new Chronicle(store, worlds);
  const s = await c.begin('p1', 'Мир');
  assert.equal(s.isNew, true, 'мир моложе суток — новый');
  assert.equal(s.startDay, 5);
  level([50, 70, -20]);
  const adv = await c.moment(s, { kind: 'advancement', title: 'Алмазы!' });
  assert.deepEqual([adv.pos, adv.approx], [[50, 70, -20], true]);
  await c.moment(s, { kind: 'death', title: 'был убит Зомби' });
  fs.mkdirSync(path.join(store.gameDir('p1'), 'screenshots'), { recursive: true });
  fs.writeFileSync(path.join(store.gameDir('p1'), 'screenshots', 'shot1.png'), 'x');
  level([0, 64, 0], [7, 40, 9]);
  s.startedAt -= 120000; // играли 2 минуты
  await c.end(s, { shots: ['screenshots/shot1.png', '../../evil.png'], waitMs: 0 });
  const list = await c.list('p1', 'Мир', { worldName: 'Мир', clips: [{ id: 'k1', profileId: 'p1', world: 'Мир', at: new Date().toISOString(), file: 'c.mp4', seconds: 15 }] });
  const kinds = list.map((e) => e.kind);
  assert.deepEqual(kinds.slice().sort(), ['advancement', 'clip', 'death', 'first', 'session'].sort());
  assert.deepEqual(list.find((e) => e.kind === 'death').pos, [7, 40, 9]);
  const sess = list.find((e) => e.kind === 'session');
  assert.equal(sess.seconds, 120);
  assert.equal(sess.shots.length, 1, 'скриншот не из папки сборки не попадает');
  // второй вход: мир уже в летописи — для вызова не новый
  assert.equal((await c.begin('p1', 'Мир')).isNew, false);
  // старый мир, впервые открытый после обновления (больше суток игры), — тоже не новый
  const old = worlds.dir('p1', 'Старый');
  fs.mkdirSync(old, { recursive: true });
  fs.writeFileSync(path.join(old, 'level.dat'), write({ Data: { LevelName: 'Старый', DataVersion: 3465, DayTime: 900000, Time: 900000 } }));
  assert.equal((await c.begin('p1', 'Старый')).isNew, false);
  await c.forget('p1', 'Мир');
  assert.equal((await c.events('p1', 'Мир')).length, 0);
});

test('«Почему тормозило»: отставание мира, память впритык, нет модов оптимизации — с кнопками исправления', async () => {
  let t = 0;
  const p = new PerfWatch({ rss: async () => 5200, now: () => t });
  const gameDir = tmp();
  fs.writeFileSync(path.join(gameDir, 'options.txt'), 'version:3465\nrenderDistance:24\n');
  p.start({ pid: 1, profileId: 'p1', ramGb: 4, loader: 'fabric', mods: [{ slug: 'sodium' }, ...Array.from({ length: 30 }, (_, i) => ({ slug: 'm' + i }))], gameDir, totalRamGb: 32 });
  await p.sample();
  t = 90000;
  p.feed('[12:00:00] [Render thread/INFO]: Sound engine started');
  for (let i = 0; i < 4; i++) p.feed("[12:00:01] [Server thread/WARN]: Can't keep up! Is the server overloaded? Running 3100ms or 62 ticks behind");
  const r = p.stop({ seconds: 600 });
  const ids = r.issues.map((x) => x.id);
  assert.deepEqual(ids, ['ram', 'lag', 'mods', 'render']);
  assert.deepEqual(r.issues[0].fix, { type: 'ram', value: 6, label: 'Дать 6 ГБ' });
  assert.match(r.issues[2].text, /Lithium, FerriteCore/);
  assert.equal(r.loadMs, 90000);
  assert.equal(r.peakRssMb, 5200);
  // короткий запуск — разбирать нечего; нехватка памяти — первая и «плохая»
  p.start({ pid: 1, profileId: 'p1', ramGb: 2, loader: 'vanilla', mods: [], gameDir, totalRamGb: 8 });
  assert.equal(p.stop({ seconds: 30 }), null);
  p.start({ pid: 1, profileId: 'p1', ramGb: 2, loader: 'vanilla', mods: [], gameDir, totalRamGb: 8 });
  p.feed('Exception in thread "main" java.lang.OutOfMemoryError: Java heap space');
  const o = p.stop({ seconds: 300 });
  assert.equal(o.issues[0].id, 'oom');
  assert.equal(o.issues[0].level, 'bad');
});

test('вызов: код, привязка к новому миру, время только в нём, цель по названию достижения, код результата', async () => {
  const c = new Challenges(tmp());
  const code = c.create({ goal: 'diamond', limitMin: 30, rules: ['no_sleep', 'hack'], from: 'Steve' });
  assert.deepEqual(parseChallenge(code).rules, ['no_sleep'], 'неизвестное правило отбрасывается');
  assert.throws(() => parseChallenge('EL1-' + Buffer.from('{"g":"nope","l":5}').toString('base64url')), /неизвестная цель/);
  assert.throws(() => parseChallenge('привет'), /EL1-/);
  await c.accept(code);
  assert.equal(await c.worldBegin('p1', 'Старый', { isNew: false }), null, 'старый мир не берётся');
  const a = await c.worldBegin('p1', 'Новый', { isNew: true });
  assert.equal(a.folder, 'Новый');
  assert.equal(await c.moment('p1', 'Другой', { kind: 'advancement', title: 'Алмазы!' }, 'Me'), null, 'в другом мире не считается');
  assert.equal(await c.moment('p1', 'Новый', { kind: 'advancement', title: 'Каменный век' }, 'Me'), null);
  const done = await c.moment('p1', 'Новый', { kind: 'advancement', title: '[Алмазы!]' }, 'Me');
  assert.ok(done.done.inTime);
  assert.equal(done.goal.text, 'Найти алмаз');
  const res = parseResult(done.result);
  assert.equal(res.goal, 'diamond');
  assert.equal(res.nick, 'Me');
  assert.equal(res.seed, parseChallenge(code).seed);
  // англоязычная игра и многоточие в названии
  const c2 = new Challenges(tmp());
  await c2.accept(c2.create({ goal: 'iron', limitMin: 10 }));
  await c2.worldBegin('p', 'W', { isNew: true });
  assert.ok(await c2.moment('p', 'W', { kind: 'advancement', title: 'Acquire Hardware' }, 'X'));
  const st = await c2.status();
  assert.equal(st.history.length, 1);
  assert.match(c2.random('Me'), /^EL1-/);
});

test('сервисы: событие достижения → летопись, вызов и камера; ролик привязывается к событию; скин сборки', async () => {
  const root = tmp();
  const memories = Object.assign(new EventEmitter(), { moment: async () => ({ ok: true, clip: { id: 'clip42' } }), gameStarted() {}, gameStopped() {}, list: async () => [], dir: tmp() });
  const svc = new Services(root, { memories });
  const p = await svc.store.createProfile({ name: 'Т', minecraft: '1.21.1', loader: 'vanilla' });
  const wdir = svc.worlds.dir(p.id, 'Мир');
  fs.mkdirSync(wdir, { recursive: true });
  fs.writeFileSync(path.join(wdir, 'level.dat'), write({ Data: { LevelName: 'Мир', DataVersion: 3465, DayTime: 10, Time: 10, Player: { Pos: new Float64Array([1, 2, 3]), Dimension: 'minecraft:overworld' } } }));
  await svc.challenges.accept(svc.challenges.create({ goal: 'stone', limitMin: 10 }));
  await svc.chronicleBegin(p.id, 'Мир');
  svc.launcher.client = { player: 'Steve' };
  await svc.onMoment({ type: 'moment', profileId: p.id, kind: 'advancement', title: 'Каменный век' });
  svc.launcher.client = null;
  const { events } = await svc.chronicleList(p.id, 'Мир');
  const adv = events.find((e) => e.kind === 'advancement');
  assert.equal(adv.clip, 'clip42');
  assert.ok(events.some((e) => e.kind === 'challenge-done'));
  assert.ok((await svc.challenges.status()).active.done);
  // карта для мира без регионов: поддерживается, регионов нет, маркер достижения с местом
  const map = await svc.mapInfo(p.id, 'Мир');
  assert.equal(map.supported, true);
  assert.equal(map.regions.length, 0);
  assert.deepEqual(map.markers.find((m) => m.kind === 'advancement').pos, [1, 2, 3]);
  await assert.rejects(svc.mapTile(p.id, 'Мир', 1.5, 0), /Некорректный регион/);
  assert.equal(await svc.mapTile(p.id, 'Мир', 0, 0), null);
  // скин сборки: только образ из гардероба; без входа ничего не загружается
  await assert.rejects(svc.updateProfile(p.id, { skinId: 'nope' }), /нет в гардеробе/);
  const png = Buffer.alloc(40);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
  png.writeUInt32BE(13, 8);
  png.write('IHDR', 12, 'latin1');
  png.writeUInt32BE(64, 16);
  png.writeUInt32BE(64, 20);
  const skin = await svc.skins.add({ name: 'Рыцарь', bytes: png });
  const upd = await svc.updateProfile(p.id, { skinId: skin.id });
  assert.equal(upd.skinId, skin.id);
  assert.equal(await svc.applyBuildSkin(upd, null), null);
  assert.equal(await svc.applyBuildSkin({ skinId: 'gone' }, { accessToken: 't' }), 'Скин этой сборки удалён из гардероба — играешь в своём обычном.');
});

test('карта: плитка рисуется в отдельном потоке, кэшируется и перерисовывается, когда мир изменился', async () => {
  const root = tmp();
  const svc = new Services(root, { memories: Object.assign(new EventEmitter(), { list: async () => [], dir: tmp(), gameStarted() {}, gameStopped() {} }) });
  const p = await svc.store.createProfile({ name: 'К', minecraft: '1.21.1', loader: 'vanilla' });
  const wdir = svc.worlds.dir(p.id, 'Мир');
  fs.mkdirSync(path.join(wdir, 'region'), { recursive: true });
  fs.writeFileSync(path.join(wdir, 'level.dat'), write({ Data: { LevelName: 'Мир', DataVersion: 3465, SpawnX: 0, SpawnZ: 0 } }));
  const mca = path.join(wdir, 'region', 'r.0.0.mca');
  fs.writeFileSync(mca, region(chunk()));
  const info = await svc.mapInfo(p.id, 'Мир');
  assert.deepEqual(info.regions.map((r) => [r.x, r.z]), [[0, 0]]);
  const png = await svc.mapTile(p.id, 'Мир', 0, 0);
  assert.ok(png.endsWith('r.0.0.png') && fs.existsSync(png));
  assert.ok(svc.imageAllowed(png), 'плитку можно показать через easyimg');
  const t1 = fs.statSync(png).mtimeMs;
  assert.equal(await svc.mapTile(p.id, 'Мир', 0, 0), png);
  assert.equal(fs.statSync(png).mtimeMs, t1, 'без изменений — из кэша');
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(mca, later, later);
  await svc.mapTile(p.id, 'Мир', 0, 0);
  assert.ok(fs.statSync(png).mtimeMs >= later.getTime() - 1000 || fs.statSync(png).mtimeMs > t1, 'регион изменился — плитка новая');
  // старый мир до 1.13 — честный отказ
  fs.writeFileSync(path.join(wdir, 'level.dat'), write({ Data: { LevelName: 'Мир', DataVersion: 1343 } }));
  assert.equal((await svc.mapInfo(p.id, 'Мир')).supported, false);
});

test('картинки модов сборки: одним запросом, только CDN каталогов, кэш, без сети — из кэша', async (t) => {
  const http = require('../core/http');
  const root = tmp();
  const svc = new Services(root, { memories: Object.assign(new EventEmitter(), { list: async () => [], dir: tmp(), gameStarted() {}, gameStopped() {} }) });
  const p = await svc.store.createProfile({ name: 'М', minecraft: '1.20.1', loader: 'fabric' });
  const lock = await svc.store.getLock(p.id);
  lock.mods = [
    { key: 'modrinth:AANobbMI', source: 'modrinth', projectId: 'AANobbMI', name: 'Sodium' },
    { key: 'modrinth:evilEvil', source: 'modrinth', projectId: 'evilEvil', name: 'Чужой' },
    { key: 'file:x', source: 'file', name: 'Свой.jar' },
  ];
  await svc.store.saveLock(p.id, lock);
  let calls = 0;
  http.setFetch(async (url) => {
    calls++;
    assert.match(url, /\/projects\?ids=/);
    return new Response(JSON.stringify([{ id: 'AANobbMI', slug: 'sodium', title: 'Sodium', icon_url: 'https://cdn.modrinth.com/data/AANobbMI/icon.png' }, { id: 'evilEvil', slug: 'e', title: 'E', icon_url: 'https://evil.example/x.png' }]), { status: 200 });
  });
  t.after(() => http.setFetch((...a) => globalThis.fetch(...a)));
  const a = await svc.modIcons(p.id);
  assert.equal(a['modrinth:AANobbMI'], 'https://cdn.modrinth.com/data/AANobbMI/icon.png');
  assert.equal(a['modrinth:evilEvil'], null, 'адрес не с CDN каталога не отдаётся');
  assert.equal(a['file:x'], null);
  assert.equal(calls, 1, 'один запрос на все моды');
  http.setFetch(async () => {
    throw new Error('нет сети');
  });
  const b = await svc.modIcons(p.id);
  assert.equal(b['modrinth:AANobbMI'], 'https://cdn.modrinth.com/data/AANobbMI/icon.png', 'из кэша');
});

test('фильм сессии: ролики сессии подряд, приведённые к 1280×720; меньше двух — понятный отказ', async () => {
  const root = tmp();
  const bundled = path.join(root, 'res');
  fs.mkdirSync(bundled, { recursive: true });
  fs.writeFileSync(path.join(bundled, 'ffmpeg.exe'), 'x');
  let filmArgs = null;
  const spawn = (exe, args) => {
    const p = new EventEmitter();
    p.stderr = new EventEmitter();
    p.kill = () => {};
    if (args.includes('-filter_complex')) {
      filmArgs = args;
      fs.writeFileSync(args[args.length - 1], 'film');
    }
    setImmediate(() => p.emit('close', 0));
    return p;
  };
  const m = new Memories(root, { bundled, settings: async () => normalizeMemories({}), spawn, window: { foreground: () => null, screens: () => null, available: () => true } });
  fs.mkdirSync(m.dir, { recursive: true });
  const now = Date.now();
  const clips = [
    { id: 'a1a1a1', at: new Date(now - 300000).toISOString(), profileId: 'p1', seconds: 15 },
    { id: 'b2b2b2', at: new Date(now - 100000).toISOString(), profileId: 'p1', seconds: 10 },
    { id: 'c3c3c3', at: new Date(now - 100000).toISOString(), profileId: 'p2', seconds: 10 },
  ];
  for (const c of clips) fs.writeFileSync(m.clipFile(c.id), 'v');
  fs.writeFileSync(m.indexFile, JSON.stringify({ clips }));
  const r = await m.film({ profileId: 'p1', from: new Date(now - 400000).toISOString(), to: new Date(now).toISOString() });
  assert.equal(r.clips, 2);
  assert.equal(r.seconds, 25);
  assert.ok(fs.existsSync(r.file));
  const fc = filmArgs[filmArgs.indexOf('-filter_complex') + 1];
  assert.match(fc, /concat=n=2:v=1:a=0/);
  assert.match(fc, /pad=1280:720/);
  await assert.rejects(m.film({ profileId: 'p2', from: new Date(now - 400000).toISOString(), to: new Date(now).toISOString() }), /хотя бы два ролика/);
});
