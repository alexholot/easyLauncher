'use strict';
// Сквозные тесты оркестратора на поддельных сервере/клиенте (настоящие процессы Java и TCP).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');
const { Launcher } = require('../core/launcher');
const { offlineUuid } = require('../core/mojang');
const { parseProperties } = require('../core/server');
const nbt = require('../core/nbt');
const { buildFixtures, testLauncher, waitEvent } = require('./helpers');

const AUTH = { name: 'HostPlayer', uuid: 'abc', accessToken: 'tok', xuid: '', clientId: '' };
const launched = [];
test.afterEach(async () => {
  for (const l of launched.splice(0)) {
    l.stopClient();
    await l.shutdown();
  }
  delete process.env.FAKE_CLIENT_MS;
  delete process.env.FAKE_SP_LEVEL;
  delete process.env.FAKE_FAIL;
});
async function until(fn, ms = 5000) {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error('условие не выполнилось');
    await new Promise((r) => setTimeout(r, 50));
  }
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'easy-l-'));
const base = { ram: 2, options: { render: 8, simulation: 4, fps: 120, graphics: 0 } };

/** Мир, как его создаёт Minecraft: saves/<папка>/level.dat (NBT). */
function makeWorld(l, pid, folder, name) {
  const dir = path.join(l.worlds.savesDir(pid), folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'level.dat'), nbt.write({ Data: { LevelName: name, LastPlayed: BigInt(Date.now()), GameType: 0, hardcore: false } }));
  return folder;
}

async function setup(opts) {
  const root = tmp();
  const l = testLauncher(Launcher, root, { totalMem: 16 * 1024 ** 3, ...opts });
  launched.push(l);
  const p = await l.store.createProfile({ minecraft: '1.21.1', loader: 'vanilla' });
  return { root, l, p };
}

test('«Играть»: главное меню Minecraft — без EULA, без сервера, без генерации мира и подтверждений', async (t) => {
  if (!buildFixtures().ok) return t.skip('нет JDK');
  const { l, p } = await setup();
  const stages = [];
  l.on('event', (ev) => ev.type === 'stage' && stages.push(ev.stage));
  const exited = waitEvent(l, (ev) => ev.type === 'client' && ev.state === 'stopped');
  const r = await l.play({ ...base, profileId: p.id, nickname: 'Steve' });
  assert.equal(r.ok, true);
  assert.deepEqual([...new Set(stages)], ['check', 'files', 'game']);
  assert.equal(l.server.state, 'stopped', 'сервер не запускается');
  await exited;
  assert.ok(!l.clientLines.includes('arg:--quickPlaySingleplayer'), 'без мира — главное меню');
  assert.ok(!l.clientLines.includes('arg:--quickPlayMultiplayer'));
  assert.ok(!fs.existsSync(path.join(l.store.serverDir(p.id), 'eula.txt')), 'EULA сервера не трогается');
  assert.ok(fs.existsSync(path.join(l.store.gameDir(p.id), 'options.txt')));
  // Повторный запуск — сразу, без вопросов
  stages.length = 0;
  await l.play({ ...base, profileId: p.id, nickname: 'Steve' });
  await waitEvent(l, (ev) => ev.type === 'client' && ev.state === 'stopped');
  assert.deepEqual([...new Set(stages)], ['check', 'files', 'game']);
  await assert.rejects(l.play({ ...base, profileId: p.id, nickname: 'x' }), (e) => e.code === 'NAME');
});

test('вход сразу в мир — отдельное действие; журнал: мир и скриншот сессии', async (t) => {
  if (!buildFixtures().ok) return t.skip('нет JDK');
  const { l, p } = await setup();
  makeWorld(l, p.id, 'valley', 'Тихая долина');
  process.env.FAKE_SP_LEVEL = 'Тихая долина';
  const session = waitEvent(l, (ev) => ev.type === 'world-session');
  const shot = waitEvent(l, (ev) => ev.type === 'screenshot');
  const r = await l.play({ ...base, profileId: p.id, nickname: 'Steve', world: 'valley' });
  assert.equal(r.worldJoin, true);
  const s = await session;
  assert.equal(s.level, 'Тихая долина');
  assert.equal(s.shots.length, 1);
  assert.equal((await shot).session, 'singleplayer');
  await waitEvent(l, (ev) => ev.type === 'client' && ev.state === 'stopped');
  assert.ok(l.clientLines.includes('arg:--quickPlaySingleplayer'));
  assert.ok(l.clientLines.includes('arg:valley'));
  await assert.rejects(l.play({ ...base, profileId: p.id, nickname: 'Steve', world: 'нет такого' }), /не найден/);
});

