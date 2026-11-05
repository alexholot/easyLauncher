'use strict';
// Сценарий «хозяин и друг» через слой сервисов (как в приложении), на одном ПК:
// модовая сборка → сервер хозяина → приглашение → профиль комнаты у друга → relay → клиент друга.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Services } = require('../core/services');
const { Launcher } = require('../core/launcher');
const { createServer } = require('../server');
const { createMock } = require('./mockapi');
const { buildFixtures, testLauncher, waitEvent } = require('./helpers');
const fabric = require('../core/fabric');

const HOST = { name: 'HostPlayer', uuid: 'a', accessToken: 't', xuid: '', clientId: '' };
const FRIEND = { name: 'Friend1', uuid: 'b', accessToken: 't', xuid: '', clientId: '' };

let mock;
let rooms;
let backend;
test.before(async () => {
  mock = await createMock();
  rooms = createServer({ stun: '' });
  backend = `http://127.0.0.1:${await rooms.listen(0, '127.0.0.1')}`;
});
test.after(async () => {
  mock.close();
  await rooms.close();
});

function services(name) {
  const fx = buildFixtures();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-svc-' + name + '-'));
  const launcher = testLauncher(Launcher, root, { totalMem: 32 * 1024 ** 3 });
  launcher.cache.allowHosts = [new RegExp('^' + mock.base().replace(/\./g, '\\.') + '/cdn/')];
  fabric.installServerLauncher = async (dir) => {
    const dest = path.join(dir, 'fabric-server-launch.jar');
    fs.copyFileSync(fx.serverJar, dest);
    return dest;
  };
  return new Services(root, { launcher, backend, catalogBase: { modrinth: mock.base() + '/mr', curseforgeBackend: mock.base() } });
}

const nbt = require('../core/nbt');
function makeWorld(svc, pid, folder, name) {
  const dir = path.join(svc.worlds.savesDir(pid), folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'level.dat'), nbt.write({ Data: { LevelName: name, LastPlayed: BigInt(Date.now()), GameType: 0, hardcore: false } }));
}

