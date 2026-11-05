'use strict';
// Моды, которые игрок положил в папку mods сам: узнанные Modrinth — в сборку, остальные — списком «из папки»
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const AdmZip = require('adm-zip');
const { EventEmitter } = require('events');
const http = require('../core/http');
const { Services } = require('../core/services');
const { inspectJar } = require('../core/modcache');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'easy-'));
const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');

function jar(files) {
  const z = new AdmZip();
  for (const [n, t] of Object.entries(files)) z.addFile(n, Buffer.from(t));
  return z.toBuffer();
}
const forgeJar = (id, name, version = '1.0.0') => jar({ 'META-INF/mods.toml': `modLoader="javafml"\nloaderVersion="[47,)"\n[[mods]]\nmodId="${id}"\nversion="${version}"\ndisplayName="${name}"\n`, [`${id}/A.class`]: id });

test('описание мода из JAR: Forge (и версия из манифеста), Fabric', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'f.jar'), forgeJar('coolmod', 'Cool Mod', '2.1'));
  assert.deepStrictEqual((({ loaders, modId, name, version }) => ({ loaders, modId, name, version }))(inspectJar(path.join(d, 'f.jar'))), { loaders: ['forge'], modId: 'coolmod', name: 'Cool Mod', version: '2.1' });
  fs.writeFileSync(path.join(d, 'm.jar'), jar({ 'META-INF/mods.toml': '[[mods]]\nmodId="x"\nversion="${file.jarVersion}"\ndisplayName="X"', 'META-INF/MANIFEST.MF': 'Manifest-Version: 1.0\nImplementation-Version: 3.4.5\n' }));
  assert.equal(inspectJar(path.join(d, 'm.jar')).version, '3.4.5');
  fs.writeFileSync(path.join(d, 'fa.jar'), jar({ 'fabric.mod.json': JSON.stringify({ id: 'fab', name: 'Fab Mod', version: '0.9' }) }));
  const fa = inspectJar(path.join(d, 'fa.jar'));
  assert.deepStrictEqual([fa.loaders, fa.name, fa.version], [['fabric'], 'Fab Mod', '0.9']);
  // Forge до 1.13 — mcmod.info (массив и {modList})
  fs.writeFileSync(path.join(d, 'old.jar'), jar({ 'mcmod.info': JSON.stringify([{ modid: 'jei', name: 'Just Enough Items', version: '4.16.1' }]) }));
  const old = inspectJar(path.join(d, 'old.jar'));
  assert.deepStrictEqual([old.loaders, old.name, old.version, old.modId], [['forge'], 'Just Enough Items', '4.16.1', 'jei']);
  fs.writeFileSync(path.join(d, 'old2.jar'), jar({ 'mcmod.info': JSON.stringify({ modList: [{ modid: 'x', name: 'X', version: '${version}' }] }) }));
  assert.deepStrictEqual([inspectJar(path.join(d, 'old2.jar')).name, inspectJar(path.join(d, 'old2.jar')).version], ['X', null]);
});

test('папка mods: в сборке NeoForge мод для Forge не помечается «чужим»', async (t) => {
  const svc = new Services(tmp(), { memories: Object.assign(new EventEmitter(), { list: async () => [], dir: tmp(), gameStarted() {}, gameStopped() {} }) });
  const p = await svc.store.createProfile({ name: 'N', minecraft: '1.20.1', loader: 'neoforge' });
  const dir = path.join(svc.store.gameDir(p.id), 'mods');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'forge-mod.jar'), forgeJar('fm', 'Forge Mod'));
  fs.writeFileSync(path.join(dir, 'fabric-mod.jar'), jar({ 'fabric.mod.json': JSON.stringify({ id: 'fb', name: 'Fabric Mod' }) }));
  http.setFetch(async () => new Response('{}', { status: 200 }));
  t.after(() => http.setFetch((...a) => globalThis.fetch(...a)));
  const by = Object.fromEntries((await svc.syncFolder(p.id)).local.map((m) => [m.name, m]));
  assert.equal(by['Forge Mod'].wrongLoader, false);
  assert.equal(by['Fabric Mod'].wrongLoader, true);
});

