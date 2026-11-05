'use strict';
// Поиск виновника вылета пробными запусками и проверка после обновления (поддельная игра падает от нужных модов)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { Launcher } = require('../core/launcher');
const { Services } = require('../core/services');
const { buildFixtures, testLauncher } = require('./helpers');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'easy-c-'));
const made = [];
test.beforeEach(() => (process.env.EASY_PROBE_GRACE_MS = '200'));
test.afterEach(async () => {
  for (const s of made.splice(0)) await s.launcher.shutdown();
  for (const k of ['FAKE_PROBE', 'FAKE_CRASH_IF_MOD', 'FAKE_CRASH_IF_BOTH', 'EASY_PROBE_GRACE_MS']) delete process.env[k];
});

/** Запись мода, файл которого уже в кэше лаунчера. */
function entry(l, name, { deps = [], version = '1', addedBy = 'user' } = {}) {
  const bytes = Buffer.from(`jar:${name}:${version}`);
  const sha1 = crypto.createHash('sha1').update(bytes).digest('hex');
  const file = { filename: `${name}-${version}.jar`, url: null, size: bytes.length, hashes: { sha1 } };
  const dest = l.cache.pathFor(file);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, bytes);
  return { key: `modrinth:${name}`, source: 'modrinth', projectId: name, name, versionId: `${name}-${version}`, version, side: { client: 'required', server: 'required' }, file, dependencies: deps.map((d) => ({ key: `modrinth:${d}`, kind: 'required' })), addedBy };
}

async function setup(build) {
  const root = tmp();
  const l = testLauncher(Launcher, root, { totalMem: 16 * 1024 ** 3 });
  const svc = new Services(root, { launcher: l, memories: Object.assign(new EventEmitter(), { list: async () => [], dir: tmp(), gameStarted() {}, gameStopped() {} }) });
  made.push(svc);
  await svc.saveSettings({ nickname: 'Steve' });
  svc.syncFolder = async () => ({ local: (svc.folderLocal || []).map((f) => ({ file: f, name: f, enabled: true })) });
  const p = await l.store.createProfile({ minecraft: '1.21.1', loader: 'fabric' });
  const lock = await l.store.getLock(p.id);
  lock.mods = build(l);
  await l.store.saveLock(p.id, lock);
  return { svc, l, p };
}
const names = (n) => Array.from({ length: n }, (_, i) => `mod${String(i).padStart(2, '0')}`);

test('поиск виновника: один мод из двенадцати — за несколько запусков, ход поиска виден', async (t) => {
  if (!buildFixtures().ok) return t.skip('нет JDK');
  const { svc, p } = await setup((l) => names(12).map((n) => entry(l, n)));
  process.env.FAKE_PROBE = 'ready';
  process.env.FAKE_CRASH_IF_MOD = 'mod07';
  const evs = [];
  svc.on('event', (e) => e.type === 'bisect' && evs.push(e));
  const r = await svc.findCulprit(p.id, null);
  assert.equal(r.reproduced, true);
  assert.deepStrictEqual(r.culprits.map((c) => c.name), ['mod07']);
  assert.ok(r.runs <= 8, `запусков: ${r.runs}`);
  assert.ok(evs.some((e) => e.state === 'run' && e.testing < 12), 'видно, сколько модов проверяется');
  assert.equal(evs.at(-1).state, 'done');
  const lock = await svc.store.getLock(p.id);
  assert.equal(lock.mods.length, 12, 'поиск не меняет состав сборки');
  assert.equal(fs.readdirSync(path.join(svc.store.gameDir(p.id), 'mods')).filter((f) => f.endsWith('.jar')).length, 12, 'после поиска в папке снова вся сборка');
});