test('хозяин с модами и друг по приглашению: сессия в мире сборки, отдельная сборка комнаты, подключение', async (t) => {
  if (!buildFixtures().ok) return t.skip('нет JDK');
  const host = services('host');
  const friend = services('friend');
  try {
    process.env.FAKE_CLIENT_MS = '300';
    // хозяин: сборка с Fabric; «Установить» Create — Fabric API подтягивается сам, без диалога
    const p = await host.createProfile({ name: 'Завод', minecraft: '1.21.1', loader: 'fabric' });
    const pid = p.id;
    const inst = await host.install(pid, { source: 'modrinth', projectId: 'P_CREATE' });
    assert.equal(inst.applied, true, 'простая установка применяется сразу');
    assert.deepEqual(inst.plan.changes.map((c) => c.name).sort(), ['Create Fabric', 'Fabric API'].sort());
    await host.install(pid, { source: 'modrinth', projectId: 'P_SOD' });
    assert.equal((await host.store.getLock(pid)).mods.length, 3);
    // поиск показывает, что уже стоит в выбранной сборке
    const found = await host.search('modrinth', { query: 'create', minecraft: '1.21.1', loader: 'fabric' }, pid);
    assert.ok(found.hits.find((h) => h.id === 'P_CREATE').installed);

    // «С друзьями»: новый мир в этой сборке
    const r = await host.startCoop({ profileId: pid, create: { name: 'Наш завод', seed: '7' }, eula: true }, HOST);
    assert.match(r.address, /^127\.0\.0\.1:\d+$/);
    assert.ok(r.room, 'комната открыта: сервер easyLauncher настроен');
    const serverMods = fs.readdirSync(path.join(host.store.serverDir(pid), 'mods')).filter((f) => f.endsWith('.jar'));
    assert.ok(!serverMods.some((f) => f.startsWith('P_SOD')), 'клиентский Sodium не ставится на сервер');
    assert.equal(serverMods.length, 2);
    assert.equal((await host.listWorlds(pid)).find((w) => w.name === 'Наш завод').hosted, true);
    const inv = await host.createInvite({ maxUses: 2 });

    // друг: «Проверка приглашения»
    await assert.rejects(friend.openInvite(inv.link, null), (e) => e.code === 'AUTH_REQUIRED');
    const info = await friend.openInvite(inv.link, FRIEND);
    assert.equal(info.minecraft, '1.21.1');
    assert.deepEqual(info.required.map((m) => m.name).sort(), ['Create Fabric', 'Fabric API'].sort());
    assert.deepEqual(info.optional.map((m) => m.name), ['Sodium'], 'клиентский мод хозяина — по желанию');
    // «Подготовка»: личная сборка друга не трогается
    const personal = await friend.ensureFirstProfile('1.21.1');
    const prep = await friend.prepareGuest([]);
    assert.ok(prep.compare.ok);
    assert.equal((await friend.store.getProfile(prep.profileId)).kind, 'room');
    assert.equal((await friend.store.getLock(personal.id)).mods.length, 0, 'личная сборка не изменена');
    const roomCard = (await friend.overview()).profiles.find((x) => x.kind === 'room');
    assert.equal(roomCard?.room?.host, 'HostPlayer', 'сборка друга сохраняется отдельно с именем хозяина');
    assert.match(roomCard?.name || '', /Сборка друга/);
    await assert.rejects(friend.planMods(prep.profileId, { remove: ['modrinth:P_CREATE'] }), /Состав сборки друга/);
    // «Подключение»
    const stages = [];
    friend.on('guest-stage', (s) => stages.push(s));
    const conn = await friend.connectGuest(FRIEND);
    assert.equal(conn.route, 'relay', 'в Node без WebRTC — запасной маршрут');
    await waitEvent(friend.launcher, (ev) => ev.type === 'client' && ev.state === 'stopped');
    assert.ok(friend.launcher.clientLines.includes('connected:hello'), 'клиент друга дошёл до сервера хозяина');
    assert.ok(stages.includes('waiting-host') && stages.includes('route-relay'));
    assert.ok(host.launcher.server.lines.some((l) => l.includes('Added Friend1 to the whitelist')));
    const friendMods = fs.readdirSync(path.join(friend.store.gameDir(prep.profileId), 'mods')).filter((f) => f.endsWith('.jar'));
    assert.equal(friendMods.length, 2, 'у друга установлены именно моды комнаты');

    // хозяин не может менять сборку во время сессии
    const upd = await host.planMods(pid, { remove: ['modrinth:P_SOD'] });
    await assert.rejects(host.applyPlan(upd.planId), (e) => e.code === 'SESSION_ACTIVE');
    await assert.rejects(host.setModEnabled(pid, 'modrinth:P_SOD', false), (e) => e.code === 'SESSION_ACTIVE');

    // завершение сессии закрывает комнату
    await host.endCoop();
    assert.equal(host.host, null);
    assert.equal(host.launcher.server.state, 'stopped');

    // Тестовый режим: хозяин лицензирован, гость входит с локальным ником без Microsoft.
    const off = await host.startCoop({ profileId: pid, folder: r.folder, eula: true, offlineGuests: true }, HOST);
    const offlineInv = await host.createInvite({ maxUses: 1 });
    await friend.saveSettings({ nickname: 'OfflineFriend', offlineOk: true });
    const offlineInfo = await friend.openInvite(offlineInv.link, null);
    assert.equal(offlineInfo.offlineGuests, true);
    assert.equal(offlineInfo.playerName, 'OfflineFriend');
    await friend.prepareGuest([]);
    const offlineConn = await friend.connectGuest(null);
    assert.equal(offlineConn.route, 'relay');
    await waitEvent(friend.launcher, (ev) => ev.type === 'client' && ev.state === 'stopped');
    const props = fs.readFileSync(path.join(host.store.serverDir(pid), 'server.properties'), 'utf8');
    assert.match(props, /online-mode=false/);
    const offlineWhitelist = JSON.parse(fs.readFileSync(path.join(host.store.serverDir(pid), 'whitelist.json'), 'utf8'));
    assert.equal(offlineWhitelist.find((x) => x.name === 'OfflineFriend')?.uuid, '5c46e278-7680-3913-95c4-06cc40aed47e', 'ник гостя записан с офлайн-UUID');
    await host.adminPlayer('whitelist-add', HOST.name);
    const noDuplicates = JSON.parse(fs.readFileSync(path.join(host.store.serverDir(pid), 'whitelist.json'), 'utf8')).filter((x) => x.name.toLowerCase() === HOST.name.toLowerCase());
    assert.equal(noDuplicates.length, 1, 'повторное добавление того же ника не дублирует белый список');
    assert.match(off.address, /^127\.0\.0\.1:\d+$/);
    await host.endCoop();
  } finally {
    delete process.env.FAKE_CLIENT_MS;
    await friend.shutdown();
    await host.shutdown();
  }
});