test('папка mods: узнанный мод — в сборку и под управление, свой — в список, чужой загрузчик — предупреждение', async (t) => {
  const svc = new Services(tmp(), { memories: Object.assign(new EventEmitter(), { list: async () => [], dir: tmp(), gameStarted() {}, gameStopped() {} }) });
  const p = await svc.store.createProfile({ name: 'Ф', minecraft: '1.20.1', loader: 'forge' });
  const dir = path.join(svc.store.gameDir(p.id), 'mods');
  fs.mkdirSync(dir, { recursive: true });
  const known = forgeJar('known', 'Known');
  const other = forgeJar('other', 'Other');
  const files = {
    'known-from-site.jar': known, // есть на Modrinth для Forge 1.20.1
    'other-version.jar': other, // есть на Modrinth, но только для Fabric
    'custom.jar': forgeJar('custom', 'Свой мод', '0.1'), // нет на Modrinth
    'fabric-only.jar': jar({ 'fabric.mod.json': JSON.stringify({ id: 'fo', name: 'Fabric Only', version: '1' }) }),
    'old.jar.disabled': forgeJar('old', 'Old'),
    'managed.jar': forgeJar('m', 'M'),
    'readme.txt': 'не мод',
  };
  for (const [n, b] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), b);
  fs.writeFileSync(path.join(dir, '.easylauncher-managed.json'), JSON.stringify({ files: ['managed.jar'] }));
  const H = sha1(known);
  const O = sha1(other);
  let hashAsks = 0;
  http.setFetch(async (url, opts = {}) => {
    const u = new URL(url);
    const ok = (j) => new Response(JSON.stringify(j), { status: 200, headers: { 'content-type': 'application/json' } });
    if (u.pathname.endsWith('/version_files')) {
      hashAsks++;
      const asked = JSON.parse(opts.body).hashes;
      const out = {};
      if (asked.includes(H)) out[H] = { id: 'V1', project_id: 'P1' };
      if (asked.includes(O)) out[O] = { id: 'V2', project_id: 'P2' };
      return ok(out);
    }
    if (u.pathname.endsWith('/project/P1')) return ok({ id: 'P1', slug: 'known', title: 'Known', project_type: 'mod', client_side: 'required', server_side: 'required', icon_url: null });
    if (u.pathname.endsWith('/project/P2')) return ok({ id: 'P2', slug: 'other', title: 'Other', project_type: 'mod', client_side: 'required', server_side: 'required' });
    if (u.pathname.endsWith('/version/V1'))
      return ok({ id: 'V1', project_id: 'P1', name: 'Known 1.0', version_number: '1.0.0', game_versions: ['1.20.1'], loaders: ['forge'], files: [{ filename: 'known-1.0.0.jar', url: 'https://cdn.modrinth.com/data/P1/known.jar', size: known.length, primary: true, hashes: { sha1: H } }], dependencies: [{ project_id: 'LIB', dependency_type: 'required' }] });
    if (u.pathname.endsWith('/version/V2')) return ok({ id: 'V2', project_id: 'P2', name: 'Other', version_number: '2', game_versions: ['1.20.1'], loaders: ['fabric'], files: [{ filename: 'o.jar', url: 'https://cdn.modrinth.com/o.jar', size: other.length, primary: true, hashes: { sha1: O } }], dependencies: [] });
    return new Response('{}', { status: 404 });
  });
  t.after(() => http.setFetch((...a) => globalThis.fetch(...a)));

  const r = await svc.syncFolder(p.id);
  assert.deepStrictEqual(r.adopted, [{ name: 'Known', version: '1.0.0' }]);
  const lock = await svc.store.getLock(p.id);
  const e = lock.mods.find((m) => m.key === 'modrinth:P1');
  assert.ok(e, 'узнанный мод теперь в сборке');
  assert.equal(e.file.hashes.sha1, H);
  assert.deepStrictEqual(e.dependencies, [{ key: 'modrinth:LIB', kind: 'required' }], 'зависимости — из каталога');
  assert.ok(!fs.existsSync(path.join(dir, 'known-from-site.jar')), 'файл игрока заменён копией лаунчера — мод не лежит дважды');
  assert.ok(fs.existsSync(path.join(dir, 'known-1.0.0.jar')));
  assert.ok(svc.launcher.cache.has(e.file), 'файл в кэше: сборку можно откатить и переложить');
  const by = Object.fromEntries(r.local.map((m) => [m.file, m]));
  assert.deepStrictEqual(Object.keys(by).sort(), ['custom.jar', 'fabric-only.jar', 'old.jar.disabled', 'other-version.jar'], 'служебный, управляемый и не-JAR файлы не в списке');
  assert.equal(by['custom.jar'].name, 'Свой мод');
  assert.equal(by['custom.jar'].version, '0.1');
  assert.equal(by['fabric-only.jar'].wrongLoader, true);
  assert.equal(by['other-version.jar'].otherTarget, true, 'Modrinth знает, но версия для Fabric — в сборку не берём');
  assert.equal(by['old.jar.disabled'].enabled, false);
  assert.equal(by['custom.jar'].wrongLoader, false);
  // счётчик на карточке: моды сборки + файлы из папки
  const card = await svc.cardFor(await svc.store.getProfile(p.id));
  assert.equal(card.mods, 1 + 4);
  assert.equal(card.modsFolder, 4);
  assert.equal(card.modsOff, 1);
  // повторная сверка: неузнанные файлы снова не спрашиваем (раз в сутки), хеши не пересчитываем
  const before = hashAsks;
  const r2 = await svc.syncFolder(p.id);
  assert.equal(hashAsks, before);
  assert.equal(r2.adopted.length, 0);
  assert.equal(r2.local.length, 4);
  // выключить и включить файл из папки, защита путей
  assert.deepStrictEqual(await svc.folderToggle(p.id, 'custom.jar', false), { file: 'custom.jar.disabled' });
  assert.ok(fs.existsSync(path.join(dir, 'custom.jar.disabled')));
  assert.deepStrictEqual(await svc.folderToggle(p.id, 'custom.jar.disabled', true), { file: 'custom.jar' });
  await assert.rejects(svc.folderPath(p.id, '..\\..\\lock.json'), /Некорректное имя/);
  await assert.rejects(svc.folderPath(p.id, 'managed.jar'), /нет в папке/, 'файлы лаунчера так не трогаются');
  await assert.rejects(svc.folderPath(p.id, 'known-1.0.0.jar'), /нет в папке/);
  // во время игры сборку не меняем
  svc.launcher.profileBusy = () => true;
  await assert.rejects(svc.folderToggle(p.id, 'custom.jar', false), /во время игры/);
});

