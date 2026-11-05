'use strict';
// Импорт готовых сборок: .mrpack (Modrinth) и архив CurseForge — чтение, безопасность путей, план, отчёт
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
const { readPack, extractOverrides, parseModlist, cfLoader, safeRel } = require('../core/modpack');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'easy-'));
const sha1 = (b) => crypto.createHash('sha1').update(b).digest('hex');
const svcOf = () => new Services(tmp(), { memories: Object.assign(new EventEmitter(), { list: async () => [], dir: tmp(), gameStarted() {}, gameStopped() {} }) });
function zipFile(files) {
  const z = new AdmZip();
  for (const [n, t] of Object.entries(files)) z.addFile(n, Buffer.isBuffer(t) ? t : Buffer.from(typeof t === 'string' ? t : JSON.stringify(t)));
  const f = path.join(tmp(), 'pack.zip');
  z.writeZip(f);
  return f;
}
const ok = (j) => new Response(JSON.stringify(j), { status: 200, headers: { 'content-type': 'application/json' } });

// поддельный Modrinth: проекты, релизы, поиск, поиск по хешу
function fakeModrinth({ projects, versions, byHash, extra = {} }) {
  const calls = [];
  const fetch = async (url, opts = {}) => {
    const u = new URL(url);
    const p = u.pathname.replace(/^\/v2/, '');
    calls.push(`${opts.method || 'GET'} ${p}`);
    if (extra[url]) return new Response(extra[url], { status: 200 });
    if (p === '/version_files') {
      const out = {};
      for (const h of JSON.parse(opts.body).hashes) if (byHash[h]) out[h] = byHash[h];
      return ok(out);
    }
    if (p === '/versions') return ok(JSON.parse(u.searchParams.get('ids')).map((id) => versions[id]).filter(Boolean));
    if (p === '/projects') return ok(JSON.parse(u.searchParams.get('ids')).map((id) => projects[id]).filter(Boolean));
    let m;
    if ((m = /^\/version\/([\w-]+)$/.exec(p))) return versions[m[1]] ? ok(versions[m[1]]) : new Response('{}', { status: 404 });
    if ((m = /^\/project\/([\w-]+)\/version$/.exec(p))) {
      const pr = Object.values(projects).find((x) => x.id === m[1] || x.slug === m[1]);
      return ok(Object.values(versions).filter((v) => pr && v.project_id === pr.id));
    }
    if ((m = /^\/project\/([\w-]+)$/.exec(p))) {
      const pr = Object.values(projects).find((x) => x.id === m[1] || x.slug === m[1]);
      return pr ? ok(pr) : new Response('{}', { status: 404 });
    }
    if (p === '/search') {
      const q = u.searchParams.get('query').toLowerCase();
      return ok({ total_hits: 1, hits: Object.values(projects).filter((x) => x.title.toLowerCase().includes(q)).map((x) => ({ ...x, project_id: x.id })) });
    }
    return new Response('{}', { status: 404 });
  };
  return { fetch, calls };
}
const proj = (id, title, slug = title.toLowerCase().replace(/\W+/g, '-')) => ({ id, slug, title, project_type: 'mod', client_side: 'required', server_side: 'optional', icon_url: null });
const ver = (id, pid, { mc = ['1.20.1'], loaders = ['fabric'], deps = [], file } = {}) => ({
  id,
  project_id: pid,
  name: id,
  version_number: id + '.0',
  version_type: 'release',
  game_versions: mc,
  loaders,
  date_published: '2024-01-0' + (id.length % 9) + 'T00:00:00Z',
  files: [{ filename: `${id}.jar`, url: `https://cdn.modrinth.com/data/${pid}/${id}.jar`, size: 10, primary: true, hashes: { sha1: file || sha1(id), sha512: 'x' } }],
  dependencies: deps,
});

