'use strict';
// Загрузчики Fabric, Quilt, Forge, NeoForge и старые версии Minecraft. Серверы Mojang, Fabric/Quilt Meta,
// Maven Forge/NeoForge — локальная имитация; установщик Forge/NeoForge — поддельный (те же ключи и результаты).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const AdmZip = require('adm-zip');
const http = require('../core/http');
const loaders = require('../core/loaders');
const { Launcher } = require('../core/launcher');
const { Mojang } = require('../core/mojang');
const { createFakeMojang } = require('./fakemojang');
const { buildFixtures, waitEvent } = require('./helpers');

const AUTH = { name: 'HostPlayer', uuid: 'abc', accessToken: 'tok', xuid: '', clientId: '' };
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

test('версии NeoForge → версия Minecraft, сортировка версий загрузчиков', () => {
  assert.equal(loaders.neoMinecraft('20.4.237'), '1.20.4');
  assert.equal(loaders.neoMinecraft('21.0.5'), '1.21');
  assert.equal(loaders.neoMinecraft('21.1.77'), '1.21.1');
  assert.equal(loaders.neoMinecraft('21.1.80-beta'), '1.21.1');
  assert.equal(loaders.neoMinecraft('26.1.0.12'), '26.1');
  assert.equal(loaders.neoMinecraft('26.1.1.3-beta'), '26.1.1');
  assert.deepEqual(['47.3.0', '47.10.1', '47.3.10'].sort(loaders.cmp), ['47.3.0', '47.3.10', '47.10.1']);
  assert.ok(loaders.cmp('21.1.1', '21.1.1-beta') > 0, 'релиз новее беты');
});

test('Fabric, Quilt, Forge, NeoForge: версии, рекомендуемая, поддерживаемые версии игры', async () => {
  const fm = await createFakeMojang({ delayMs: 0 });
  http.setFetch((u, o) => fetch(fm.rewrite(u), o));
  try {
    const forge = await loaders.loaderVersions('forge', '1.21.1');
    assert.deepEqual(forge.map((x) => x.version), ['52.0.2', '52.0.1']);
    assert.equal(loaders.pickLoaderVersion(forge), '52.0.1', 'рекомендованная авторами Forge');
    const neo = await loaders.loaderVersions('neoforge', '1.21.1');
    assert.deepEqual(neo.map((x) => x.version), ['21.1.80-beta', '21.1.77']);
    assert.equal(loaders.pickLoaderVersion(neo), '21.1.77', 'стабильная, а не бета');
    assert.equal(loaders.pickLoaderVersion(await loaders.loaderVersions('quilt', '1.21.1')), '0.27.1');
    assert.equal(loaders.pickLoaderVersion(await loaders.loaderVersions('fabric', '1.21.1')), '0.16.9');
    assert.ok((await loaders.supportedMinecraft('neoforge')).has('1.21'));
    assert.ok(!(await loaders.supportedMinecraft('forge')).has('1.21'));
    assert.deepEqual(await loaders.loaderVersions('forge', '1.21'), []);
  } finally {
    http.setFetch((...a) => globalThis.fetch(...a));
    fm.close();
  }
});

for (const [loader, check] of [
  ['forge', (lines) => lines.includes('arg:forgeclient')],
  ['neoforge', (lines) => lines.includes('arg:neoforgeclient')],
  ['quilt', (lines) => lines.includes('arg:--gameDir')],
]) {
  test(`${loader}: установка загрузчика, запуск клиента и сервера сессии`, async (t) => {
    if (!buildFixtures().ok) return t.skip('нет JDK');
    const fm = await createFakeMojang({ delayMs: 0 });
    http.setFetch((u, o) => fetch(fm.rewrite(u), o));
    process.env.FAKE_SERVER_JAR = buildFixtures().serverJar;
    const l = new Launcher(tmp('easy-ld-'), { totalMem: 16 * 1024 ** 3 });
    try {
      const p = await l.store.createProfile({ minecraft: '1.21.1', loader });
      const stages = [];
      l.on('event', (e) => e.type === 'stage' && e.detail && stages.push(e.detail));
      const stopped = waitEvent(l, (e) => e.type === 'client' && e.state === 'stopped');
      await l.play({ profileId: p.id, nickname: 'Steve', ram: 1 });
      assert.equal((await stopped).code, 0);
      assert.ok(check(l.clientLines), 'клиент запущен через профиль загрузчика');
      const lock = await l.store.getLock(p.id);
      assert.equal(lock.loaderVersion, { forge: '52.0.1', neoforge: '21.1.77', quilt: '0.27.1' }[loader], 'выбрана рекомендуемая версия и запомнена');
      if (loader !== 'quilt') {
        assert.ok(stages.some((d) => d.startsWith(loader === 'forge' ? 'Forge:' : 'NeoForge:')), 'вывод установщика виден в прогрессе');
        assert.ok(fm.requests.some((r) => r.endsWith('installer.jar.sha1')), 'установщик проверен по SHA-1 с Maven');
        // повторный запуск — установщик больше не запускается
        const n = fm.requests.length;
        const again = waitEvent(l, (e) => e.type === 'client' && e.state === 'stopped');
        await l.play({ profileId: p.id, nickname: 'Steve', ram: 1 });
        await again;
        assert.deepEqual(fm.requests.slice(n), []);
      }
      const r = await l.startSession({ profileId: p.id, create: { name: 'Мир' }, auth: AUTH, eula: true, serverRam: 1 });
      assert.equal(l.server.state, 'running', 'сервер загрузчика запустился');
      assert.ok(fs.existsSync(path.join(l.worlds.savesDir(p.id), r.folder, 'level.dat')));
      await l.endSession();
    } finally {
      http.setFetch((...a) => globalThis.fetch(...a));
      delete process.env.FAKE_SERVER_JAR;
      fm.close();
      await l.shutdown();
    }
  });
}

