'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { rulesAllow, mavenPath, mergeVersion, offlineUuid, buildClientArgs, Mojang } = require('../core/mojang');
const { download } = require('../core/http');
const { LocalServer, parseProperties } = require('../core/server');
const { applyOptions } = require('../core/launcher');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'easy-'));

test('правила библиотек: ОС, архитектура, features', () => {
  assert.equal(rulesAllow(undefined), true);
  const macOnly = [{ action: 'allow', os: { name: 'osx' } }];
  assert.equal(rulesAllow(macOnly, {}, { os: 'osx' }), true);
  assert.equal(rulesAllow(macOnly, {}, { os: 'windows' }), false);
  const notMac = [{ action: 'allow' }, { action: 'disallow', os: { name: 'osx' } }];
  assert.equal(rulesAllow(notMac, {}, { os: 'linux' }), true);
  assert.equal(rulesAllow(notMac, {}, { os: 'osx' }), false);
  const x86 = [{ action: 'allow', os: { arch: 'x86' } }];
  assert.equal(rulesAllow(x86, {}, { os: 'windows', arch: 'ia32' }), true);
  assert.equal(rulesAllow(x86, {}, { os: 'windows', arch: 'x64' }), false);
  const qp = [{ action: 'allow', features: { is_quick_play_multiplayer: true } }];
  assert.equal(rulesAllow(qp, { is_quick_play_multiplayer: true }), true);
  assert.equal(rulesAllow(qp, {}), false);
});

test('maven-путь и офлайн-UUID', () => {
  assert.equal(mavenPath('net.fabricmc:fabric-loader:0.16.9'), 'net/fabricmc/fabric-loader/0.16.9/fabric-loader-0.16.9.jar');
  assert.equal(
    mavenPath('org.lwjgl:lwjgl:3.3.3:natives-windows'),
    'org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-windows.jar',
  );
  // Совпадает с UUID, который выдаёт сервер в offline-mode
  assert.equal(offlineUuid('Notch'), 'b50ad385829d3141a2167e7d7539ba7f');
});

const vanilla = {
  id: '1.21.1',
  mainClass: 'net.minecraft.client.main.Main',
  assetIndex: { id: '17' },
  downloads: { client: { url: 'https://x/client.jar', sha1: 'a', size: 1 } },
  javaVersion: { component: 'java-runtime-delta', majorVersion: 21 },
  libraries: [
    { name: 'org.ow2.asm:asm:9.3', downloads: { artifact: { path: 'org/ow2/asm/asm/9.3/asm-9.3.jar', url: 'https://l/asm93', sha1: 'b', size: 2 } } },
    {
      name: 'org.lwjgl:lwjgl:3.3.3:natives-macos',
      downloads: { artifact: { path: 'p/mac.jar', url: 'https://l/mac', sha1: 'c', size: 3 } },
      rules: [{ action: 'allow', os: { name: 'osx' } }],
    },
  ],
  arguments: {
    game: [
      '--username', '${auth_player_name}', '--uuid', '${auth_uuid}', '--gameDir', '${game_directory}',
      { rules: [{ action: 'allow', features: { is_demo_user: true } }], value: '--demo' },
      { rules: [{ action: 'allow', features: { is_quick_play_multiplayer: true } }], value: ['--quickPlayMultiplayer', '${quickPlayMultiplayer}'] },
    ],
    jvm: ['-Djava.library.path=${natives_directory}', '-cp', '${classpath}'],
  },
};
const fabricProfile = {
  id: 'fabric-loader-0.16.9-1.21.1',
  inheritsFrom: '1.21.1',
  mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient',
  libraries: [
    { name: 'org.ow2.asm:asm:9.7.1', url: 'https://maven.fabricmc.net/', sha1: 'd', size: 4 },
    { name: 'net.fabricmc:fabric-loader:0.16.9', url: 'https://maven.fabricmc.net/' },
  ],
  arguments: { game: [], jvm: ['-DFabricMcEmu= net.minecraft.client.main.Main '] },
};