test('поиск виновника: пара, которая падает только вместе; виновата библиотека, а не мод с ней', async (t) => {
  if (!buildFixtures().ok) return t.skip('нет JDK');
  const { svc, p } = await setup((l) => names(8).map((n) => entry(l, n)));
  process.env.FAKE_PROBE = 'ready';
  process.env.FAKE_CRASH_IF_BOTH = 'mod01,mod06';
  const r = await svc.findCulprit(p.id, null);
  assert.deepStrictEqual(r.culprits.map((c) => c.name).sort(), ['mod01', 'mod06']);
  delete process.env.FAKE_CRASH_IF_BOTH;
  // библиотека lib нужна mod00 и mod04; падает сама lib
  const b = await setup((l) => [entry(l, 'lib', { addedBy: 'dependency' }), entry(l, 'mod00', { deps: ['lib'] }), entry(l, 'mod01'), entry(l, 'mod02'), entry(l, 'mod03'), entry(l, 'mod04', { deps: ['lib'] })]);
  process.env.FAKE_CRASH_IF_MOD = 'lib-';
  const rb = await b.svc.findCulprit(b.p.id, null);
  assert.deepStrictEqual(rb.culprits.map((c) => c.name), ['lib']);
});

test('поиск виновника: свой файл игрока в папке; вылет не повторяется — честный ответ; отмена', async (t) => {
  if (!buildFixtures().ok) return t.skip('нет JDK');
  const { svc, p } = await setup((l) => names(4).map((n) => entry(l, n)));
  const modsDir = path.join(svc.store.gameDir(p.id), 'mods');
  fs.mkdirSync(modsDir, { recursive: true });
  fs.writeFileSync(path.join(modsDir, 'own-broken.jar'), 'x');
  svc.folderLocal = ['own-broken.jar'];
  process.env.FAKE_PROBE = 'ready';
  process.env.FAKE_CRASH_IF_MOD = 'own-broken';
  const r = await svc.findCulprit(p.id, null);
  assert.deepStrictEqual(r.culprits.map((c) => [c.kind, c.name]), [['file', 'own-broken.jar']]);
  assert.ok(fs.existsSync(path.join(modsDir, 'own-broken.jar')), 'свой файл на месте');
  delete process.env.FAKE_CRASH_IF_MOD;
  const ok = await svc.findCulprit(p.id, null);
  assert.deepStrictEqual([ok.reproduced, ok.runs], [false, 1], 'игра запускается — искать нечего');
  process.env.FAKE_PROBE = 'hang';
  const running = svc.findCulprit(p.id, null);
  await new Promise((r2) => setTimeout(r2, 1500));
  await assert.rejects(svc.findCulprit(p.id, null), /уже идёт/);
  svc.cancelCulprit();
  await assert.rejects(running, /остановлен/);
  assert.equal(svc.bisect, null);
  assert.equal(fs.readdirSync(modsDir).filter((f) => /^mod\d+-1\.jar$/.test(f)).length, 4, 'после отмены в папке снова вся сборка');
});

test('проверка после обновления: вылет — прежний состав вернулся сам; виноватое обновление находится', async (t) => {
  if (!buildFixtures().ok) return t.skip('нет JDK');
  let L;
  const { svc, p } = await setup((l) => ((L = l), names(6).map((n) => entry(l, n))));
  // «обновление»: у mod02 и mod05 новые версии, mod05 2.0 ломает игру
  const before = await svc.store.getLock(p.id);
  fs.mkdirSync(svc.installer.historyDir(p.id), { recursive: true });
  fs.writeFileSync(path.join(svc.installer.historyDir(p.id), `${Date.now()}.lock.json`), JSON.stringify(before));
  const after = { ...before, mods: before.mods.map((m) => (['mod02', 'mod05'].includes(m.name) ? entry(L, m.name, { version: '2' }) : m)) };
  await svc.store.saveLock(p.id, after);
  process.env.FAKE_PROBE = 'ready';
  process.env.FAKE_CRASH_IF_MOD = 'mod05-2';
  const v = await svc.verifyUpdate(p.id, null);
  assert.deepStrictEqual([v.ok, v.rolledBack], [false, true]);
  assert.deepStrictEqual(v.changed.sort(), ['mod02', 'mod05']);
  const now = await svc.store.getLock(p.id);
  assert.equal(now.mods.find((m) => m.name === 'mod05').version, '1', 'прежний состав вернулся');
  const r = await svc.findCulprit(p.id, null, 'update');
  assert.deepStrictEqual(r.culprits.map((c) => c.name), ['mod05']);
  assert.ok(r.runs <= 3, `запусков: ${r.runs}`);
  // обновление без вылета — ничего не откатывается
  delete process.env.FAKE_CRASH_IF_MOD;
  const good = await svc.verifyUpdate(p.id, null);
  assert.deepStrictEqual([good.ok, good.reason], [true, 'loaded']);
});
