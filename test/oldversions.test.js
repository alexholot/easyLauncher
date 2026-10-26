'use strict';
// Старые версии Minecraft через настоящий конвейер установки и запуска. Описания версий — настоящие
// файлы Mojang (test/fixtures/oldversions, из архива github.com/skyrising/mc-versions): библиотеки,
// правила ОС, нативные классификаторы LWJGL 2, аргументы запуска, индексы ресурсов pre-1.6/legacy, Java 8.
// Содержимое файлов поддельное, вместо игры — проба с тем же главным классом.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('../core/http');
const { Launcher } = require('../core/launcher');
const { Mojang, buildClientArgs } = require('../core/mojang');
const { createFakeMojang } = require('./fakemojang');
const { buildFixtures, waitEvent } = require('./helpers');

const DIR = path.join(__dirname, 'fixtures', 'oldversions');
const real = (id) => JSON.parse(fs.readFileSync(path.join(DIR, id + '.json'), 'utf8'));

test('настоящие описания старых версий: библиотеки и нативные файлы для Windows, Linux и macOS', () => {
  const m = new Mojang('/x');
  for (const f of fs.readdirSync(DIR)) {
    const v = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
    for (const osn of ['windows', 'linux', 'osx']) {
      const plan = m.libraryPlan(v, { os: osn, arch: 'x64', release: '10.0' });
      const names = plan.classpath.map((p) => path.basename(p));
      assert.equal(new Set(names.map((n) => n.replace(/-[\d.]+(-nightly[^.]*)?(-SNAPSHOT)?\.jar$/, ''))).size, names.length, `${v.id}/${osn}: без двух версий одной библиотеки`);
      if (/^(rd|a|b|inf|c)|^1\.([2-9]|1[0-2])(\.|$)/.test(v.id)) {
        assert.ok(names.some((n) => n.startsWith('lwjgl-2.')), `${v.id}/${osn}: LWJGL 2 в classpath`);
        assert.ok(plan.natives.some((n) => n.file.includes('lwjgl-platform')), `${v.id}/${osn}: нативные файлы LWJGL`);
        const key = { windows: 'natives-windows', linux: 'natives-linux', osx: 'natives-osx' }[osn];
        assert.ok(plan.natives.every((n) => path.basename(n.file).includes(key)), `${v.id}/${osn}: только нативные файлы этой ОС`);
      }
    }
  }
});

test('аргументы запуска старых версий: ник, папки, ресурсы и Java-библиотеки на своих местах', () => {
  const opts = { gameDir: '/g', assetsDir: '/a', assetIndex: 'pre-1.6', classpath: ['/c.jar'], nativesDir: '/n', librariesDir: '/l', username: 'Steve', ram: 2 };
  const rd = buildClientArgs(real('rd-132211'), opts, { os: 'windows' });
  assert.deepEqual(rd.slice(rd.indexOf('com.mojang.rubydung.RubyDung')), ['com.mojang.rubydung.RubyDung', 'Steve', '0']);
  assert.ok(rd.includes('-Djava.library.path=/n') && rd.includes('/c.jar'));
  const b = buildClientArgs(real('b1.7.3'), { ...opts, gameAssets: '/g/resources' }, { os: 'windows' });
  assert.deepEqual(b.slice(b.indexOf('net.minecraft.launchwrapper.Launch')), ['net.minecraft.launchwrapper.Launch', 'Steve', '0', '--gameDir', '/g', '--assetsDir', '/g/resources']);
  const inf = buildClientArgs(real('inf-20100618'), opts, { os: 'linux' });
  assert.deepEqual(inf.slice(-2), ['--tweakClass', 'net.minecraft.launchwrapper.AlphaVanillaTweaker']);
  const n = buildClientArgs(real('1.13.2'), { ...opts, assetIndex: '1.13.1' }, { os: 'windows' });
  assert.ok(n.includes('-Djava.library.path=/n') && n.includes('--assetIndex') && !n.some((x) => x.includes('${')), 'новый формат arguments — без неподставленных переменных');
  for (const id of ['1.2.5', '1.5.2', '1.6.4', '1.7.10', '1.8.9', '1.12.2', '1.16.5']) {
    const args = buildClientArgs(real(id), opts, { os: 'windows' });
    assert.ok(!args.some((x) => x.includes('${')), id + ': все переменные подставлены');
  }
});