test('папка mods: другая версия мода из сборки заменяет прежнюю; без кэша остальных файлов мод не пропадает из папки', async (t) => {
  const svc = new Services(tmp(), { memories: Object.assign(new EventEmitter(), { list: async () => [], dir: tmp(), gameStarted() {}, gameStopped() {} }) });
  const p = await svc.store.createProfile({ name: 'Ф', minecraft: '1.20.1', loader: 'forge' });
  const dir = path.join(svc.store.gameDir(p.id), 'mods');
  fs.mkdirSync(dir, { recursive: true });
  const fresh = forgeJar('known', 'Known', '1.0.0');
  const H = sha1(fresh);
  const lock = await svc.store.getLock(p.id);
  const old = { key: 'modrinth:P1', source: 'modrinth', projectId: 'P1', name: 'Known', versionId: 'V0', version: '0.9.0', side: { client: 'required', server: 'required' }, file: { filename: 'known-0.9.0.jar', url: null, size: 3, hashes: { sha1: 'a'.repeat(40) } }, dependencies: [], pinned: true, addedBy: 'user' };
  // ещё один мод сборки, файла которого нет в кэше: раскладка папки целиком упадёт
  const lost = { ...old, key: 'modrinth:LOST', projectId: 'LOST', name: 'Lost', file: { ...old.file, filename: 'lost.jar', hashes: { sha1: 'b'.repeat(40) } }, pinned: false };
  lock.mods = [old, lost];
  await svc.store.saveLock(p.id, lock);
  fs.writeFileSync(path.join(dir, 'known-0.9.0.jar'), 'old');
  fs.writeFileSync(path.join(dir, '.easylauncher-managed.json'), JSON.stringify({ files: ['known-0.9.0.jar', 'lost.jar'] }));
  fs.writeFileSync(path.join(dir, 'Known-1.0.0-from-site.jar'), fresh);
  http.setFetch(async (url) => {
    const u = new URL(url);
    const ok = (j) => new Response(JSON.stringify(j), { status: 200 });
    if (u.pathname.endsWith('/version_files')) return ok({ [H]: { id: 'V1', project_id: 'P1' } });
    if (u.pathname.endsWith('/project/P1')) return ok({ id: 'P1', slug: 'known', title: 'Known', client_side: 'required', server_side: 'required' });
    if (u.pathname.endsWith('/version/V1')) return ok({ id: 'V1', project_id: 'P1', version_number: '1.0.0', game_versions: ['1.20.1'], loaders: ['forge'], files: [{ filename: 'known-1.0.0.jar', url: 'https://cdn.modrinth.com/k.jar', size: fresh.length, primary: true, hashes: { sha1: H } }], dependencies: [] });
    return new Response('{}', { status: 404 });
  });
  t.after(() => http.setFetch((...a) => globalThis.fetch(...a)));
  const r = await svc.syncFolder(p.id);
  assert.deepStrictEqual(r.replaced, [{ name: 'Known', from: '0.9.0', to: '1.0.0' }]);
  const e = (await svc.store.getLock(p.id)).mods.find((m) => m.key === 'modrinth:P1');
  assert.equal(e.version, '1.0.0');
  assert.equal(e.pinned, true, 'закрепление игрока сохраняется');
  const names = fs.readdirSync(dir).sort();
  assert.ok(names.includes('known-1.0.0.jar'), 'новая версия в папке, хотя раскладка целиком не удалась');
  assert.ok(!names.includes('known-0.9.0.jar'), 'прежней версии нет — мод не задвоится');
  assert.ok(!names.includes('Known-1.0.0-from-site.jar'));
  const managed = JSON.parse(fs.readFileSync(path.join(dir, '.easylauncher-managed.json'), 'utf8')).files;
  assert.ok(managed.includes('known-1.0.0.jar') && !managed.includes('known-0.9.0.jar'));
  assert.equal((await svc.syncFolder(p.id)).local.length, 0, 'новая версия — файл лаунчера, не «из папки»');
});