test('чтение .mrpack: загрузчик, моды, серверные файлы пропускаются, опасные пути отбрасываются, client-overrides сильнее', async () => {
  const f = zipFile({
    'modrinth.index.json': {
      formatVersion: 1,
      game: 'minecraft',
      name: 'Тестовая сборка',
      dependencies: { minecraft: '1.20.1', 'fabric-loader': '0.15.7' },
      files: [
        { path: 'mods/a.jar', hashes: { sha1: 'a'.repeat(40) }, downloads: ['https://cdn.modrinth.com/a.jar'], fileSize: 1 },
        { path: 'mods/server-only.jar', hashes: { sha1: 'b'.repeat(40) }, env: { client: 'unsupported', server: 'required' }, downloads: [] },
        { path: '../../evil.jar', hashes: { sha1: 'c'.repeat(40) }, downloads: ['https://cdn.modrinth.com/e.jar'] },
        { path: 'resourcepacks/rp.zip', hashes: { sha1: 'd'.repeat(40) }, downloads: ['https://evil.example/rp.zip', 'https://github.com/x/rp.zip'] },
      ],
    },
    'overrides/config/a.toml': 'from-overrides',
    'client-overrides/config/a.toml': 'from-client',
    'overrides/options.txt': 'fov:1',
  });
  const p = await readPack(f);
  assert.deepStrictEqual([p.kind, p.name, p.minecraft, p.loader, p.loaderVersion], ['mrpack', 'Тестовая сборка', '1.20.1', 'fabric', '0.15.7']);
  assert.deepStrictEqual(p.mods.map((m) => m.path), ['mods/a.jar']);
  assert.deepStrictEqual(p.files.map((x) => [x.path, x.urls]), [['resourcepacks/rp.zip', ['https://github.com/x/rp.zip']]], 'только разрешённые площадки');
  const game = tmp();
  assert.equal(await extractOverrides(p, game), 2);
  assert.equal(fs.readFileSync(path.join(game, 'config', 'a.toml'), 'utf8'), 'from-client');
  assert.equal(fs.readFileSync(path.join(game, 'options.txt'), 'utf8'), 'fov:1');
});

test('безопасные пути, загрузчики CurseForge, modlist.html; не сборка — понятная ошибка', async () => {
  assert.equal(safeRel('config/a.toml'), 'config/a.toml');
  for (const bad of ['../x', 'a/../../x', '/etc/passwd', 'C:\\Windows\\x', 'a/b:c', '']) assert.equal(safeRel(bad), null, bad);
  assert.deepStrictEqual(cfLoader('forge-47.2.0'), { loader: 'forge', version: '47.2.0' });
  assert.deepStrictEqual(cfLoader('neoforge-20.4.80'), { loader: 'neoforge', version: '20.4.80' });
  assert.equal(cfLoader('liteloader-1'), null);
  const list = parseModlist('<ul><li><a href="https://www.curseforge.com/minecraft/mc-mods/jei">Just Enough Items (JEI) (by mezz)</a></li><li><a href="https://curseforge.com/minecraft/mc-mods/Some-Mod/">Tom &amp; Jerry (by x)</a></li></ul>');
  assert.deepStrictEqual(list, [
    { url: 'https://www.curseforge.com/minecraft/mc-mods/jei', slug: 'jei', name: 'Just Enough Items (JEI)' },
    { url: 'https://www.curseforge.com/minecraft/mc-mods/some-mod', slug: 'some-mod', name: 'Tom & Jerry' },
  ]);
  await assert.rejects(readPack(zipFile({ 'readme.txt': 'hi' })), /не сборка Modrinth/);
  const notZip = path.join(tmp(), 'x.mrpack');
  fs.writeFileSync(notZip, 'это не архив');
  await assert.rejects(readPack(notZip), /не архив сборки/);
  await assert.rejects(readPack(zipFile({ 'modrinth.index.json': '{ сломан' })), /испорчен/);
});