test('старый Forge (установщик 1.x): профиль версии и библиотека Forge берутся из установщика', async () => {
  const shared = tmp('easy-oldforge-');
  const mojang = new Mojang(shared);
  // родительская версия 1.7.10 уже есть локально
  await mojang.saveVersion({ id: '1.7.10', mainClass: 'net.minecraft.client.main.Main', minecraftArguments: '--username ${auth_player_name}', libraries: [], downloads: { client: { url: 'x', sha1: 'a'.repeat(40), size: 1 } }, assets: '1.7.10' });
  const z = new AdmZip();
  z.addFile('forge-1.7.10-10.13.4.1614-1.7.10-universal.jar', Buffer.from('universal'));
  z.addFile('install_profile.json', Buffer.from(JSON.stringify({
    install: { path: 'net.minecraftforge:forge:1.7.10-10.13.4.1614-1.7.10', filePath: 'forge-1.7.10-10.13.4.1614-1.7.10-universal.jar' },
    versionInfo: {
      id: '1.7.10-Forge10.13.4.1614-1.7.10',
      mainClass: 'net.minecraft.launchwrapper.Launch',
      minecraftArguments: '--username ${auth_player_name} --tweakClass cpw.mods.fml.common.launcher.FMLTweaker',
      libraries: [
        { name: 'net.minecraftforge:forge:1.7.10-10.13.4.1614-1.7.10', url: 'http://files.minecraftforge.net/maven/' },
        { name: 'net.minecraft:launchwrapper:1.12' },
        { name: 'com.typesafe.akka:akka-actor_2.11:2.3.3', url: 'http://files.minecraftforge.net/maven/', serverreq: true, clientreq: true },
        { name: 'org.scala-lang:scala-actors-migration_2.11:1.1.0', serverreq: true, clientreq: false },
      ],
    },
  })));
  const jar = z.toBuffer();
  const url = loaders.installerUrl('forge', '1.7.10', '10.13.4.1614-1.7.10');
  const sha = crypto.createHash('sha1').update(jar).digest('hex');
  http.setFetch(async (u) => (u === url ? new Response(jar, { headers: { 'content-length': String(jar.length) } }) : u === url + '.sha1' ? new Response(sha) : new Response('nf', { status: 404 })));
  try {
    const id = await loaders.installForgeClient(mojang, 'forge', '1.7.10', '10.13.4.1614-1.7.10', { java: 'java' });
    assert.equal(id, '1.7.10-Forge10.13.4.1614-1.7.10');
    const v = await mojang.getVersion(id);
    assert.equal(v.mainClass, 'net.minecraft.launchwrapper.Launch');
    assert.match(v.minecraftArguments, /FMLTweaker/);
    assert.equal(v.jar, '1.7.10', 'клиентский JAR — обычный 1.7.10');
    const names = v.libraries.map((x) => x.name);
    assert.ok(names.includes('net.minecraft:launchwrapper:1.12'));
    assert.ok(!names.includes('org.scala-lang:scala-actors-migration_2.11:1.1.0'), 'серверные библиотеки клиенту не нужны');
    assert.equal(v.libraries.find((x) => x.name.startsWith('com.typesafe')).url, 'https://maven.minecraftforge.net/', 'старый адрес Maven исправлен');
    assert.equal(fs.readFileSync(path.join(mojang.librariesDir, 'net/minecraftforge/forge/1.7.10-10.13.4.1614-1.7.10/forge-1.7.10-10.13.4.1614-1.7.10.jar'), 'utf8'), 'universal');
  } finally {
    http.setFetch((...a) => globalThis.fetch(...a));
  }
});