test('папка mods: мод только с CurseForge узнаётся по отпечатку файла и становится модом сборки', async (t) => {
  const { fingerprint } = require('../core/catalog/curseforge');
  const svc = new Services(tmp(), { catalogBase: { curseforgeBackend: 'https://cf.test' }, memories: Object.assign(new EventEmitter(), { list: async () => [], dir: tmp(), gameStarted() {}, gameStopped() {} }) });
  const p = await svc.store.createProfile({ name: 'C', minecraft: '1.20.1', loader: 'forge' });
  const dir = path.join(svc.store.gameDir(p.id), 'mods');
  fs.mkdirSync(dir, { recursive: true });
  const bytes = forgeJar('cfonly', 'CF Only Mod', '2.0');
  fs.writeFileSync(path.join(dir, 'cf-only-2.0.jar'), bytes);
  fs.writeFileSync(path.join(dir, 'nobody.jar'), forgeJar('nobody', 'Nobody'));
  const FP = fingerprint(bytes);
  let fpAsks = 0;
  http.setFetch(async (url, opts = {}) => {
    const u = new URL(url);
    const ok = (j) => new Response(JSON.stringify(j), { status: 200 });
    if (u.pathname.endsWith('/version_files')) return ok({}); // Modrinth не знает
    if (u.pathname === '/cf/v1/fingerprints/432') {
      fpAsks++;
      const asked = JSON.parse(opts.body).fingerprints;
      return ok({ data: { exactMatches: asked.includes(FP) ? [{ id: 777, file: { id: 9001, modId: 777, fileFingerprint: FP } }] : [] } });
    }
    if (u.pathname === '/cf/v1/mods/777') return ok({ data: { id: 777, name: 'CF Only Mod', slug: 'cf-only', links: {}, latestFilesIndexes: [], classId: 6 } });
    if (u.pathname === '/cf/v1/mods/777/files/9001')
      return ok({ data: { id: 9001, modId: 777, displayName: 'CF Only 2.0', fileName: 'cf-only-2.0.jar', fileLength: bytes.length, downloadUrl: null, gameVersions: ['1.20.1', 'Forge'], hashes: [{ algo: 1, value: sha1(bytes) }], dependencies: [] } });
    return new Response('{}', { status: 404 });
  });
  t.after(() => http.setFetch((...a) => globalThis.fetch(...a)));
  const r = await svc.syncFolder(p.id);
  assert.deepStrictEqual(r.adopted.map((x) => x.name), ['CF Only Mod']);
  const e = (await svc.store.getLock(p.id)).mods.find((m) => m.key === 'curseforge:777');
  assert.ok(e, 'мод CurseForge в сборке');
  assert.equal(e.file.hashes.sha1, sha1(bytes));
  assert.ok(svc.launcher.cache.has(e.file), 'файл в кэше — даже если автор запретил скачивание из лаунчеров');
  assert.deepStrictEqual(r.local.map((m) => m.name), ['Nobody'], 'неузнанный остаётся «из папки»');
  assert.equal(fpAsks, 1);
  await svc.syncFolder(p.id);
  assert.equal(fpAsks, 1, 'неузнанный файл повторно не спрашиваем сутки');
});