test('импорт .mrpack: точные релизы, неподходящий релиз заменён подходящим, файлы не с Modrinth — со сверкой, настройки разложены', async (t) => {
  const svc = svcOf();
  const github = Buffer.from('github-mod-bytes');
  const rp = Buffer.from('resourcepack');
  const mr = fakeModrinth({
    projects: { P1: proj('P1', 'Sodium'), P2: proj('P2', 'Old Mod'), LIB: proj('LIB', 'Fabric API', 'fabric-api') },
    versions: {
      V1: ver('V1', 'P1', { deps: [{ project_id: 'LIB', dependency_type: 'required' }] }),
      V2: ver('V2', 'P2', { mc: ['1.20'] }), // в сборке — релиз не для 1.20.1
      V2b: ver('V2b', 'P2'),
      L1: ver('L1', 'LIB'),
    },
    byHash: { [sha1('V1')]: { id: 'V1', project_id: 'P1' }, [sha1('V2')]: { id: 'V2', project_id: 'P2' }, [sha1('L1')]: { id: 'L1', project_id: 'LIB' } },
    extra: { 'https://github.com/a/b/releases/download/1/own.jar': github, 'https://github.com/a/b/rp.zip': rp },
  });
  http.setFetch(mr.fetch);
  t.after(() => http.setFetch((...a) => globalThis.fetch(...a)));
  const f = zipFile({
    'modrinth.index.json': {
      formatVersion: 1,
      game: 'minecraft',
      name: 'Fabulously',
      dependencies: { minecraft: '1.20.1', 'fabric-loader': '0.15.7' },
      files: [
        { path: 'mods/sodium.jar', hashes: { sha1: sha1('V1') }, downloads: ['https://cdn.modrinth.com/data/P1/V1.jar'], fileSize: 10 },
        { path: 'mods/old.jar', hashes: { sha1: sha1('V2') }, downloads: ['https://cdn.modrinth.com/data/P2/V2.jar'], fileSize: 10 },
        { path: 'mods/fabric-api.jar', hashes: { sha1: sha1('L1') }, downloads: ['https://cdn.modrinth.com/data/LIB/L1.jar'], fileSize: 10 },
        { path: 'mods/own.jar', hashes: { sha1: sha1(github) }, downloads: ['https://github.com/a/b/releases/download/1/own.jar'], fileSize: github.length },
        { path: 'mods/gone.jar', hashes: { sha1: 'f'.repeat(40) }, downloads: ['https://evil.example/gone.jar'] },
        { path: 'resourcepacks/rp.zip', hashes: { sha1: sha1(rp) }, downloads: ['https://github.com/a/b/rp.zip'], fileSize: rp.length },
      ],
    },
    'overrides/config/sodium.json': '{"x":1}',
  });
  const r = await svc.importPack(f);
  assert.equal(r.profile.loader, 'fabric');
  assert.equal(r.profile.minecraft, '1.20.1');
  assert.equal((await svc.store.getLock(r.profile.id)).loaderVersion, '0.15.7', 'версия загрузчика — из сборки');
  assert.ok(r.plan.ok, JSON.stringify(r.plan.errors));
  const adds = Object.fromEntries(r.plan.changes.filter((c) => c.type === 'add').map((c) => [c.name, c.to]));
  assert.deepStrictEqual(adds, { Sodium: 'V1.0', 'Old Mod': 'V2b.0', 'Fabric API': 'L1.0' }, 'точные релизы; неподходящий — подобран совместимый');
  assert.ok(r.request.add.some((a) => a.projectId === 'P2' && !a.versionId), 'запрос для окна плана — уже исправленный');
  const game = svc.store.gameDir(r.profile.id);
  assert.ok(fs.existsSync(path.join(game, 'mods', 'own.jar')), 'мод не с Modrinth скачан в папку модов');
  assert.ok(fs.existsSync(path.join(game, 'resourcepacks', 'rp.zip')));
  assert.ok(fs.existsSync(path.join(game, 'config', 'sodium.json')));
  assert.deepStrictEqual([r.report.total, r.report.files, r.report.overrides], [5, 2, 1]);
  assert.deepStrictEqual(r.report.notFound.map((x) => x.name), ['gone.jar'], 'с чужого сайта не качаем');
  assert.ok(mr.calls.filter((c) => c.startsWith('GET /version/')).length === 0, 'релизы взяты пачкой, а не по одному');
});

/** CurseForge «не подключён» — как если бы прокси не было. */
function withoutCurseForge(svc) {
  const orig = svc.providers.bind(svc);
  svc.providers = async () => ({ ...(await orig()), curseforge: { status: () => ({ available: false }) } });
  return svc;
}