test('склейка Fabric с Minecraft и план библиотек', () => {
  const merged = mergeVersion(fabricProfile, vanilla);
  assert.equal(merged.mainClass, fabricProfile.mainClass);
  assert.equal(merged.jar, '1.21.1');
  assert.equal(merged.assetIndex.id, '17');
  const m = new Mojang('/root/shared');
  const plan = m.libraryPlan(merged, { os: 'linux' });
  const names = plan.classpath.map((p) => path.basename(p));
  // ASM от Fabric (новее) вытесняет ванильный, macOS-натив отфильтрован
  assert.deepEqual(names, ['asm-9.7.1.jar', 'fabric-loader-0.16.9.jar']);
  assert.equal(plan.tasks[0].url, 'https://maven.fabricmc.net/org/ow2/asm/asm/9.7.1/asm-9.7.1.jar');
  assert.equal(m.clientJar(merged), path.join('/root/shared', 'versions', '1.21.1', '1.21.1.jar'));
});

test('аргументы клиента: офлайн-профиль и быстрый вход на сервер', () => {
  const args = buildClientArgs(
    mergeVersion(fabricProfile, vanilla),
    {
      gameDir: '/g', assetsDir: '/a', assetIndex: '17', classpath: ['/l/a.jar', '/l/b.jar'], nativesDir: '/n',
      librariesDir: '/l', username: 'Steve', ram: 4, server: '127.0.0.1:25565',
    },
    { os: 'linux' },
  );
  assert.ok(args.includes('-Xmx4G'));
  assert.equal(args[args.indexOf('-cp') + 1], '/l/a.jar:/l/b.jar');
  assert.ok(args.includes('-DFabricMcEmu= net.minecraft.client.main.Main '));
  const main = args.indexOf(fabricProfile.mainClass);
  assert.ok(main > args.indexOf('-cp'), 'mainClass после JVM-аргументов');
  assert.equal(args[args.indexOf('--username') + 1], 'Steve');
  assert.equal(args[args.indexOf('--uuid') + 1], offlineUuid('Steve'));
  assert.equal(args[args.indexOf('--quickPlayMultiplayer') + 1], '127.0.0.1:25565');
  assert.ok(!args.includes('--demo'));
  assert.ok(!args.some((a) => a.includes('${')), 'все переменные подставлены');
});

test('аргументы старых версий: minecraftArguments и --server', () => {
  const legacy = { id: '1.12.2', mainClass: 'M', minecraftArguments: '--username ${auth_player_name} --version ${version_name}' };
  const args = buildClientArgs(
    legacy,
    { gameDir: '/g', assetsDir: '/a', assetIndex: '1.12', classpath: ['/x.jar'], nativesDir: '/n', librariesDir: '/l', username: 'Alex', ram: 2, server: 'host:25570' },
    { os: 'windows' },
  );
  assert.equal(args[args.indexOf('-cp') + 1], '/x.jar');
  assert.deepEqual(args.slice(-4), ['--server', 'host', '--port', '25570']);
  assert.ok(args.includes('-Djava.library.path=/n'));
});

function serve(files) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const body = files[req.url];
      if (!body) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200).end(body);
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

test('загрузка с проверкой хеша', async () => {
  const body = Buffer.from('hello minecraft');
  const srv = await serve({ '/f': body });
  const url = `http://127.0.0.1:${srv.address().port}/f`;
  const dir = tmp();
  const sha512 = crypto.createHash('sha512').update(body).digest('hex');
  assert.equal(await download(url, path.join(dir, 'a'), { sha512 }), body.length);
  assert.equal(await download(url, path.join(dir, 'a'), { sha512 }), 0, 'повторно не скачивается');
  await assert.rejects(download(url, path.join(dir, 'b'), { sha1: '0'.repeat(40) }), /хеш/);
  assert.ok(!fs.existsSync(path.join(dir, 'b')), 'битый файл не остаётся на диске');
  srv.close();
});

test('кэш модов: чужие JAR не трогаются, источник и имя файла проверяются', async () => {
  const { ModCache } = require('../core/modcache');
  const dir = tmp();
  const cache = new ModCache(tmp());
  fs.writeFileSync(path.join(dir, 'my-own.jar'), 'x');
  fs.writeFileSync(path.join(dir, 'old.jar'), 'x');
  fs.writeFileSync(path.join(dir, '.easylauncher-managed.json'), JSON.stringify({ files: ['old.jar'] }));
  await cache.materialize(dir, []);
  assert.ok(fs.existsSync(path.join(dir, 'my-own.jar')), 'мод, добавленный вручную, остаётся');
  assert.ok(!fs.existsSync(path.join(dir, 'old.jar')));
  const sha1 = 'a'.repeat(40);
  await assert.rejects(cache.ensure({ name: 'Evil', file: { filename: 'e.jar', url: 'https://evil.example/e.jar', hashes: { sha1 } } }), /разрешённых/);
  await assert.rejects(cache.materialize(dir, [{ name: 'Path', file: { filename: '../../x.txt', hashes: { sha1 } } }]), /Недопустимое/);
  await assert.rejects(cache.ensure({ name: 'NoHash', file: { filename: 'n.jar', url: 'https://cdn.modrinth.com/x', hashes: {} } }), /SHA-1/);
});