test('папка mods: без сети файлы просто показываются; Vanilla и сборка друга не сверяются', async (t) => {
  const svc = new Services(tmp(), { memories: Object.assign(new EventEmitter(), { list: async () => [], dir: tmp(), gameStarted() {}, gameStopped() {} }) });
  const p = await svc.store.createProfile({ name: 'Ф', minecraft: '1.20.1', loader: 'forge' });
  const dir = path.join(svc.store.gameDir(p.id), 'mods');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.jar'), forgeJar('a', 'A'));
  http.setFetch(async () => {
    throw new Error('нет сети');
  });
  t.after(() => http.setFetch((...a) => globalThis.fetch(...a)));
  const r = await svc.syncFolder(p.id);
  assert.equal(r.adopted.length, 0);
  assert.deepStrictEqual(r.local.map((m) => m.name), ['A']);
  // без сети «раз в сутки» не включается: при появлении сети спросим снова
  const info = JSON.parse(fs.readFileSync(path.join(svc.store.profileDir(p.id), 'folder-mods.json'), 'utf8'));
  assert.equal(info['a.jar'].checked, 0);
  const v = await svc.store.createProfile({ name: 'V', minecraft: '1.20.1', loader: 'vanilla' });
  fs.mkdirSync(path.join(svc.store.gameDir(v.id), 'mods'), { recursive: true });
  fs.writeFileSync(path.join(svc.store.gameDir(v.id), 'mods', 'a.jar'), forgeJar('a', 'A'));
  assert.deepStrictEqual(await svc.syncFolder(v.id), { adopted: [], replaced: [], local: [] });
  assert.equal((await svc.cardFor(await svc.store.getProfile(v.id))).mods, 0);
});