test('импорт архива CurseForge без CurseForge: те же моды с Modrinth по адресу и названию, ненайденные — со ссылками', async (t) => {
  const svc = withoutCurseForge(svcOf());
  const mr = fakeModrinth({
    projects: { J: proj('J', 'Just Enough Items', 'jei'), C: proj('C', 'Clumps'), X: proj('X', 'Only Fabric') },
    versions: { J1: ver('J1', 'J', { loaders: ['forge'] }), C1: ver('C1', 'C', { loaders: ['forge'] }), X1: ver('X1', 'X', { loaders: ['fabric'] }) },
    byHash: {},
  });
  http.setFetch(mr.fetch);
  t.after(() => http.setFetch((...a) => globalThis.fetch(...a)));
  const f = zipFile({
    'manifest.json': { manifestType: 'minecraftModpack', manifestVersion: 1, name: 'CF Pack', minecraft: { version: '1.20.1', modLoaders: [{ id: 'forge-47.2.0', primary: true }] }, files: [{ projectID: 238222, fileID: 1, required: true }, { projectID: 2, fileID: 2 }, { projectID: 3, fileID: 3 }, { projectID: 4, fileID: 4 }], overrides: 'overrides' },
    'modlist.html':
      '<ul><li><a href="https://www.curseforge.com/minecraft/mc-mods/jei">Just Enough Items (JEI) (by mezz)</a></li><li><a href="https://www.curseforge.com/minecraft/mc-mods/clumps-cf">Clumps (by Jared)</a></li><li><a href="https://www.curseforge.com/minecraft/mc-mods/only-fabric">Only Fabric (by y)</a></li><li><a href="https://www.curseforge.com/minecraft/mc-mods/nowhere">Nowhere Mod (by z)</a></li></ul>',
    'overrides/config/jei.cfg': 'a',
  });
  const r = await svc.importPack(f);
  assert.deepStrictEqual([r.profile.loader, r.profile.minecraft], ['forge', '1.20.1']);
  assert.equal(r.report.noCurseForge, true);
  assert.equal(r.report.viaModrinth, 2, 'JEI — по адресу (slug), Clumps — по названию');
  assert.deepStrictEqual(r.report.notFound.map((x) => [x.name, x.url]), [
    ['Only Fabric', 'https://www.curseforge.com/minecraft/mc-mods/only-fabric'],
    ['Nowhere Mod', 'https://www.curseforge.com/minecraft/mc-mods/nowhere'],
  ], 'мод только для Fabric в сборку Forge не берём');
  assert.ok(r.plan.ok);
  assert.deepStrictEqual(r.plan.changes.map((c) => c.name).sort(), ['Clumps', 'Just Enough Items']);
  assert.equal(r.report.overrides, 1);
});

