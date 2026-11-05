'use strict';
// Локальный выделенный сервер Minecraft под управлением лаунчера.
const fs = require('fs');
const fsp = fs.promises;
const { UTF8_JVM, javaEnv } = require('./mojang');
const path = require('path');
const net = require('net');
const os = require('os');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

function parseProperties(text) {
  const out = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i > 0) out.set(line.slice(0, i), line.slice(i + 1));
  }
  return out;
}

function escapeProp(v) {
  // В .properties обратная косая черта и перевод строки должны быть экранированы
  return String(v).replace(/\\/g, '\\\\').replace(/\r?\n/g, ' ');
}

async function writeProperties(file, values) {
  let current = new Map();
  try {
    current = parseProperties(await fsp.readFile(file, 'utf8'));
  } catch {}
  for (const [k, v] of Object.entries(values)) current.set(k, escapeProp(v));
  const body = ['#Minecraft server properties (easyLauncher)', ...[...current].map(([k, v]) => `${k}=${v}`)].join('\n');
  await fsp.writeFile(file, body + '\n');
}

function portFree(port, host = '0.0.0.0') {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port, host);
  });
}

async function findPort(start = 25565) {
  for (let p = start; p < start + 20; p++) if (await portFree(p)) return p;
  const e = new Error(`Порты ${start}–${start + 19} заняты. Закрой другой сервер Minecraft или программу, использующую эти порты.`);
  e.code = 'PORT_BUSY';
  throw e;
}

/** IPv4-адреса компьютера в локальной сети. */
function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) out.push({ name, address: a.address });
    }
  }
  return out;
}

/** Причина падения сервера по его логу — для понятного сообщения и следующего действия. */
function classifyServerFailure(lines, code) {
  const text = lines.join('\n');
  const rules = [
    [/FAILED TO BIND TO PORT|Address already in use|BindException/i, 'PORT_BUSY', 'Порт сервера занят другой программой.', 'Закрой другой сервер Minecraft и попробуй снова.'],
    [/Could not reserve enough space|OutOfMemoryError|Cannot allocate memory|Invalid maximum heap size/i, 'NO_MEMORY', 'Серверу не хватило памяти.', 'Закрой лишние программы или уменьши память сервера в настройках.'],
    [/You need to agree to the EULA|Failed to load eula/i, 'EULA', 'Не принята Minecraft EULA.', 'Прими EULA в окне запуска.'],
    [/Incompatible mods? (set|found)|requires .* which is missing|Mod resolution failed|Incompatible mod set/i, 'MODS', 'Набор серверных модов несовместим.', 'Открой «Сборка» и проверь зависимости и версии модов.'],
    [/UnsupportedClassVersionError|has been compiled by a more recent version/i, 'JAVA', 'Неподходящая версия Java для сервера.', 'Лаунчер подберёт Java заново при следующем запуске.'],
    [/Failed to start the minecraft server|Encountered an unexpected exception/i, 'CRASH', 'Сервер завершился с ошибкой при старте.', 'Открой журнал сервера в разделе «Подробнее».'],
    [/level\.dat.*(corrupt|failed)|Failed to load level|Exception reading .*level\.dat/i, 'WORLD', 'Не удалось прочитать мир.', 'Восстанови мир из резервной копии в «Мои миры».'],
  ];
  for (const [re, kind, message, action] of rules) {
    const m = text.match(re);
    if (m) return { kind, message, action, evidence: m[0].slice(0, 200), code };
  }
  return { kind: 'EXIT', message: `Сервер завершился (код ${code}).`, action: 'Открой журнал сервера в разделе «Подробнее».', evidence: '', code };
}

class LocalServer extends EventEmitter {
  constructor() {
    super();
    this.proc = null;
    this.state = 'stopped';
    this.players = new Set();
    this.port = null;
    this.lines = [];
    this.worldId = null;
    this.worldKey = null; // «<сборка>/<папка мира>» — какой мир открыт сервером
    this.folder = null;
    this.profileId = null;
    this.stopRequested = false;
  }

  setState(state, extra = {}) {
    this.state = state;
    this.emit('state', {
      state,
      port: this.port,
      worldId: this.worldId,
      folder: this.folder,
      players: [...this.players],
      ...extra,
    });
  }