test('очень старые версии: ресурсы «legacy» и «pre-1.6» раскладываются по именам', async () => {
  const shared = tmp('easy-oldassets-');
  const mojang = new Mojang(shared);
  const buf = Buffer.from('sound');
  const hash = crypto.createHash('sha1').update(buf).digest('hex');
  for (const kind of ['virtual', 'map_to_resources']) {
    const index = Buffer.from(JSON.stringify({ [kind]: true, objects: { 'sound/step/grass1.ogg': { hash, size: buf.length } } }));
    const idxSha = crypto.createHash('sha1').update(index).digest('hex');
    http.setFetch(async (u) => (u.endsWith('/index.json') ? new Response(index) : u.endsWith(hash) ? new Response(buf, { headers: { 'content-length': String(buf.length) } }) : new Response('nf', { status: 404 })));
    const r = await mojang.installAssets({ assetIndex: { id: kind, url: 'https://x/index.json', sha1: idxSha } });
    if (kind === 'virtual') assert.equal(fs.readFileSync(path.join(r.gameAssets, 'sound/step/grass1.ogg'), 'utf8'), 'sound');
    else assert.equal(r.mapToResources[0].name, 'sound/step/grass1.ogg');
  }
  http.setFetch((...a) => globalThis.fetch(...a));
});

test('сборки с любыми версиями из манифеста: снапшоты, бета, альфа', async () => {
  const { Store } = require('../core/store');
  const store = new Store(tmp('easy-vers-'));
  for (const mc of ['26.1', '24w14a', '1.21-pre1', 'b1.7.3', 'a1.2.6', 'rd-132211', '1.14 Pre-Release 1']) assert.ok(await store.createProfile({ minecraft: mc }));
  await assert.rejects(store.createProfile({ minecraft: '../evil' }));
  await assert.rejects(store.createProfile({ minecraft: '1.2/3' }));
});

test('Forge с установщиком без режима «без окна»: лаунчер сам берёт свежий официальный установщик', async (t) => {
  if (!buildFixtures().ok) return t.skip('нет JDK');
  const fm = await createFakeMojang({ delayMs: 0 });
  http.setFetch((u, o) => fetch(fm.rewrite(u), o));
  const l = new Launcher(tmp('easy-ldold-'), { totalMem: 16 * 1024 ** 3 });
  try {
    const p = await l.store.createProfile({ minecraft: '1.20.1', loader: 'forge' });
    const logs = [];
    l.on('event', (e) => e.type === 'stage' && e.detail && logs.push(e.detail));
    const stopped = waitEvent(l, (e) => e.type === 'client' && e.state === 'stopped');
    await l.play({ profileId: p.id, nickname: 'Steve', ram: 1 });
    assert.equal((await stopped).code, 0);
    assert.ok(logs.some((d) => /не умеет ставить без окна/.test(d)));
    assert.ok(fm.requests.some((r) => r.endsWith('installer-2.2.15-fatjar.jar')));
    assert.ok(l.clientLines.includes('arg:forgeclient'));
  } finally {
    http.setFetch((...a) => globalThis.fetch(...a));
    fm.close();
    await l.shutdown();
  }
});

test('Quilt Meta отдаёт версии вразнобой — лаунчер сортирует, рекомендует последнюю стабильную', async () => {
  const list = ['0.20.0-beta.9', '0.24.0', '0.20.2-beta.1', '0.25.0-beta.1', '0.23.0', '0.17.5-beta.10', '0.20.0-beta.10'].map((version) => ({ loader: { version } }));
  http.setFetch(async () => new Response(JSON.stringify(list)));
  try {
    const r = await loaders.loaderVersions('quilt', '9.9.9');
    assert.deepEqual(r.map((x) => x.version), ['0.25.0-beta.1', '0.24.0', '0.23.0', '0.20.2-beta.1', '0.20.0-beta.10', '0.20.0-beta.9', '0.17.5-beta.10']);
    assert.equal(loaders.pickLoaderVersion(r), '0.24.0');
  } finally {
    http.setFetch((...a) => globalThis.fetch(...a));
  }
});
