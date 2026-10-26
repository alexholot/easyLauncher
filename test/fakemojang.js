'use strict';
// Локальная имитация серверов Mojang (манифест версий, библиотеки, ресурсы, Java) и Fabric Meta для
// сквозных тестов: через неё проходит настоящий конвейер установки лаунчера — загрузка, хеши, прогресс.
// Игра и сервер — поддельные Java-программы из test/fixtures (не Minecraft).
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const path = require('path');
const { buildFixtures, fakeForgeInstaller, fakeForgeTool, oldGameProbe } = require('./helpers');

const HOSTS = ['piston-meta.mojang.com', 'launchermeta.mojang.com', 'piston-data.mojang.com', 'libraries.minecraft.net', 'resources.download.minecraft.net', 'meta.fabricmc.net', 'meta.quiltmc.org', 'maven.minecraftforge.net', 'files.minecraftforge.net', 'maven.neoforged.net', 'launchercontent.mojang.com'];
const sha1 = (b) => crypto.createHash('sha1').update(b).digest('hex');

function systemJava() {
  try {
    return execFileSync('sh', ['-c', 'readlink -f "$(command -v java)"']).toString().trim();
  } catch {
    return 'java';
  }
}

/**
 * opts.assets — число файлов ресурсов, opts.assetSize — их размер, opts.delayMs — задержка между частями ответа,
 * opts.oldVersions — добавить настоящие описания старых версий Mojang из test/fixtures/oldversions.
 */