test('старые версии от rd-132211 до 1.16.5 скачиваются и запускаются (Java 8, LWJGL 2, ресурсы pre-1.6 и legacy)', async (t) => {
  if (!buildFixtures().ok) return t.skip('нет JDK');
  const fm = await createFakeMojang({ delayMs: 0, assets: 2, assetSize: 64, oldVersions: true });
  http.setFetch((url, o) => fetch(fm.rewrite(url), o));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-old-'));
  const l = new Launcher(root, { totalMem: 16 * 1024 ** 3 });
  try {
    const all = await l.mojang.allVersions();
    for (const type of ['old_alpha', 'old_beta']) assert.ok(all.some((v) => v.type === type), 'в списке есть ' + type);
    for (const id of ['rd-132211', 'inf-20100618', 'a1.2.6', 'b1.7.3', '1.2.5', '1.5.2', '1.6.4', '1.7.10', '1.8.9', '1.12.2', '1.13.2', '1.16.5']) {
      const v = real(id);
      const p = await l.store.createProfile({ name: id, minecraft: id, loader: 'vanilla' });
      const stopped = waitEvent(l, (e) => e.type === 'client' && e.state === 'stopped', 60000);
      await l.play({ profileId: p.id, nickname: 'Steve', ram: 1 });
      assert.equal((await stopped).code, 0, id + ': игра запустилась');
      const lines = l.clientLines;
      const args = lines.filter((x) => x.startsWith('arg:')).map((x) => x.slice(4));
      assert.ok(lines.includes('main:' + v.mainClass), id + ': главный класс ' + v.mainClass);
      assert.ok(args.includes('Steve'), id + ': ник передан');
      const gameDir = lines.find((x) => x.startsWith('cwd:')).slice(4);
      assert.ok(fs.existsSync(gameDir) && gameDir.startsWith(root), id + ': игра работает в папке сборки');
      assert.ok(lines.some((x) => x.startsWith('native:native-lwjgl-platform-natives-linux') || x.startsWith('native:native-lwjgl-') ), id + ': нативные файлы LWJGL распакованы');
      assert.ok(!lines.some((x) => x.startsWith('native:MANIFEST')), id + ': META-INF не распаковывается');
      if (v.assets === 'pre-1.6') {
        assert.ok(fs.existsSync(path.join(gameDir, 'resources', 'sound', 'step', 'grass1.ogg')), id + ': ресурсы pre-1.6 лежат в resources');
        if (args.includes('--assetsDir')) assert.equal(args[args.indexOf('--assetsDir') + 1], path.join(gameDir, 'resources'));
      }
      if (v.assets === 'legacy') {
        const dir = args[args.indexOf('--assetsDir') + 1];
        assert.equal(dir, path.join(root, 'shared', 'assets', 'virtual', 'legacy'));
        assert.ok(fs.existsSync(path.join(dir, 'lang', 'en_US.lang')), id + ': ресурсы legacy разложены по именам');
      }
    }
    assert.ok(fm.requests.some((r) => r.includes('/v1/products/java-runtime/')), 'Java берётся из набора Mojang');
  } finally {
    http.setFetch((...a) => globalThis.fetch(...a));
    fm.close();
    await l.shutdown();
  }
});

test('с друзьями: альфа, бета и версии до 1.7.2 — понятный отказ до скачивания сервера; 1.7.10 и новее — можно', async (t) => {
  if (!buildFixtures().ok) return t.skip('нет JDK');
  const fm = await createFakeMojang({ delayMs: 0, assets: 2, assetSize: 64, oldVersions: true });
  http.setFetch((url, o) => fetch(fm.rewrite(url), o));
  const l = new Launcher(fs.mkdtempSync(path.join(os.tmpdir(), 'easy-oldcoop-')), { totalMem: 16 * 1024 ** 3 });
  try {
    for (const id of ['rd-132211', 'a1.2.6', 'b1.7.3', '1.2.5', '1.6.4']) assert.equal((await l.coopSupport(id)).ok, false, id);
    for (const id of ['1.7.10', '1.12.2', '1.21.1']) assert.equal((await l.coopSupport(id)).ok, true, id);
    const p = await l.store.createProfile({ name: 'beta', minecraft: 'b1.7.3', loader: 'vanilla' });
    await assert.rejects(
      l.startSession({ profileId: p.id, auth: { name: 'Steve', uuid: 'x', accessToken: 't' }, eula: true }),
      (e) => e.code === 'COOP_UNSUPPORTED' && /1\.7\.2/.test(e.message),
    );
    assert.ok(!fm.requests.some((r) => r.includes('server')), 'серверный JAR не скачивался');
    // 1.12.2: сервер до 1.13 понимает режим и сложность только числами
    const q = await l.store.createProfile({ name: 'old', minecraft: '1.12.2', loader: 'vanilla' });
    await l.startSession({ profileId: q.id, auth: { name: 'Steve', uuid: 'x', accessToken: 't' }, eula: true, serverRam: 1, create: { name: 'Креатив', gamemode: 'creative', difficulty: 'hard' } });
    const props = fs.readFileSync(path.join(l.store.serverDir(q.id), 'server.properties'), 'utf8');
    assert.match(props, /^gamemode=1$/m);
    assert.match(props, /^difficulty=3$/m);
    await l.endSession();
  } finally {
    http.setFetch((...a) => globalThis.fetch(...a));
    fm.close();
    await l.shutdown();
  }
});