test('options.txt: профиль применяется, ручные настройки сохраняются', async () => {
  const dir = tmp();
  await applyOptions(dir, { render: 8, simulation: 4, fps: 120, graphics: 0 });
  let t = fs.readFileSync(path.join(dir, 'options.txt'), 'utf8');
  assert.match(t, /renderDistance:8/);
  assert.match(t, /lang:ru_ru/);
  fs.writeFileSync(path.join(dir, 'options.txt'), t.replace('renderDistance:8', 'renderDistance:16') + 'fov:0.5\n');
  await applyOptions(dir, { render: 8, simulation: 4, fps: 120, graphics: 0 });
  t = fs.readFileSync(path.join(dir, 'options.txt'), 'utf8');
  assert.match(t, /renderDistance:16/, 'тот же профиль не перезаписывает ручную настройку');
  await applyOptions(dir, { render: 12, simulation: 6, fps: 120, graphics: 1 });
  t = fs.readFileSync(path.join(dir, 'options.txt'), 'utf8');
  assert.match(t, /renderDistance:12/);
  assert.match(t, /fov:0\.5/);
});

test('локальный сервер: EULA, свойства, «Done», игроки, штатная остановка', async (t) => {
  const dir = tmp();
  const src = path.join(dir, 'Fake.java');
  // Имитация сервера Minecraft: печатает «Done», принимает stop
  fs.writeFileSync(
    src,
    `import java.io.*;
public class Fake { public static void main(String[] a) throws Exception {
  System.out.println("[12:00:00] [Server thread/INFO]: Done (1.234s)! For help, type \\"help\\"");
  System.out.println("[12:00:01] [Server thread/INFO]: Steve joined the game");
  BufferedReader r = new BufferedReader(new InputStreamReader(System.in));
  String l; while ((l = r.readLine()) != null) {
    if (l.equals("stop")) { System.out.println("[Server thread/INFO]: Saving worlds"); System.exit(0); }
    System.out.println("[Server thread/INFO]: cmd " + l);
  } } }`,
  );
  try {
    execFileSync('javac', ['-d', dir, src], { stdio: 'ignore' });
    fs.writeFileSync(path.join(dir, 'MANIFEST.MF'), 'Main-Class: Fake\n');
    execFileSync('jar', ['cfm', path.join(dir, 'fake.jar'), path.join(dir, 'MANIFEST.MF'), '-C', dir, 'Fake.class']);
  } catch {
    t.skip('нет JDK');
    return;
  }
  const server = new LocalServer();
  const states = [];
  server.on('state', (s) => states.push(s.state));
  const serverDir = path.join(dir, 'server');
  await assert.rejects(server.start({ dir: serverDir, java: 'java', jar: 'x', ram: 1, eula: false }), /EULA/);
  const port = await server.start({
    dir: serverDir, java: 'java', jar: path.join(dir, 'fake.jar'), ram: 1, eula: true,
    properties: { 'online-mode': false, motd: 'Тест' },
  });
  assert.ok(port >= 25565);
  assert.match(fs.readFileSync(path.join(serverDir, 'eula.txt'), 'utf8'), /eula=true/);
  const props = parseProperties(fs.readFileSync(path.join(serverDir, 'server.properties'), 'utf8'));
  assert.equal(props.get('online-mode'), 'false');
  assert.equal(props.get('server-port'), String(port));
  assert.equal(props.get('enable-rcon'), 'false');
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual([...server.players], ['Steve']);
  server.command('say hi');
  await server.stop();
  assert.equal(server.state, 'stopped');
  assert.ok(server.lines.some((l) => l.includes('cmd say hi')));
  assert.ok(server.lines.some((l) => l.includes('Saving worlds')), 'сервер получил stop');
  assert.deepEqual(states.slice(0, 2), ['starting', 'running']);
});

test('занятый файл: повтор, затем понятная ошибка', async () => {
  const { retryFs } = require('../core/http');
  let n = 0;
  const ok = await retryFs(async () => {
    if (++n < 3) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    return 'done';
  });
  assert.equal(ok, 'done');
  assert.equal(n, 3);
  await assert.rejects(
    retryFs(async () => {
      throw Object.assign(new Error('x'), { code: 'ENOENT' });
    }),
    /x/,
  );
});