async function createFakeMojang({ assets = 40, assetSize = 256 * 1024, delayMs = 15, oldVersions = false } = {}) {
  const fx = buildFixtures();
  const hosts = new Set(HOSTS);
  const files = new Map(); // путь → Buffer
  let base = '';
  const put = (p, buf) => putAt('piston-data.mojang.com', p, buf);
  const putAt = (host, p, buf) => {
    files.set(`/${host}${p}`, buf);
    return { url: `https://${host}${p}`, sha1: sha1(buf), size: buf.length };
  };

  // ресурсы игры
  const objects = {};
  for (let i = 0; i < assets; i++) {
    const buf = crypto.randomBytes(assetSize);
    const h = sha1(buf);
    files.set(`/resources.download.minecraft.net/${h.slice(0, 2)}/${h}`, buf);
    objects[`minecraft/fake/${i}.bin`] = { hash: h, size: buf.length };
  }
  const index = Buffer.from(JSON.stringify({ objects }));
  const indexRef = putAt('piston-meta.mojang.com', '/v1/packages/index/17.json', index);

  // библиотека и клиент
  const lib = crypto.randomBytes(512 * 1024);
  const libRef = putAt('libraries.minecraft.net', '/org/example/fake-lib/1.0/fake-lib-1.0.jar', lib);
  const client = put('/v1/objects/client/client.jar', fs.readFileSync(fx.clientJar));
  const server = put('/v1/objects/server/server.jar', fs.readFileSync(fx.serverJar));

  // Java: «рантайм» — сценарий, запускающий системную Java (настоящий рантайм в тесте не скачать)
  const javaScript = Buffer.from(`#!/bin/sh\nexec "${systemJava()}" "$@"\n`);
  const javaFiles = {
    bin: { type: 'directory' },
    'bin/java': { type: 'file', executable: true, downloads: { raw: put('/v1/objects/java/java', javaScript) } },
    'lib/modules': { type: 'file', executable: false, downloads: { raw: put('/v1/objects/java/modules', crypto.randomBytes(3 * 1024 * 1024)) } },
  };
  const javaManifest = putAt('piston-meta.mojang.com', '/v1/packages/java/manifest.json', Buffer.from(JSON.stringify({ files: javaFiles })));
  const component = { availability: { group: 1, progress: 100 }, manifest: javaManifest, version: { name: '21.0.7', released: '2025-01-01' } };
  const all = { linux: { 'java-runtime-delta': [component], 'jre-legacy': [component] }, 'windows-x64': { 'java-runtime-delta': [component] }, 'mac-os': { 'java-runtime-delta': [component] } };
  files.set('/launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json', Buffer.from(JSON.stringify(all)));

  const versionJson = (id) => ({
    id,
    type: 'release',
    releaseTime: '2025-01-01T00:00:00+00:00',
    mainClass: 'FakeClient',
    assets: '17',
    assetIndex: { id: '17', ...indexRef, totalSize: assets * assetSize },
    javaVersion: { component: 'java-runtime-delta', majorVersion: 21 },
    downloads: { client, server },
    libraries: [{ name: 'org.example:fake-lib:1.0', downloads: { artifact: { path: 'org/example/fake-lib/1.0/fake-lib-1.0.jar', ...libRef } } }],
    arguments: {
      game: [
        '--username', '${auth_player_name}', '--accessToken', '${auth_access_token}', '--gameDir', '${game_directory}',
        { rules: [{ action: 'allow', features: { is_quick_play_multiplayer: true } }], value: ['--quickPlayMultiplayer', '${quickPlayMultiplayer}'] },
        { rules: [{ action: 'allow', features: { is_quick_play_singleplayer: true } }], value: ['--quickPlaySingleplayer', '${quickPlaySingleplayer}'] },
      ],
      jvm: ['-cp', '${classpath}'],
    },
  });
  // Старые версии: описание — настоящее (библиотеки, правила ОС, нативные классификаторы, аргументы,
  // индекс ресурсов, Java), содержимое файлов — поддельное, хеши пересчитаны под него.
  function addOldVersions(list) {
    const AdmZip = require('adm-zip');
    const zipOf = (entries) => {
      const z = new AdmZip();
      for (const [n, v] of Object.entries(entries)) z.addFile(n, Buffer.from(v));
      return z.toBuffer();
    };
    const fake = (url, buf) => {
      const u = new URL(url);
      hosts.add(u.host);
      files.set(`/${u.host}${u.pathname}`, buf);
      return { sha1: sha1(buf), size: buf.length };
    };
    const dir = path.join(__dirname, 'fixtures', 'oldversions');
    for (const f of fs.readdirSync(dir).sort()) {
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      Object.assign(j.downloads.client, fake(j.downloads.client.url, oldGameProbe()));
      if (j.downloads.server) Object.assign(j.downloads.server, fake(j.downloads.server.url, fs.readFileSync(fx.serverJar)));
      for (const lib of j.libraries) {
        const a = lib.downloads?.artifact;
        if (a) Object.assign(a, fake(a.url, zipOf({ [lib.name.replace(/:/g, '_') + '.txt']: lib.name })));
        for (const [cls, c] of Object.entries(lib.downloads?.classifiers || {}))
          Object.assign(c, fake(c.url, zipOf({ 'META-INF/MANIFEST.MF': 'Manifest-Version: 1.0\n', [`native-${lib.name.split(':')[1]}-${cls}.bin`]: cls })));
      }
      if (j.logging?.client?.file) Object.assign(j.logging.client.file, fake(j.logging.client.file.url, Buffer.from('<Configuration/>')));
      const ai = j.assetIndex;
      const flags = ai.id === 'pre-1.6' ? { map_to_resources: true } : ai.id === 'legacy' ? { virtual: true } : {};
      const objects = {};
      for (const name of ['sound/step/grass1.ogg', 'lang/en_US.lang']) {
        const b = Buffer.from(`${ai.id}:${name}`);
        const h = sha1(b);
        files.set(`/resources.download.minecraft.net/${h.slice(0, 2)}/${h}`, b);
        objects[name] = { hash: h, size: b.length };
      }
      Object.assign(ai, fake(ai.url, Buffer.from(JSON.stringify({ ...flags, objects }))));
      const url = `https://piston-meta.mojang.com/v1/packages/old/${j.id}.json`;
      const ref = fake(url, Buffer.from(JSON.stringify(j)));
      list.push({ id: j.id, type: j.type, url, sha1: ref.sha1, time: j.time, releaseTime: j.releaseTime });
    }
  }

  const versions = [];
  for (const id of ['1.21.1', '1.21', '1.20.1']) {
    const ref = putAt('piston-meta.mojang.com', `/v1/packages/${id}.json`, Buffer.from(JSON.stringify(versionJson(id))));
    versions.push({ id, type: 'release', url: ref.url, sha1: ref.sha1, time: '2025-01-01T00:00:00Z', releaseTime: '2025-01-01T00:00:00Z' });
  }
  if (oldVersions) addOldVersions(versions);
  files.set('/piston-meta.mojang.com/mc/game/version_manifest_v2.json', Buffer.from(JSON.stringify({ latest: { release: '1.21.1' }, versions })));

  // Fabric Meta
  for (const id of ['1.21.1', '1.21', '1.20.1']) {
    files.set(`/meta.fabricmc.net/v2/versions/loader/${id}`, Buffer.from(JSON.stringify([{ loader: { version: '0.16.9', stable: true } }])));
    files.set(`/meta.fabricmc.net/v2/versions/loader/${id}/0.16.9/profile/json`, Buffer.from(JSON.stringify({ id: `fabric-loader-0.16.9-${id}`, inheritsFrom: id, mainClass: 'FakeClient', libraries: [], arguments: { game: [], jvm: [] } })));
    files.set(`/meta.fabricmc.net/v2/versions/loader/${id}/0.16.9/1.0.1/server/jar`, fs.readFileSync(fx.serverJar));
  }
  files.set('/meta.fabricmc.net/v2/versions/installer', Buffer.from(JSON.stringify([{ version: '1.0.1', stable: true }])));
  files.set('/meta.fabricmc.net/v2/versions/game', Buffer.from(JSON.stringify(['1.21.1', '1.21', '1.20.1'].map((version) => ({ version, stable: true })))));

  // Quilt Meta (формат как у Fabric; сервер — профиль с главным классом)
  for (const id of ['1.21.1', '1.21', '1.20.1']) {
    files.set(`/meta.quiltmc.org/v3/versions/loader/${id}`, Buffer.from(JSON.stringify([{ loader: { version: '0.27.1' } }, { loader: { version: '0.28.0-beta.1' } }])));
    files.set(`/meta.quiltmc.org/v3/versions/loader/${id}/0.27.1/profile/json`, Buffer.from(JSON.stringify({ id: `quilt-loader-0.27.1-${id}`, inheritsFrom: id, mainClass: 'FakeClient', libraries: [], arguments: { game: [], jvm: [] } })));
    files.set(`/meta.quiltmc.org/v3/versions/loader/${id}/0.27.1/server/json`, Buffer.from(JSON.stringify({ mainClass: 'FakeServer', libraries: [] })));
  }
  files.set('/meta.quiltmc.org/v3/versions/game', Buffer.from(JSON.stringify(['1.21.1', '1.21', '1.20.1'].map((version) => ({ version, stable: true })))));

  // Forge и NeoForge: Maven-метаданные, рекомендованные версии, установщики с .sha1
  const metaXml = (vs) => Buffer.from(`<?xml version="1.0"?><metadata><versioning><versions>${vs.map((v) => `<version>${v}</version>`).join('')}</versions></versioning></metadata>`);
  const forgeVs = ['1.20.1-47.3.0', '1.21.1-52.0.1', '1.21.1-52.0.2'];
  files.set('/maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml', metaXml(forgeVs));
  files.set('/files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json', Buffer.from(JSON.stringify({ promos: { '1.21.1-recommended': '52.0.1', '1.21.1-latest': '52.0.2' } })));
  for (const v of forgeVs) {
    const [mc, lv] = [v.split('-')[0], v.slice(v.indexOf('-') + 1)];
    // 1.20.1 — как старый установщик 2.0 без режима «без окна» для клиента
    const jar = fakeForgeInstaller({ loader: 'forge', mc, lv, version: `${mc}-forge-${lv}`, nocli: mc === '1.20.1' });
    const p = `/maven.minecraftforge.net/net/minecraftforge/forge/${v}/forge-${v}-installer.jar`;
    files.set(p, jar);
    files.set(p + '.sha1', Buffer.from(sha1(jar)));
  }
  const tool = fakeForgeTool();
  files.set('/maven.minecraftforge.net/net/minecraftforge/installer/maven-metadata.xml', Buffer.from('<metadata><versioning><release>2.2.15</release><versions><version>2.2.15</version></versions></versioning></metadata>'));
  files.set('/maven.minecraftforge.net/net/minecraftforge/installer/2.2.15/installer-2.2.15-fatjar.jar', tool);
  files.set('/maven.minecraftforge.net/net/minecraftforge/installer/2.2.15/installer-2.2.15-fatjar.jar.sha1', Buffer.from(sha1(tool)));
  const neoVs = ['21.0.5', '21.1.77', '21.1.80-beta'];
  files.set('/maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml', metaXml(neoVs));
  for (const lv of neoVs) {
    const mc = lv.startsWith('21.0') ? '1.21' : '1.21.1';
    const jar = fakeForgeInstaller({ loader: 'neoforge', mc, lv, version: `neoforge-${lv}` });
    const p = `/maven.neoforged.net/releases/net/neoforged/neoforge/${lv}/neoforge-${lv}-installer.jar`;
    files.set(p, jar);
    files.set(p + '.sha1', Buffer.from(sha1(jar)));
  }

  // новости лаунчера (формат v2): записи помечены как тестовые
  const news = [
    { id: 'n1', title: 'Minecraft: Java Edition 1.21.1 (тестовая запись)', version: '1.21.1', type: 'release', date: '2025-01-03T10:00:00Z', shortText: 'Test entry from the local Mojang mock.', contentPath: '1.21.1-test.json' },
    { id: 'n2', title: 'Minecraft Snapshot 25w01a (тестовая запись)', version: '25w01a', type: 'snapshot', date: '2025-01-02T10:00:00Z', shortText: 'Snapshot test entry.', contentPath: '25w01a-test.json' },
    { id: 'n3', title: 'Minecraft: Java Edition 1.21 (тестовая запись)', version: '1.21', type: 'release', date: '2024-06-13T10:00:00Z', shortText: 'Older test entry.', contentPath: '1.21-test.json' },
  ];
  files.set('/launchercontent.mojang.com/v2/javaPatchNotes.json', Buffer.from(JSON.stringify({ version: 1, entries: news })));
  for (const e of news) files.set(`/launchercontent.mojang.com/v2/${e.contentPath}`, Buffer.from(JSON.stringify({ body: `<h1>${e.title}</h1><p>This text comes from the local test mock, not from Mojang.</p><h2>Changes</h2><ul><li>First test change</li><li>Second test change<script>alert(1)</script></li></ul><img src=x onerror=alert(1)>` })));

  const requests = [];
  const srv = http.createServer(async (req, res) => {
    const p = decodeURIComponent(req.url.split('?')[0]);
    requests.push(p);
    const buf = files.get(p);
    if (!buf) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { 'content-length': buf.length, 'content-type': p.endsWith('.json') ? 'application/json' : 'application/octet-stream' });
    // отдаём частями с задержкой: прогресс в интерфейсе виден, как при настоящей загрузке
    for (let i = 0; i < buf.length; i += 64 * 1024) {
      if (!res.write(buf.subarray(i, i + 64 * 1024))) await new Promise((r) => res.once('drain', r));
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    }
    res.end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.address().port}`;
  /** Адрес настоящего сервиса → адрес имитации; остальные адреса не меняются. */
  const rewrite = (url) => {
    const u = new URL(url);
    return hosts.has(u.host) ? `${base}/${u.host}${u.pathname}` : url;
  };
  return { base, rewrite, requests, close: () => srv.close() };
}

module.exports = { createFakeMojang };