test('сборка: выключение мода, предупреждение о зависимости, удаление с копией миров, откат', async () => {
  const s = services('mods');
  const p = await s.createProfile({ name: 'Моды', minecraft: '1.21.1', loader: 'fabric' });
  await s.install(p.id, { source: 'modrinth', projectId: 'P_CREATE' });
  makeWorld(s, p.id, 'w1', 'Мир 1');
  const off = await s.setModEnabled(p.id, 'modrinth:P_FAPI', false);
  assert.match(off.warnings[0], /нужен для: Create/);
  const managed = JSON.parse(fs.readFileSync(path.join(s.store.gameDir(p.id), 'mods', '.easylauncher-managed.json'), 'utf8')).files;
  assert.equal(managed.length, 1, 'в mods только включённые');
  await s.setModEnabled(p.id, 'modrinth:P_FAPI', true);
  // удаление — значительное изменение: подтверждение и копия миров
  const rm = await s.planMods(p.id, { remove: ['modrinth:P_CREATE'] });
  assert.equal(rm.significant, true);
  assert.equal(Services.isSimple(rm), false, 'удаление не применяется молча');
  const applied = await s.applyPlan(rm.planId);
  assert.equal(applied.backups.length, 1);
  assert.equal((await s.worldBackups(p.id, 'w1'))[0].reason, 'before-mods');
  // откат к прежнему составу
  const back = await s.rollbackMods(p.id);
  assert.ok(back.mods.some((m) => m.key === 'modrinth:P_CREATE'));
  await s.shutdown();
});

