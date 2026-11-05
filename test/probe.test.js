'use strict';
// Пробный запуск игры: загрузилась / вылетела / экран ошибок / зависла / отмена; набор модов и свои файлы игрока
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Launcher, restoreProbeLeftovers, PROBE_OFF } = require('../core/launcher');
const { buildFixtures, testLauncher } = require('./helpers');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'easy-p-'));
const base = { ram: 1, nickname: 'Steve', options: {} };
const launched = [];
test.beforeEach(() => (process.env.EASY_PROBE_GRACE_MS = '300'));
test.afterEach(async () => {
  for (const l of launched.splice(0)) {
    l.stopProbe();
    await l.shutdown();
  }
  for (const k of ['FAKE_PROBE', 'FAKE_CRASH_IF_MOD', 'FAKE_CRASH_IF_BOTH', 'EASY_PROBE_GRACE_MS']) delete process.env[k];
});

/** Сборка Fabric с модами, файлы которых уже в кэше лаунчера. */
async function setup(names = ['alpha', 'beta']) {
  const root = tmp();
  const l = testLauncher(Launcher, root, { totalMem: 16 * 1024 ** 3 });
  launched.push(l);
  const p = await l.store.createProfile({ minecraft: '1.21.1', loader: 'fabric' });
  const lock = await l.store.getLock(p.id);
  lock.mods = names.map((n) => {
    const bytes = Buffer.from('jar:' + n);
    const sha1 = crypto.createHash('sha1').update(bytes).digest('hex');
    const file = { filename: `${n}.jar`, url: null, size: bytes.length, hashes: { sha1 } };
    const dest = l.cache.pathFor(file);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, bytes);
    return { key: `modrinth:${n}`, source: 'modrinth', projectId: n, name: n, versionId: 'v' + n, version: '1', side: { client: 'required', server: 'required' }, file, dependencies: [] };
  });
  await l.store.saveLock(p.id, lock);
  return { l, p, lock };
}

test('пробный запуск: загрузилась — игра закрыта, это не «игра» (нет событий client), сборка свободна', async (t) => {
  if (!buildFixtures().ok) return t.skip('нет JDK');
  const { l, p } = await setup();
  process.env.FAKE_PROBE = 'ready';
  const evs = [];
  l.on('event', (e) => e.type !== 'log' && e.type !== 'stage' && evs.push(`${e.type}:${e.state}`));
  const r = await l.probe({ ...base, profileId: p.id });
  assert.deepStrictEqual([r.ok, r.reason], [true, 'loaded']);
  assert.ok(!evs.some((e) => e.startsWith('client:')), 'пробный запуск не считается игрой: ' + evs.join(','));
  assert.deepStrictEqual(evs, ['probe:running', 'probe:ready', 'probe:stopped']);
  assert.equal(l.client, null);
  assert.equal(l.profileBusy(p.id), false);
});

test('пробный запуск: вылет, экран ошибок Forge, зависание, отмена', async (t) => {
  if (!buildFixtures().ok) return t.skip('нет JDK');
  const { l, p } = await setup();
  process.env.FAKE_PROBE = 'crash';
  const c = await l.probe({ ...base, profileId: p.id });
  assert.deepStrictEqual([c.ok, c.reason], [false, 'crashed']);
  assert.match(c.crash, /NullPointerException: test crash/);
  process.env.FAKE_PROBE = 'forge-errors';
  const e = await l.probe({ ...base, profileId: p.id });
  assert.deepStrictEqual([e.ok, e.reason], [false, 'errors']);
  assert.match(e.evidence, /Skipping lifecycle event/);
  process.env.FAKE_PROBE = 'hang';
  const h = await l.probe({ ...base, profileId: p.id }, { timeoutMs: 1500 });
  assert.deepStrictEqual([h.ok, h.reason], [null, 'timeout']);
  const running = l.probe({ ...base, profileId: p.id }, { timeoutMs: 30000 });
  await new Promise((r) => setTimeout(r, 1200));
  assert.equal(l.profileBusy(p.id), true, 'во время проверки состав сборки не меняется');
  await assert.rejects(l.play({ ...base, profileId: p.id }), (er) => er.code === 'CLIENT_RUNNING');
  l.stopProbe();
  const x = await running;
  assert.deepStrictEqual([x.ok, x.reason], [null, 'cancelled']);
  assert.equal(l.client, null);
});

test('пробный запуск с набором модов: в папке только он, свои файлы игрока убраны на время и возвращены', async (t) => {
  if (!buildFixtures().ok) return t.skip('нет JDK');
  const { l, p, lock } = await setup(['alpha', 'beta', 'gamma']);
  const modsDir = path.join(l.store.gameDir(p.id), 'mods');
  fs.mkdirSync(modsDir, { recursive: true });
  fs.writeFileSync(path.join(modsDir, 'own-mod.jar'), 'own');
  process.env.FAKE_PROBE = 'ready';
  process.env.FAKE_CRASH_IF_MOD = 'own-mod';
  const off = await l.probe({ ...base, profileId: p.id }, { mods: [lock.mods[1]], folderOff: ['own-mod.jar'] });
  assert.equal(off.ok, true, 'свой мод убран — вылета нет');
  assert.ok(fs.existsSync(path.join(modsDir, 'own-mod.jar')), 'свой мод вернулся на место');
  assert.ok(!fs.readdirSync(modsDir).some((f) => f.endsWith(PROBE_OFF)));
  const on = await l.probe({ ...base, profileId: p.id }, { mods: [lock.mods[1]] });
  assert.equal(on.ok, false, 'со своим модом — вылет');
  // какие моды были в папке во время запуска (поддельная игра печатает их)
  process.env.FAKE_CRASH_IF_MOD = 'alpha';
  const only = await l.probe({ ...base, profileId: p.id }, { mods: [lock.mods[1], lock.mods[2]], folderOff: ['own-mod.jar'] });
  assert.equal(only.ok, true, 'alpha не в наборе — вылета нет');
});

test('свои моды, оставшиеся убранными после сбоя, возвращаются', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'a.jar' + PROBE_OFF), 'a');
  fs.writeFileSync(path.join(dir, 'b.jar' + PROBE_OFF), 'b');
  fs.writeFileSync(path.join(dir, 'b.jar'), 'b-new'); // уже есть файл с таким именем — не затираем
  assert.equal(await restoreProbeLeftovers(dir), 1);
  assert.ok(fs.existsSync(path.join(dir, 'a.jar')));
  assert.equal(await restoreProbeLeftovers(path.join(dir, 'нет')), 0);
});