test('с друзьями: сервер открывает мир сборки, online-mode и белый список, копия на ходу, завершение', async (t) => {
  if (!buildFixtures().ok) return t.skip('нет JDK');
  const { l, p } = await setup();
  makeWorld(l, p.id, 'valley', 'Тихая долина');
  await assert.rejects(l.startSession({ profileId: p.id, folder: 'valley', eula: true }), (e) => e.code === 'AUTH_REQUIRED');
  await assert.rejects(l.startSession({ profileId: p.id, folder: 'valley', auth: AUTH }), (e) => e.code === 'EULA');
  const stages = [];
  l.on('event', (ev) => ev.type === 'stage' && stages.push(ev.stage));
  const res = await l.startSession({ profileId: p.id, folder: 'valley', auth: AUTH, eula: true, serverRam: 1 });
  assert.deepEqual([...new Set(stages)], ['check', 'files', 'server', 'ready']);
  assert.equal(res.folder, 'valley');
  assert.equal(l.server.worldKey, `${p.id}/valley`);
  const props = parseProperties(fs.readFileSync(path.join(l.store.serverDir(p.id), 'server.properties'), 'utf8'));
  assert.equal(props.get('online-mode'), 'true');
  assert.equal(props.get('white-list'), 'true');
  assert.equal(props.get('enforce-whitelist'), 'true');
  await until(() => l.server.lines.some((x) => x.includes('Added HostPlayer to the whitelist')));
  // Мир занят сервером: одиночный вход в него и вторая сессия запрещены
  assert.ok(await l.worlds.holder(p.id, 'valley'));
  await assert.rejects(l.play({ ...base, profileId: p.id, nickname: 'Steve', world: 'valley' }), (e) => e.code === 'WORLD_LOCKED');
  await assert.rejects(l.startSession({ profileId: p.id, folder: 'valley', auth: AUTH, eula: true }), (e) => e.code === 'SESSION_ACTIVE');
  assert.equal(l.profileBusy(p.id), true, 'состав сборки нельзя менять во время сессии');
  // Хозяин подключается к своему серверу как обычный клиент
  const exited = waitEvent(l, (ev) => ev.type === 'client' && ev.state === 'stopped');
  await l.play({ ...base, profileId: p.id, auth: AUTH, server: res.address });
  const ev = await exited;
  assert.ok(l.clientLines.includes('connected:hello'));
  assert.equal(ev.sessionActive, true, 'игра закрыта, сессия продолжается — интерфейс спросит');
  // Копия работающего мира: save-off → save-all flush → копия → save-on
  const b = await l.worlds.backup(p.id, 'valley', { server: l.server });
  const zip = new AdmZip(path.join(l.worlds.backupsDir(p.id, 'valley'), b.file));
  assert.ok(zip.getEntry('world/level.dat'));
  assert.ok(zip.getEntry('world/saved.txt'), 'копия сделана после принудительного сохранения');
  assert.ok(!zip.getEntry('world/session.lock'));
  await until(() => l.server.lines.some((x) => x.includes('Automatic saving is now enabled')));
  await l.endSession();
  assert.equal(l.server.state, 'stopped');
  assert.ok(l.server.lines.some((x) => x.includes('Saving worlds')));
  await until(async () => (await l.worlds.holder(p.id, 'valley')) === null);

  // Хозяин всё равно входит по лицензии, но для приглашённых можно явно включить тестовый офлайн-вход.
  await l.startSession({ profileId: p.id, folder: 'valley', auth: AUTH, eula: true, serverRam: 1, offlineGuests: true });
  const offlineProps = parseProperties(fs.readFileSync(path.join(l.store.serverDir(p.id), 'server.properties'), 'utf8'));
  assert.equal(offlineProps.get('online-mode'), 'false');
  assert.equal(offlineProps.get('white-list'), 'true', 'тестовый режим не отключает белый список');
  const offlineList = JSON.parse(fs.readFileSync(path.join(l.store.serverDir(p.id), 'whitelist.json'), 'utf8'));
  const hostHex = offlineUuid(AUTH.name);
  const hostOfflineId = [hostHex.slice(0, 8), hostHex.slice(8, 12), hostHex.slice(12, 16), hostHex.slice(16, 20), hostHex.slice(20)].join('-');
  assert.equal(offlineList.find((x) => x.name === AUTH.name)?.uuid, hostOfflineId, 'для офлайн-сервера записан офлайн-UUID, а не UUID лицензии');
  await l.endSession();
});