test('NBT: level.dat читается (gzip, вложенные теги, кириллица)', () => {
  const nbt = require('../core/nbt');
  const buf = nbt.write({ Data: { LevelName: 'Тихая долина', LastPlayed: BigInt(1760000000000), GameType: 1, hardcore: true, Version: { Name: '1.21.1', Id: 3955 }, WorldGenSettings: { seed: BigInt(42) } } });
  const lvl = nbt.readLevel(buf);
  assert.equal(lvl.name, 'Тихая долина');
  assert.equal(lvl.gamemode, 'creative');
  assert.equal(lvl.hardcore, true);
  assert.equal(lvl.version, '1.21.1');
  assert.equal(lvl.seed, 42);
  assert.equal(lvl.lastPlayed, new Date(1760000000000).toISOString());
  assert.throws(() => nbt.readLevel(Buffer.from('not nbt')));
});

test('журнал клиента: мир и скриншоты связываются только внутри одиночной сессии', () => {
  const { SessionTracker } = require('../core/sessionlog');
  const t = new SessionTracker();
  const ends = [];
  t.on('singleplayer-end', (e) => ends.push(e));
  t.feed('[Render thread/INFO]: [System] [CHAT] Saved screenshot as menu.png');
  t.feed('[Server thread/INFO]: Starting integrated minecraft server version 1.21.1');
  assert.equal(t.playingLevel(), null, 'имя мира ещё неизвестно');
  t.feed('[Render thread/INFO]: [System] [CHAT] Saved screenshot as 2026-10-26_12.00.00.png');
  t.feed("[Server thread/INFO]: Saving chunks for level 'ServerLevel[Мой мир]'/minecraft:overworld");
  assert.equal(t.playingLevel(), 'Мой мир');
  t.feed('[Server thread/INFO]: Stopping server');
  t.feed('[Render thread/INFO]: Connecting to example.org, 25565');
  t.feed('[Render thread/INFO]: [System] [CHAT] Saved screenshot as mp.png');
  t.end();
  assert.deepEqual(ends, [{ level: 'Мой мир', shots: ['2026-10-26_12.00.00.png'] }]);
  assert.deepEqual(t.looseShots, ['menu.png', 'mp.png'], 'скриншоты вне одиночного мира — только «скриншоты сборки»');
});

test('перенос миров прежней схемы в saves их сборки', async () => {
  const { Store, writeJson } = require('../core/store');
  const { Worlds } = require('../core/worlds');
  const nbt = require('../core/nbt');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-mig-'));
  const store = new Store(root);
  const p = await store.createProfile({ minecraft: '1.21.1' });
  const src = path.join(root, 'worlds', 'w-1', 'world');
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, 'level.dat'), nbt.write({ Data: { LevelName: 'Старый мир', GameType: 0 } }));
  await writeJson(path.join(root, 'worlds', 'w-1', 'meta.json'), { id: 'w-1', name: 'Старый мир', profileId: p.id });
  fs.mkdirSync(path.join(root, 'worlds', 'w-2'), { recursive: true });
  await writeJson(path.join(root, 'worlds', 'w-2', 'meta.json'), { id: 'w-2', name: 'Чужой', profileId: 'p-missing' });
  const w = new Worlds(store);
  const moved = await w.migrateLegacy();
  assert.deepEqual(moved.map((m) => m.folder), ['Старый мир']);
  assert.equal((await w.list(p.id))[0].name, 'Старый мир');
  assert.ok(!fs.existsSync(path.join(root, 'worlds', 'w-1')));
  assert.ok(fs.existsSync(path.join(root, 'worlds', 'w-2')), 'мир без сборки не трогается');
  // в мире идёт игра — копию не делаем; неверное имя при удалении — отказ
  await assert.rejects(w.backup(p.id, 'Старый мир', { playingFolder: 'Старый мир' }), (e) => e.code === 'WORLD_IN_USE');
  await assert.rejects(w.remove(p.id, 'Старый мир', 'не то'), /точное название/);
  await w.remove(p.id, 'Старый мир', 'Старый мир');
  assert.equal((await w.list(p.id)).length, 0);
  assert.equal((await w.backups(p.id, 'Старый мир'))[0].reason, 'before-delete');
  assert.throws(() => w.dir(p.id, '../x'), /Некорректная/);
});