test('импорт архива CurseForge с CurseForge: точные файлы из manifest.json', async (t) => {
  const svc = new Services(tmp(), { catalogBase: { curseforgeBackend: 'https://cf.test' }, memories: Object.assign(new EventEmitter(), { list: async () => [], dir: tmp(), gameStarted() {}, gameStopped() {} }) });
  const names = { 238222: 'JEI', 9: 'Other', 77: 'Fabric Lib', 55: 'Nice Textures' };
  const mod = (id) => ({ id, name: names[id], slug: names[id].toLowerCase().replace(/ /g, '-'), links: {}, allowModDistribution: true, latestFilesIndexes: [], classId: id === 55 ? 12 : 6 });
  const rpBytes = Buffer.from('resourcepack-zip');
  const file = (id, modId) => ({
    id,
    modId,
    displayName: `f${id}`,
    fileName: modId === 55 ? 'Nice Textures.zip' : `f${id}.jar`,
    fileLength: modId === 55 ? rpBytes.length : 5,
    downloadUrl: modId === 55 ? 'https://edge.forgecdn.net/files/55/Nice%20Textures.zip' : `https://edge.forgecdn.net/files/${id}/f${id}.jar`,
    gameVersions: modId === 77 ? ['1.20.1', 'Fabric'] : modId === 55 ? ['1.20.1'] : ['1.20.1', 'Forge'],
    hashes: [{ algo: 1, value: modId === 55 ? sha1(rpBytes) : sha1('f' + id) }],
    // мод для нескольких загрузчиков указывает библиотеку Fabric как обязательную
    dependencies: modId === 9 ? [{ modId: 77, relationType: 3 }] : [],
    releaseType: 1,
  });
  const seen = [];
  http.setFetch(async (url) => {
    const u = new URL(url);
    const p = u.pathname;
    seen.push(p);
    let m;
    if (u.host === 'edge.forgecdn.net' && /Nice/.test(p)) return new Response(rpBytes, { status: 200 });
    if ((m = /^\/cf\/v1\/mods\/(\d+)\/files\/(\d+)$/.exec(p))) return ok({ data: file(Number(m[2]), Number(m[1])) });
    if ((m = /^\/cf\/v1\/mods\/(\d+)\/files$/.exec(p))) return ok({ data: [file(7700, Number(m[1]))] });
    if ((m = /^\/cf\/v1\/mods\/(\d+)$/.exec(p))) return ok({ data: mod(Number(m[1])) });
    return new Response('{}', { status: 404 });
  });
  t.after(() => http.setFetch((...a) => globalThis.fetch(...a)));
  const f = zipFile({ 'manifest.json': { manifestType: 'minecraftModpack', name: 'CF', minecraft: { version: '1.20.1', modLoaders: [{ id: 'forge-47.2.0', primary: true }] }, files: [{ projectID: 238222, fileID: 4001 }, { projectID: 9, fileID: 4002 }, { projectID: 55, fileID: 5500 }] } });
  const r = await svc.importPack(f);
  assert.equal(r.report.noCurseForge, false);
  assert.ok(r.plan.ok, 'зависимость Fabric в сборке Forge не мешает: ' + JSON.stringify(r.plan.errors));
  assert.ok(r.plan.warnings.some((w) => w.code === 'DEP_SKIPPED' && /Fabric Lib/.test(w.message)));
  assert.deepStrictEqual(r.plan.changes.map((c) => [c.name, c.to]).sort(), [['JEI', 'f4001'], ['Other', 'f4002']]);
  assert.ok(seen.includes('/cf/v1/mods/238222/files/4001'), 'точный файл из manifest');
  assert.equal(r.report.total, 2, 'ресурспак — не мод');
  assert.equal(r.report.files, 1);
  assert.ok(fs.existsSync(path.join(svc.store.gameDir(r.profile.id), 'resourcepacks', 'Nice Textures.zip')), 'ресурспак — в свою папку');
  assert.equal(r.request.trustPack, true, 'окно плана пересобирает план так же снисходительно');
});

test('импорт: сбой — сборка не остаётся наполовину; .easypack — с запросом для окна плана', async (t) => {
  const svc = svcOf();
  http.setFetch(async () => {
    throw new Error('нет сети');
  });
  t.after(() => http.setFetch((...a) => globalThis.fetch(...a)));
  const f = zipFile({ 'modrinth.index.json': { game: 'minecraft', name: 'X', dependencies: { minecraft: '1.20.1', 'fabric-loader': '0.15.7' }, files: [{ path: 'mods/a.jar', hashes: { sha1: 'a'.repeat(40) }, downloads: [] }] } });
  await assert.rejects(svc.importPack(f), /Не удалось связаться с Modrinth/);
  assert.equal((await svc.store.listProfiles()).length, 0, 'недоделанная сборка удалена');
  await assert.rejects(svc.importPack(zipFile({ 'modrinth.index.json': { game: 'minecraft', dependencies: {} } })), /не указана версия Minecraft/);
  // .easypack без модов — без плана
  const ep = path.join(tmp(), 'x.easypack');
  fs.writeFileSync(ep, JSON.stringify({ format: 'easylauncher.pack/1', name: 'E', minecraft: '1.20.1', loader: 'fabric', mods: [] }));
  const r = await svc.importPack(ep);
  assert.equal(r.plan, null);
  assert.equal(r.report, null);
});
