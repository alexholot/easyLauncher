'use strict';
// Общие помощники тестов: сборка поддельных сервера/клиента и Launcher без сети Mojang.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

let built = null;
function buildFixtures() {
  if (built) return built;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-fx-'));
  const src = path.join(__dirname, 'fixtures');
  try {
    execFileSync('javac', ['--release', '11', '-d', dir, path.join(src, 'FakeServer.java'), path.join(src, 'FakeClient.java'), path.join(src, 'FakeForgeInstaller.java'), path.join(src, 'tool', 'SimpleInstaller.java')], { stdio: 'ignore' });
    fs.writeFileSync(path.join(dir, 'server.mf'), 'Main-Class: FakeServer\n');
    execFileSync('jar', ['cfm', path.join(dir, 'fake-server.jar'), path.join(dir, 'server.mf'), '-C', dir, 'FakeServer.class'], { stdio: 'ignore' });
    execFileSync('jar', ['cf', path.join(dir, 'fake-client.jar'), '-C', dir, 'FakeClient.class'], { stdio: 'ignore' });
  } catch {
    built = { ok: false };
    return built;
  }
  built = { ok: true, dir, serverJar: path.join(dir, 'fake-server.jar'), clientJar: path.join(dir, 'fake-client.jar'), installerClass: path.join(dir, 'net', 'minecraftforge', 'installer', 'FakeForgeInstaller.class'), toolClass: path.join(dir, 'net', 'minecraftforge', 'installer', 'SimpleInstaller.class') };
  return built;
}

// «Java от Mojang» в имитации — sh-сценарий bin/java; на Windows лаунчер ищет bin\java.exe, такой рантайм не запустить
const NO_FAKE_JAVA = process.platform === 'win32' ? 'на Windows имитация Java от Mojang (sh-сценарий) не запускается' : null;

const fakeVersion = {
  id: '1.21.1',
  mainClass: 'FakeClient',
  arguments: {
    game: [
      '--username',
      '${auth_player_name}',
      '--accessToken',
      '${auth_access_token}',
      { rules: [{ action: 'allow', features: { is_quick_play_multiplayer: true } }], value: ['--quickPlayMultiplayer', '${quickPlayMultiplayer}'] },
      { rules: [{ action: 'allow', features: { is_quick_play_singleplayer: true } }], value: ['--quickPlaySingleplayer', '${quickPlaySingleplayer}'] },
    ],
    jvm: ['-cp', '${classpath}'],
  },
};

/** Launcher, у которого подготовка файлов Mojang заменена поддельными JAR. */
function testLauncher(Launcher, root, opts = {}) {
  const fx = buildFixtures();
  const l = new Launcher(root, opts);
  l.prepareRuntime = async () => ({
    version: fakeVersion,
    base: fakeVersion,
    java: { java: 'java', javaw: 'java' },
    client: { classpath: [fx.clientJar], nativesDir: path.join(root, 'natives'), logging: null },
    assets: { index: '17' },
    loaderVersion: null,
  });
  l.coopSupport = async () => ({ ok: true });
  l.mojang.installServerJar = async (_v, dest) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(fx.serverJar, dest);
  };
  return l;
}

function waitEvent(emitter, pred, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      emitter.off('event', on);
      reject(new Error('timeout waiting for event'));
    }, timeout);
    const on = (ev) => {
      if (pred(ev)) {
        clearTimeout(t);
        emitter.off('event', on);
        resolve(ev);
      }
    };
    emitter.on('event', on);
  });
}

/** Поддельный установщик Forge/NeoForge 2.x: JAR с install_profile.json, как у настоящего. */
function fakeForgeInstaller({ loader, mc, lv, version, nocli = false }) {
  const AdmZip = require('adm-zip');
  const fx = buildFixtures();
  const z = new AdmZip();
  z.addFile('META-INF/MANIFEST.MF', Buffer.from('Manifest-Version: 1.0\r\nMain-Class: net.minecraftforge.installer.FakeForgeInstaller\r\n\r\n'));
  z.addFile('net/minecraftforge/installer/FakeForgeInstaller.class', fs.readFileSync(fx.installerClass));
  z.addFile('install_profile.json', Buffer.from(JSON.stringify({ spec: 1, profile: loader, version, minecraft: mc, loader, loaderVersion: lv, json: '/version.json', data: {}, processors: [], libraries: [], ...(nocli ? { nocli: true } : {}) })));
  return z.toBuffer();
}
/** Поддельный «свежий официальный установщик Forge» (fatjar) — без профиля версии внутри. */
function fakeForgeTool() {
  const AdmZip = require('adm-zip');
  const fx = buildFixtures();
  const z = new AdmZip();
  z.addFile('net/minecraftforge/installer/FakeForgeInstaller.class', fs.readFileSync(fx.installerClass));
  z.addFile('net/minecraftforge/installer/SimpleInstaller.class', fs.readFileSync(fx.toolClass));
  return z.toBuffer();
}

/**
 * «client.jar» для старых версий: классы с теми же главными классами, что в настоящих описаниях
 * Mojang (RubyDung, launchwrapper, client.main.Main). Печатают аргументы, папку нативных библиотек
 * и рабочую папку — тест сверяет, что лаунчер собрал запуск так, как его ждёт старая игра.
 */
let probe = null;
function oldGameProbe() {
  if (probe) return probe;
  const AdmZip = require('adm-zip');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-probe-'));
  const classes = ['com.mojang.rubydung.RubyDung', 'net.minecraft.launchwrapper.Launch', 'net.minecraft.client.main.Main'];
  const srcs = classes.map((cls) => {
    const pkg = cls.slice(0, cls.lastIndexOf('.'));
    const name = cls.slice(cls.lastIndexOf('.') + 1);
    const file = path.join(dir, name + '.java');
    fs.writeFileSync(
      file,
      `package ${pkg};
public class ${name} {
  public static void main(String[] a) {
    System.out.println("main:${cls}");
    for (String s : a) System.out.println("arg:" + s);
    System.out.println("cwd:" + System.getProperty("user.dir"));
    String lp = System.getProperty("java.library.path");
    System.out.println("libpath:" + lp);
    java.io.File[] n = new java.io.File(lp).listFiles();
    if (n != null) for (java.io.File f : n) System.out.println("native:" + f.getName());
  }
}
`,
    );
    return file;
  });
  execFileSync('javac', ['--release', '8', '-nowarn', '-d', dir, ...srcs], { stdio: 'ignore' });
  const z = new AdmZip();
  for (const cls of classes) z.addFile(cls.replace(/\./g, '/') + '.class', fs.readFileSync(path.join(dir, cls.replace(/\./g, '/') + '.class')));
  probe = z.toBuffer();
  return probe;
}

module.exports = { NO_FAKE_JAVA, oldGameProbe, fakeForgeTool, fakeForgeInstaller, buildFixtures, testLauncher, waitEvent, fakeVersion };
