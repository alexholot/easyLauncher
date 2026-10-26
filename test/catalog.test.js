'use strict';
// Каталог, планировщик и установщик модов на локальной имитации API (без настоящих Modrinth/CurseForge).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMock } = require('./mockapi');
const { ModrinthProvider } = require('../core/catalog/modrinth');
const { CurseForgeProvider } = require('../core/catalog/curseforge');
const { planChanges, modState } = require('../core/modplan');
const { ModInstaller } = require('../core/modinstall');
const { ModCache } = require('../core/modcache');
const { Store } = require('../core/store');
const lockLib = require('../core/lock');

let mock;
test.before(async () => {
  mock = await createMock();
});
test.after(() => mock.close());

async function env({ busy = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-cat-'));
  const store = new Store(root);
  const cache = new ModCache(path.join(root, 'shared'), { allowHosts: [new RegExp('^' + mock.base().replace(/\./g, '\\.') + '/cdn/')] });
  const installer = new ModInstaller(store, cache, { isBusy: () => busy });
  const p = await store.createProfile({ minecraft: '1.21.1', loader: 'fabric' });
  const providers = {
    modrinth: new ModrinthProvider({ base: mock.base() + '/mr' }),
    curseforge: new CurseForgeProvider({ backend: mock.base(), apiKey: '' }),
  };
  return { root, store, cache, installer, p, providers };
}

test('поиск: фильтр по версии профиля, обе площадки, карточки в общем формате', async () => {
  const { providers } = await env();
  const r = await providers.modrinth.search({ query: '', minecraft: '1.21.1', loader: 'fabric' });
  assert.ok(r.hits.every((h) => h.gameVersions.includes('1.21.1')));
  assert.ok(!r.hits.some((h) => h.slug === 'oldmod'), 'несовместимые скрыты по умолчанию');
  const all = await providers.modrinth.search({ query: 'old', anyVersion: true });
  assert.equal(all.hits[0].slug, 'oldmod', 'отдельный фильтр показывает несовместимые');
  const cf = await providers.curseforge.search({ query: 'jei', minecraft: '1.21.1', loader: 'fabric' });
  assert.equal(cf.hits[0].key, 'curseforge:1002');
  assert.equal(cf.hits[0].source, 'curseforge');
  assert.ok(mock.opts.requests.some((r) => r.startsWith('GET /cf/v1/mods/search')), 'CurseForge — через прокси сервера, без ключа в клиенте');
});

test('CurseForge без настроенного сервера и при ошибке авторизации API', async () => {
  const none = new CurseForgeProvider({ backend: '', apiKey: '' });
  assert.equal(none.status().available, false);
  await assert.rejects(none.search({ query: 'x' }), (e) => e.code === 'NOT_CONFIGURED');
  const { providers } = await env();
  mock.opts.cfAuthFail = true;
  await assert.rejects(providers.curseforge.search({ query: 'auth-test' }), (e) => e.code === 'AUTH');
  mock.opts.cfAuthFail = false;
});

test('план: рекурсивные зависимости, выдуманный проект не попадает в план, бета не ставится незаметно', async () => {
  const { store, p, providers } = await env();
  const lock = await store.getLock(p.id);
  const plan = await planChanges({ lock, providers, request: { add: [{ source: 'modrinth', projectId: 'P_CREATE' }, { source: 'modrinth', projectId: 'NO_SUCH_MOD' }] } });
  const adds = plan.changes.filter((c) => c.type === 'add').map((c) => c.name);
  assert.deepEqual(adds.sort(), ['Create Fabric', 'Fabric API']);
  assert.equal(plan.changes.find((c) => c.name === 'Fabric API').dependencyOf, 'Create Fabric');
  assert.equal(plan.changes.find((c) => c.name === 'Create Fabric').to, '6.0.0', 'выбран новейший стабильный релиз');
  assert.ok(plan.errors.some((e) => e.key === 'modrinth:NO_SUCH_MOD'));
  assert.ok(!plan.nextLock.mods.some((m) => m.key === 'modrinth:NO_SUCH_MOD'));
  assert.equal(plan.ok, false);

  const beta = await planChanges({ lock, providers, request: { add: [{ source: 'modrinth', projectId: 'P_BETA' }] } });
  assert.equal(beta.errors[0].code, 'PRERELEASE_ONLY');
  const betaOk = await planChanges({ lock, providers, request: { add: [{ source: 'modrinth', projectId: 'P_BETA' }], allowPrerelease: true } });
  assert.ok(betaOk.ok && betaOk.warnings.some((w) => w.code === 'PRERELEASE'));
});

test('план: несовместимая версия Minecraft, объявленный конфликт, дубликаты между площадками', async () => {
  const { store, p, providers, installer } = await env();
  let lock = await store.getLock(p.id);
  const old = await planChanges({ lock, providers, request: { add: [{ source: 'modrinth', projectId: 'P_OLD' }] } });
  assert.equal(old.errors[0].code, 'INCOMPATIBLE');
  const pinnedOld = await planChanges({ lock, providers, request: { add: [{ source: 'modrinth', projectId: 'P_OLD', versionId: 'V_OLD' }] } });
  assert.match(pinnedOld.errors[0].message, /нет версии для Minecraft 1\.21\.1/);

  const conflict = await planChanges({ lock, providers, request: { add: [{ source: 'modrinth', projectId: 'P_CREATE' }, { source: 'modrinth', projectId: 'P_BAD' }] } });
  assert.ok(conflict.errors.some((e) => e.code === 'CONFLICT'));

  const base = await planChanges({ lock, providers, request: { add: [{ source: 'modrinth', projectId: 'P_FAPI' }, { source: 'modrinth', projectId: 'P_SOD' }] } });
  lock = await installer.apply(p.id, base);
  const dupFile = await planChanges({ lock, providers, request: { add: [{ source: 'curseforge', projectId: '3002' }] } });
  assert.ok(dupFile.warnings.some((w) => w.code === 'DUPLICATE'), 'тот же SHA-1 — один и тот же мод');
  assert.equal(dupFile.changes.length, 0);
  const sameName = await planChanges({ lock, providers, request: { add: [{ source: 'curseforge', projectId: '3001' }] } });
  assert.equal(sameName.questions.length, 1, 'одинаковое название — вопрос пользователю, а не автоматическое решение');
  const skip = await planChanges({ lock, providers, request: { add: [{ source: 'curseforge', projectId: '3001' }], choices: { 'curseforge:3001': 'skip' } } });
  assert.ok(skip.ok && skip.changes.length === 0);
});

test('установка: байтовый прогресс, докачка после обрыва, стороны, lock с источником и хешами', async () => {
  const { store, p, providers, installer } = await env();
  const lock = await store.getLock(p.id);
  mock.opts.dropOnce.add('P_CREATE-6.0.0.jar');
  const plan = await planChanges({ lock, providers, request: { add: [{ source: 'modrinth', projectId: 'P_CREATE' }, { source: 'modrinth', projectId: 'P_SOD' }, { source: 'curseforge', projectId: '1001' }] } });
  assert.ok(plan.ok, JSON.stringify(plan.errors));
  const progress = [];
  const next = await installer.apply(p.id, plan, { onProgress: (x) => progress.push(x) });
  const total = plan.nextLock.mods.reduce((a, m) => a + m.file.size, 0);
  const dl = progress.filter((x) => x.phase === 'download');
  assert.equal(dl.at(-1).done, total, 'прогресс заканчивается ровно на объёме файлов');
  assert.ok(dl.every((x, i) => i === 0 || x.done >= dl[i - 1].done), 'прогресс не идёт назад');
  assert.ok(mock.opts.requests.filter((r) => r === 'GET /cdn/P_CREATE-6.0.0.jar').length >= 2, 'после обрыва файл докачан повторным запросом');
  const keys = next.mods.map((m) => m.key).sort();
  assert.deepEqual(keys, ['curseforge:1001', 'curseforge:1002', 'modrinth:P_CREATE', 'modrinth:P_FAPI', 'modrinth:P_SOD']);
  const jei = next.mods.find((m) => m.key === 'curseforge:1001');
  assert.deepEqual(jei.side, { client: 'required', server: 'required' }, 'сторона CurseForge-мода уточнена по fabric.mod.json');
  assert.ok(/^[0-9a-f]{40}$/.test(jei.file.hashes.sha1));
  const modsDir = path.join(store.gameDir(p.id), 'mods');
  assert.equal(fs.readdirSync(modsDir).filter((f) => f.endsWith('.jar')).length, 5);
  // Манифест комнаты: серверный набор отдельно, клиентский мод Sodium гостю необязателен
  const manifest = lockLib.roomManifest(next, { name: 'Мир' });
  assert.equal(manifest.mods.find((m) => m.key === 'modrinth:P_SOD').requiredForGuest, false, 'клиентский мод хозяина гостю необязателен');
  assert.equal(manifest.mods.find((m) => m.key === 'modrinth:P_CREATE').requiredForGuest, true, 'общий мод обязателен');
  assert.ok(!lockLib.onServer(next.mods.find((m) => m.key === 'modrinth:P_SOD')), 'клиентский мод не ставится на сервер');
});

test('установка: повреждённая загрузка, файл другого загрузчика, запрет скачивания и импорт, отмена, откат', async () => {
  const { store, p, providers, installer, root } = await env();
  let lock = await store.getLock(p.id);
  // повреждённый файл — хеш не сходится, сборка не меняется
  mock.opts.corrupt.add('P_FAPI-0.116.0.jar');
  const plan1 = await planChanges({ lock, providers, request: { add: [{ source: 'modrinth', projectId: 'P_FAPI' }] } });
  await assert.rejects(installer.apply(p.id, plan1), /хеш не совпадает|повреждён/);
  mock.opts.corrupt.delete('P_FAPI-0.116.0.jar');
  assert.equal((await store.getLock(p.id)).mods.length, 0);
  // JAR оказался модом для Forge
  const plan2 = await planChanges({ lock, providers, request: { add: [{ source: 'modrinth', projectId: 'P_FORGE' }] } });
  await assert.rejects(installer.apply(p.id, plan2), (e) => e.code === 'WRONG_LOADER');
  // автор запретил распространение: ссылки нет, нужен импорт; чужой файл не принимается
  const plan3 = await planChanges({ lock, providers, request: { add: [{ source: 'curseforge', projectId: '2001' }] } });
  assert.equal(plan3.manual.length, 1);
  await assert.rejects(installer.apply(p.id, plan3), (e) => e.code === 'DOWNLOAD_BLOCKED' && e.missing[0].pageUrl.includes('curseforge.com'));
  const wrong = path.join(root, 'wrong.jar');
  fs.writeFileSync(wrong, 'not the file');
  await assert.rejects(installer.apply(p.id, plan3, { imports: { 'curseforge:2001': wrong } }), /SHA-1 не совпадает/);
  const right = path.join(root, 'blocked.jar');
  fs.writeFileSync(right, mock.blockedBuf());
  lock = await installer.apply(p.id, plan3, { imports: { 'curseforge:2001': right } });
  assert.equal(lock.mods[0].key, 'curseforge:2001');
  // отмена до применения
  const ac = new AbortController();
  ac.abort();
  const plan4 = await planChanges({ lock, providers, request: { add: [{ source: 'modrinth', projectId: 'P_SOD' }] } });
  await assert.rejects(installer.apply(p.id, plan4, { signal: ac.signal }), (e) => e.code === 'CANCELLED');
  assert.equal((await store.getLock(p.id)).mods.length, 1);
  // применение и откат
  await installer.apply(p.id, plan4);
  assert.equal((await store.getLock(p.id)).mods.length, 2);
  await installer.rollback(p.id);
  assert.deepEqual((await store.getLock(p.id)).mods.map((m) => m.key), ['curseforge:2001']);
});

test('обновления: план, закреплённая версия, запрет во время сессии, восстановление прерванной транзакции', async () => {
  const { store, p, providers, installer, cache } = await env();
  let lock = await store.getLock(p.id);
  const plan = await planChanges({ lock, providers, request: { add: [{ source: 'modrinth', projectId: 'P_CREATE', versionId: 'V_CREATE_OLD' }] } });
  lock = await installer.apply(p.id, plan);
  const st = await modState({ lock, provider: providers.modrinth, projectId: 'P_CREATE' });
  assert.equal(st.state, 'update');
  const upd = await planChanges({ lock, providers, request: { update: 'all' } });
  // новая версия Create требует Fabric API — зависимость попадает в тот же план
  assert.deepEqual(upd.changes.map((c) => [c.type, c.name, c.from, c.to]), [['update', 'Create Fabric', '5.0.0', '6.0.0'], ['add', 'Fabric API', undefined, '0.116.0']]);
  lock = await installer.setPinned(p.id, 'modrinth:P_CREATE', true);
  const pinned = await planChanges({ lock, providers, request: { update: 'all' } });
  assert.equal(pinned.changes.length, 0);
  assert.equal((await modState({ lock, provider: providers.modrinth, projectId: 'P_CREATE' })).state, 'installed');
  assert.equal((await modState({ lock, provider: providers.modrinth, projectId: 'P_OLD' })).state, 'incompatible');

  const busy = new ModInstaller(store, cache, { isBusy: () => true });
  await assert.rejects(busy.apply(p.id, upd), (e) => e.code === 'SESSION_ACTIVE');

  // «выключение ПК» посреди транзакции: журнал остался, при старте состав возвращается
  const prev = await store.getLock(p.id);
  fs.writeFileSync(installer.journal(p.id), JSON.stringify({ prev }));
  await store.saveLock(p.id, { ...prev, mods: [] });
  assert.equal(await installer.recover(p.id), true);
  assert.equal((await store.getLock(p.id)).mods.length, prev.mods.length);
});

test('совместимость сборок хозяина и гостя', () => {
  const entry = (key, ver, client, server, sha) => ({ key, source: 'modrinth', projectId: key.split(':')[1], name: key, versionId: ver, version: ver, side: { client, server }, file: { filename: key.split(':')[1] + '.jar', hashes: { sha1: sha.repeat(40).slice(0, 40) } }, dependencies: [] });
  const host = { format: 'easylauncher.lock/2', minecraft: '1.21.1', loader: 'fabric', loaderVersion: '0.16.9', mods: [entry('modrinth:create', '6', 'required', 'required', 'a'), entry('modrinth:sodium', '1', 'required', 'unsupported', 'b'), entry('modrinth:lithium', '1', 'optional', 'required', 'c')] };
  const manifest = lockLib.roomManifest(host, { name: 'Мир' });
  assert.ok(!manifest.mods.some((m) => m.key === 'modrinth:lithium' && m.requiredForGuest));
  const guest = lockLib.lockFromManifest(manifest, []);
  assert.deepEqual(guest.mods.map((m) => m.key), ['modrinth:create'], 'без выбора — только обязательные');
  assert.deepEqual(lockLib.lockFromManifest(manifest, ['modrinth:sodium']).mods.map((m) => m.key).sort(), ['modrinth:create', 'modrinth:sodium']);
  assert.ok(lockLib.compare(manifest, guest).ok);
  const vanillaFriend = { format: 'easylauncher.lock/2', minecraft: '1.21.1', loader: 'vanilla', mods: [] };
  const r = lockLib.compare(manifest, vanillaFriend);
  assert.equal(r.ok, false, 'друг без модов не войдёт на сервер с обязательными модами');
  const wrongVer = { ...guest, mods: guest.mods.map((m) => (m.key === 'modrinth:create' ? { ...m, version: '5', file: { ...m.file, hashes: { sha1: 'f'.repeat(40) } } } : m)) };
  assert.match(lockLib.compare(manifest, wrongVer).errors[0], /нужна версия 6/);
});

test('обновление сборки с разрешённой бета-версией: без ошибки, бета обновляется до новой беты', async () => {
  const { createMock, fabricJar } = require('./mockapi');
  const { ModrinthProvider } = require('../core/catalog/modrinth');
  const { planChanges } = require('../core/modplan');
  const { emptyLock } = require('../core/store');
  const mock = await createMock();
  try {
    const providers = { modrinth: new ModrinthProvider({ base: mock.base() + '/mr' }) };
    const lock = emptyLock('1.21.1', 'fabric');
    const denied = await planChanges({ lock, request: { add: [{ source: 'modrinth', projectId: 'P_BETA' }] }, providers });
    assert.equal(denied.errors[0].code, 'PRERELEASE_ONLY');
    const allowed = await planChanges({ lock, request: { add: [{ source: 'modrinth', projectId: 'P_BETA' }], allowPrerelease: true }, providers });
    assert.ok(allowed.ok);
    // «Проверить обновления»: бета не даёт ошибку
    let upd = await planChanges({ lock: allowed.nextLock, request: { update: 'all' }, providers: { modrinth: new ModrinthProvider({ base: mock.base() + '/mr' }) } });
    assert.ok(upd.ok, JSON.stringify(upd.errors));
    assert.equal(upd.changes.length, 0);
    // вышла новая бета — предлагается обновление в том же канале
    mock.addMrVersion('V_BETA2', 'P_BETA', '0.2-beta', { type: 'beta', buf: fabricJar('betamod2'), published: '2026-10-01T00:00:00Z' });
    upd = await planChanges({ lock: allowed.nextLock, request: { update: 'all' }, providers: { modrinth: new ModrinthProvider({ base: mock.base() + '/mr' }) } });
    assert.ok(upd.ok);
    assert.deepEqual(upd.changes.map((c) => `${c.type} ${c.from} → ${c.to}`), ['update 0.1-beta → 0.2-beta']);
  } finally {
    mock.close();
  }
});