test('обложки и фон: ручная обложка закреплена, скриншот сессии её не меняет; фон — скриншот сборки', async () => {
  const s = services('covers');
  const first = await s.ensureFirstProfile('1.21.1');
  assert.equal(first.loader, 'vanilla', 'первая сборка — Vanilla, без настроек');
  assert.equal(await s.ensureFirstProfile('1.21.1'), null, 'второй раз не создаётся');
  const pid = first.id;
  makeWorld(s, pid, 'valley', 'Тихая долина');
  makeWorld(s, pid, 'twin-a', 'Близнец');
  makeWorld(s, pid, 'twin-b', 'Близнец');
  const shots = path.join(s.store.gameDir(pid), 'screenshots');
  fs.mkdirSync(shots, { recursive: true });
  fs.writeFileSync(path.join(shots, 'a.png'), 'x');
  // фон по умолчанию — стандартный; режим «сборка» — последний скриншот сборки (честная подпись)
  assert.equal((await s.backgroundFor(pid)).kind, 'default');
  await s.setBackground('profile');
  const bg = await s.backgroundFor(pid);
  assert.equal(bg.kind, 'profile-shot');
  assert.equal(bg.label, 'Последний скриншот сборки');
  assert.ok(s.imageAllowed(bg.file));
  assert.equal(s.imageAllowed('/etc/passwd'), false);
  // сессия в однозначном мире → обложка из скриншота этой сессии
  await s.onWorldSession({ profileId: pid, level: 'Тихая долина', shots: ['a.png'] });
  let w = (await s.listWorlds(pid)).find((x) => x.folder === 'valley');
  assert.equal(w.cover.source, 'session');
  // одинаковые названия — связь не подтверждена, обложка не ставится
  await s.onWorldSession({ profileId: pid, level: 'Близнец', shots: ['a.png'] });
  assert.ok((await s.listWorlds(pid)).filter((x) => x.name === 'Близнец').every((x) => !x.cover));
  // ручная обложка закреплена — следующая сессия её не заменяет
  fs.writeFileSync(path.join(shots, 'b.png'), 'y');
  await s.setWorldCover(pid, 'valley', path.join(shots, 'b.png'));
  fs.writeFileSync(path.join(shots, 'c.png'), 'z');
  await s.onWorldSession({ profileId: pid, level: 'Тихая долина', shots: ['c.png'] });
  w = (await s.listWorlds(pid)).find((x) => x.folder === 'valley');
  assert.equal(w.cover.source, 'manual');
  assert.equal(w.cover.pinned, true);
  assert.equal(fs.readFileSync(w.cover.file, 'utf8'), 'y');
  // обложка сборки
  await s.setProfileCover(pid, path.join(shots, 'b.png'));
  assert.equal((await s.backgroundFor(pid)).kind, 'profile-cover');
  // удаление сборки: сначала копии миров
  await assert.rejects(s.deleteProfile(pid, 'не то'), /точное название/);
  const del = await s.deleteProfile(pid, 'Minecraft');
  assert.equal(del.backedUp.length, 3);
  assert.ok(fs.existsSync(s.worlds.backupsDir(pid, 'valley')));
  await s.shutdown();
});

test('помощник без модели: план только из каталога, смена версии с проверкой модов', async () => {
  const s = services('ai');
  const p = await s.createProfile({ name: 'Тест', minecraft: '1.21.1', loader: 'fabric' });
  const pid = p.id;
  // только по теме — сначала уточняющие вопросы; названный мод («с Create») — сразу подбор
  const q = await s.ask('добавь приключений и магии', pid);
  assert.equal(q.kind, 'clarify');
  assert.deepEqual(q.questions.map((x) => x.id), ['amount', 'perf', 'setup']);
  const r = await s.ask('Собери выживание с Create для четырёх друзей', pid);
  assert.equal(r.understoodBy, 'rules');
  assert.equal(r.kind, 'plan');
  assert.ok(r.plan.changes.some((c) => c.name === 'Create Fabric' || c.name === 'Create'));
  const d = await s.ask("java.lang.UnsupportedClassVersionError: class file version 65.0, this version of the Java Runtime only recognizes class file versions up to 61.0", pid);
  assert.equal(d.kind, 'diagnose');
  assert.equal(d.findings[0].id, 'java-version');
  // в Vanilla моды не ставятся — помощник готовит новую сборку с загрузчиком (без сети Mojang и загрузчиков)
  s.launcher.versions = async () => [{ id: '1.21.1', type: 'release' }];
  s.loaderSupport = async () => null;
  const vanilla = await s.createProfile({ name: 'Ванилла', minecraft: '1.21.1' });
  const nb = await s.ask('добавь Create', vanilla.id, {});
  assert.equal(nb.kind, 'build');
  assert.equal(nb.build.loader, 'fabric');
  assert.ok(nb.groups.some((g) => g.names.includes('Create Fabric')));
  // смена версии: мод без релиза для 1.20.1 блокирует план
  await s.applyPlan(r.plan.planId);
  const re = await s.planMods(pid, { retarget: { minecraft: '1.20.1' } });
  assert.equal(re.significant, true);
  assert.ok(re.ok, 'переход не блокируется: моды без версии убираются');
  assert.ok(re.warnings.some((w) => w.code === 'DROPPED' && /1\.20\.1/.test(w.message)));
  assert.ok(re.changes.some((c) => c.type === 'remove'));
  await s.shutdown();
});