  /** Ожидание строки лога после текущего момента (например, «Saved the game»). */
  waitForLine(re, timeout = 30000) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.off('log', on);
        reject(new Error('Сервер не ответил вовремя.'));
      }, timeout);
      const on = (line) => {
        if (re.test(line)) {
          clearTimeout(t);
          this.off('log', on);
          resolve(line);
        }
      };
      this.on('log', on);
    });
  }

  /**
   * opts: {dir, java, jar, ram, eula, properties, programArgs, worldId, worldKey, folder, profileId, port}
   * Промис выполняется, когда сервер сам сообщил о готовности («Done»), а не по таймеру.
   */
  async start(opts) {
    if (this.proc) throw new Error('Сервер уже запущен.');
    if (opts.eula !== true) {
      const e = new Error('Для запуска сервера нужно принять Minecraft EULA.');
      e.code = 'EULA';
      throw e;
    }
    await fsp.mkdir(opts.dir, { recursive: true });
    // EULA записывается только после явного согласия пользователя (opts.eula === true)
    await fsp.writeFile(
      path.join(opts.dir, 'eula.txt'),
      `# Принято пользователем в easyLauncher ${new Date().toISOString()}\n# https://aka.ms/MinecraftEULA\neula=true\n`,
    );
    this.port = await findPort(opts.port || 25565);
    await writeProperties(path.join(opts.dir, 'server.properties'), {
      ...opts.properties,
      'server-port': this.port,
      'query.port': this.port,
      'enable-rcon': false,
      'enable-query': false,
    });
    this.players.clear();
    this.lines = [];
    this.worldId = opts.worldId || null;
    this.worldKey = opts.worldKey || opts.worldId || null;
    this.folder = opts.folder || null;
    this.profileId = opts.profileId || null;
    this.stopRequested = false;
    this.startedAt = null;
    this.ramGb = opts.ram;
    const args = [
      `-Xmx${opts.ram}G`,
      `-Xms${Math.min(opts.ram, 1)}G`,
      '-XX:+UseG1GC',
      ...UTF8_JVM,
      // обычный сервер — «-jar файл»; Forge/NeoForge/Quilt — свои аргументы (файл @args или classpath)
      ...(opts.launchArgs || ['-jar', opts.jar]),
      ...(opts.programArgs || []),
      'nogui',
    ];
    this.setState('starting');
    const proc = spawn(opts.java, args, { cwd: opts.dir, env: javaEnv(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.proc = proc;
    this.emit('spawn', proc.pid);
    return new Promise((resolve, reject) => {
      let ready = false;
      const onLine = (line) => {
        // служебные ответы сервера на опросы лаунчера (координаты для объёмного голоса) — не в журнал
        if (this.quiet && ready && this.quiet(line)) return;
        this.lines.push(line);
        if (this.lines.length > 2000) this.lines.splice(0, 500);
        this.emit('log', line);
        if (!ready && /\bDone \([\d.,]+s\)!/.test(line)) {
          ready = true;
          this.startedAt = Date.now();
          this.setState('running');
          resolve(this.port);
        }
        let m = line.match(/: ([A-Za-z0-9_]{3,16}) joined the game/);
        if (m) {
          this.players.add(m[1]);
          this.setState(this.state);
        }
        m = line.match(/: ([A-Za-z0-9_]{3,16}) left the game/);
        if (m) {
          this.players.delete(m[1]);
          this.setState(this.state);
        }
      };
      const reader = (stream) => {
        let buf = '';
        stream.setEncoding('utf8');
        stream.on('data', (chunk) => {
          buf += chunk;
          const parts = buf.split(/\r?\n/);
          buf = parts.pop();
          parts.forEach(onLine);
        });
      };
      reader(proc.stdout);
      reader(proc.stderr);
      proc.on('error', (e) => {
        this.proc = null;
        const failure = { kind: 'JAVA', message: 'Не удалось запустить Java для сервера: ' + e.message, action: 'Повтори запуск: лаунчер проверит Java.' };
        this.setState('stopped', { failure });
        if (!ready) reject(Object.assign(new Error(failure.message), { failure }));
      });
      proc.on('exit', (code) => {
        this.proc = null;
        this.players.clear();
        const expected = this.stopRequested && ready;
        const failure = expected ? null : classifyServerFailure(this.lines.slice(-300), code);
        const wid = this.worldId;
        const exited = { profileId: this.profileId, folder: this.folder };
        this.setState('stopped', { code, expected, failure, log: this.lines.slice(-200).join('\n') });
        this.emit('exit', { code, expected, worldId: wid, ...exited });
        if (!ready) {
          const e = new Error(failure ? failure.message + ' ' + failure.action : 'Сервер остановлен до готовности.');
          e.failure = failure;
          e.code = failure?.kind;
          reject(e);
        }
      });
    });
  }

  command(cmd) {
    if (!this.proc) throw new Error('Сервер не запущен.');
    const line = String(cmd).replace(/^\//, '').replace(/[\r\n]/g, ' ').trim();
    if (line) this.proc.stdin.write(line + '\n');
  }

  /** Штатная остановка: команда stop, мир сохраняется. Через timeout — принудительно. */
  stop(timeout = 60000) {
    const proc = this.proc;
    if (!proc) return Promise.resolve();
    this.stopRequested = true;
    this.setState('stopping');
    return new Promise((resolve) => {
      const t = setTimeout(() => proc.kill('SIGKILL'), timeout);
      proc.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
      try {
        proc.stdin.write('stop\n');
      } catch {
        proc.kill();
      }
    });
  }
}

module.exports = { LocalServer, lanAddresses, writeProperties, parseProperties, findPort, portFree, classifyServerFailure };