test('с друзьями: новый мир создаётся сервером в saves сборки и виден в списке миров', async (t) => {
  if (!buildFixtures().ok) return t.skip('нет JDK');
  const { l, p } = await setup();
  const res = await l.startSession({ profileId: p.id, create: { name: 'Наш завод', seed: '7', gamemode: 'creative' }, auth: AUTH, eula: true, serverRam: 1 });
  assert.equal(res.folder, 'Наш завод');
  const props = fs.readFileSync(path.join(l.worlds.savesDir(p.id), 'Наш завод', 'fake-props.txt'), 'utf8');
  assert.match(props, /seed=7;gamemode=creative;online=true;whitelist=true/);
  const list = await l.worlds.list(p.id);
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'Наш завод');
  assert.equal(list[0].gamemode, 'creative');
  assert.equal(list[0].damaged, false);
  await l.endSession();
});

test('отказы: нехватка памяти, занятый порт, сервер упал во время игры', async (t) => {
  if (!buildFixtures().ok) return t.skip('нет JDK');
  const small = await setup({ totalMem: 4 * 1024 ** 3 });
  await assert.rejects(small.l.play({ ...base, ram: 4, profileId: small.p.id, nickname: 'Steve' }), (e) => e.code === 'NO_MEMORY' && /Не хватает памяти/.test(e.message));
  const { l, p } = await setup();
  makeWorld(l, p.id, 'w', 'Мир');
  process.env.FAKE_FAIL = 'port';
  await assert.rejects(l.startSession({ profileId: p.id, folder: 'w', auth: AUTH, eula: true, serverRam: 1 }), (e) => e.code === 'PORT_BUSY');
  delete process.env.FAKE_FAIL;
  assert.equal(await l.worlds.holder(p.id, 'w'), null, 'блокировка мира снята после сбоя');
  await l.startSession({ profileId: p.id, folder: 'w', auth: AUTH, eula: true, serverRam: 1 });
  const down = waitEvent(l, (ev) => ev.type === 'server' && ev.state === 'stopped');
  l.server.command('crash');
  const ev = await down;
  assert.equal(ev.expected, false);
  assert.equal(ev.failure.kind, 'CRASH');
});

test('выключенный мод не попадает в папку mods, но остаётся в сборке', async (t) => {
  if (!buildFixtures().ok) return t.skip('нет JDK');
  const { l } = await setup();
  const fabricProfile = await l.store.createProfile({ minecraft: '1.21.1', loader: 'fabric' });
  const jar = (name) => {
    const z = new AdmZip();
    z.addFile('fabric.mod.json', Buffer.from(JSON.stringify({ id: name, environment: '*' })));
    return z.toBuffer();
  };
  const crypto = require('crypto');
  const entry = (id, on) => {
    const buf = jar(id);
    const file = path.join(os.tmpdir(), `${id}-${process.pid}.jar`);
    fs.writeFileSync(file, buf);
    return { buf, file, e: { key: 'modrinth:' + id, source: 'modrinth', projectId: id, name: id, versionId: 'v1', version: '1', minecraft: ['1.21.1'], loaders: ['fabric'], side: { client: 'required', server: 'required' }, file: { filename: id + '.jar', url: null, size: buf.length, hashes: { sha1: crypto.createHash('sha1').update(buf).digest('hex') } }, dependencies: [], pinned: false, addedBy: 'user', ...(on ? {} : { enabled: false }) } };
  };
  const a = entry('alpha', true);
  const b = entry('beta', false);
  for (const x of [a, b]) await l.cache.importFile(x.file, x.e);
  const lock = await l.store.getLock(fabricProfile.id);
  lock.mods = [a.e, b.e];
  await l.store.saveLock(fabricProfile.id, lock);
  await l.play({ ...base, profileId: fabricProfile.id, nickname: 'Steve' });
  await waitEvent(l, (ev) => ev.type === 'client' && ev.state === 'stopped');
  const mods = fs.readdirSync(path.join(l.store.gameDir(fabricProfile.id), 'mods'));
  assert.ok(mods.includes('alpha.jar'));
  assert.ok(!mods.includes('beta.jar'), 'выключенный мод не загружается игрой');
  assert.equal((await l.store.getLock(fabricProfile.id)).mods.length, 2);
});

test('принудительное закрытие игры по просьбе игрока — не вылет; пока идёт подготовка, сборка занята', async (t) => {
  if (!buildFixtures().ok) return t.skip('нет JDK');
  const { l, p } = await setup();
  process.env.FAKE_CLIENT_MS = '20000';
  const stopped = waitEvent(l, (ev) => ev.type === 'client' && ev.state === 'stopped');
  const started = l.play({ ...base, profileId: p.id, nickname: 'Steve' });
  assert.equal(l.profileBusy(p.id), true, 'во время подготовки состав сборки менять нельзя');
  await started;
  l.stopClient();
  const ev = await stopped;
  assert.equal(ev.killed, true);
  assert.equal(ev.crash, '', 'окно «игра вылетела» не показывается');
});
