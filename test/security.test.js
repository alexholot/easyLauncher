'use strict';
// Защита игры с друзьями (4.5.3): ник в игре = ник приглашения, ник хозяина и занятые ники недоступны,
// версия загрузчика из приглашения не меняет адрес установщика, поток мусора в голосе, чужие связи EOS.
const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const { PassThrough, Duplex } = require('stream');
const { parseLogin } = require('../core/net/mcguard');
const { routeStream, VoiceHub, VoiceClient } = require('../core/net/voice');
const { mcLogin } = require('./mclogin');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Пара связанных потоков, как у транспорта. */
function pair() {
  const ab = new PassThrough();
  const ba = new PassThrough();
  const mk = (rd, wr) => {
    const d = new Duplex({
      read() {},
      write(c, e, cb) {
        wr.write(c, cb);
      },
      final(cb) {
        wr.end();
        cb();
      },
      destroy(err, cb) {
        wr.end();
        cb(err);
      },
    });
    rd.on('data', (c) => d.push(c));
    rd.on('end', () => d.push(null));
    return d;
  };
  return [mk(ba, ab), mk(ab, ba)];
}

test('пакет входа Minecraft: ник, запрос статуса, обрезанное начало, мусор', () => {
  assert.deepStrictEqual(parseLogin(mcLogin('Friend1')), { name: 'Friend1' });
  assert.deepStrictEqual(parseLogin(mcLogin('', 1)), { status: true });
  assert.deepStrictEqual(parseLogin(Buffer.from([0xfe, 0x01])), { status: true }, 'старый пинг списка серверов');
  const full = mcLogin('Friend1');
  for (let i = 0; i < full.length - 1; i++) {
    const r = parseLogin(full.subarray(0, i));
    assert.ok(r.need || r.name === undefined, 'по частям — ждём остальное');
  }
  // похоже на длину пакета — ждём продолжения (поток закроется по времени и до сервера ничего не дойдёт)
  let http;
  try {
    http = parseLogin(Buffer.from('GET / HTTP/1.1\r\n\r\n'));
  } catch {
    http = { thrown: true };
  }
  assert.ok(http.need || http.thrown, 'HTTP — не вход');
  assert.throws(() => parseLogin(Buffer.from([0x05, 0x07, 1, 2, 3, 4])), /рукопожатие/);
});

async function mcServer() {
  const got = [];
  const srv = net.createServer((s) => s.on('data', (c) => got.push(c)));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { port: srv.address().port, got, close: () => srv.close() };
}

test('хозяин пускает в игру только под ником приглашения; пинг — можно; по одному байту — тоже работает', async () => {
  const mc = await mcServer();
  const run = async (bytes, { slow = false } = {}) => {
    const [g, h] = pair();
    let rejected = null;
    routeStream(h, mc.port, () => assert.fail('не голос'), { name: 'Friend1', onReject: (w) => (rejected = w) });
    const before = Buffer.concat(mc.got).length;
    if (slow) for (const b of bytes) (g.write(Buffer.from([b])), await sleep(2));
    else g.write(bytes);
    await sleep(250);
    const passed = Buffer.concat(mc.got).length - before;
    g.destroy();
    return { passed, rejected };
  };
  const ok = Buffer.concat([mcLogin('Friend1'), Buffer.from('game')]);
  assert.equal((await run(ok)).passed, ok.length, 'свой ник — всё дошло до сервера, байт в байт');
  assert.equal((await run(ok, { slow: true })).passed, ok.length, 'по одному байту — тоже');
  const host = await run(Buffer.concat([mcLogin('HostPlayer'), Buffer.from('game')]));
  assert.equal(host.passed, 0, 'ник хозяина — до сервера ничего не дошло');
  assert.match(host.rejected, /HostPlayer/);
  assert.equal((await run(mcLogin('friend1'))).passed, 0, 'другой регистр — другой игрок в режиме без Microsoft');
  assert.equal((await run(mcLogin('', 1))).passed, mcLogin('', 1).length, 'запрос статуса проходит');
  assert.equal((await run(Buffer.from('GET / HTTP/1.1\r\n\r\n'))).passed, 0, 'не Minecraft — не пропускается');
  mc.close();
});

test('ник хозяина и ник, под которым уже играет другой друг, — не достаются', async () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { EventEmitter } = require('events');
  const { Services } = require('../core/services');
  const platform = Object.assign(new EventEmitter(), { start: async () => 'h'.repeat(32), send() {}, accept() {}, close() {} });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-sec-'));
  const svc = new Services(root, { eos: () => platform, memories: Object.assign(new EventEmitter(), { list: async () => [], dir: root, gameStarted() {}, gameStopped() {} }) });
  const p = await svc.store.createProfile({ name: 'S', minecraft: '1.21.1', loader: 'vanilla' });
  svc.launcher.status = () => ({ server: 'running', port: 25565 });
  Object.defineProperty(svc.launcher.server, 'state', { value: 'running', configurable: true });
  const allowed = [];
  svc.launcher.allowPlayer = async (n) => allowed.push(n);
  await svc.openRoom({ name: 'HostPlayer' }, p.id, 'world', {});
  assert.match(await svc.host.onGuest('hostplayer'), /ник хозяина/, 'ник хозяина (в любом регистре) — отказ');
  assert.equal(await svc.host.onGuest('Friend1'), true);
  assert.deepStrictEqual(allowed, ['Friend1'], 'в белый список попал только друг');
  // два друга с одним ником через EOS
  const host = svc.host;
  const sent = [];
  host.platform.send = (id, ch, buf) => ch === 0 && sent.push([id, JSON.parse(buf.toString().trim())]);
  const inv = await host.invite({ maxUses: 5 });
  const token = new URL(inv.link).searchParams.get('t');
  const say = async (id, m) => {
    host.peer(id).link.onPacket(0, Buffer.from(JSON.stringify(m) + '\n'));
    await sleep(30);
  };
  await say('a'.repeat(32), { t: 'hello', name: 'Bob', token });
  await say('a'.repeat(32), { t: 'join' });
  await say('b'.repeat(32), { t: 'hello', name: 'bob', token });
  await say('b'.repeat(32), { t: 'join' });
  const answers = sent.filter(([, m]) => ['accepted', 'rejected'].includes(m.t)).map(([id, m]) => `${id[0]}:${m.t}${m.reason ? ':' + m.reason : ''}`);
  assert.deepStrictEqual(answers, ['a:accepted', 'b:rejected:Игрок с таким ником уже в сессии.']);
  await svc.stopRoom();
});

test('EOS: связей без приглашения — не больше 32, служебные сообщения от них короткие', async () => {
  const { EosHostSession } = require('../core/net/eos/rooms');
  const { EventEmitter } = require('events');
  const closed = [];
  const platform = Object.assign(new EventEmitter(), { start: async () => 'h'.repeat(32), send() {}, accept() {}, close: (id) => closed.push(id) });
  const host = new EosHostSession({ platform, targetPort: 1, onGuest: async () => true });
  await host.open({ name: 'Мир', manifest: { mods: [] }, hostName: 'Host' });
  for (let i = 0; i < 40; i++) host.peer(String(i).padStart(32, '0')).link.onPacket(0, Buffer.from('x'));
  assert.equal(host.peers.size, 32);
  assert.equal(closed.length, 8, 'лишним — отказ');
  const p = host.peers.values().next().value;
  p.link.onPacket(0, Buffer.alloc(70 * 1024, 0x61)); // 70 КБ без перевода строки
  assert.equal(p.link.ctrl.length, 0, 'буфер сброшен, память не копится');
  await host.close();
});

test('версия загрузчика из приглашения: только номер версии, без «/», «..», «?»', () => {
  const { lockFromManifest } = require('../core/lock');
  const m = (v) => ({ format: 'easylauncher.room-manifest/1', room: { minecraft: '1.20.1', loader: 'forge', loaderVersion: v }, mods: [] });
  assert.equal(lockFromManifest(m('47.4.28')).loaderVersion, '47.4.28');
  assert.equal(lockFromManifest(m('1.20.1-47.1.106')).loaderVersion, '1.20.1-47.1.106');
  assert.equal(lockFromManifest(m(null)).loaderVersion, null);
  for (const bad of ['47.4.0/../../../other/thing', '..', '47#x', '47?x=1', '../evil', ' 47', 'a'.repeat(80)]) assert.throws(() => lockFromManifest(m(bad)), /загрузчика/, bad);
});

test('голос: поток мусора от одного друга не проходит дальше ~75 кадров в секунду', async () => {
  const hub = new VoiceHub('Host');
  const [g, h] = pair();
  routeStream(h, 1, (s) => hub.addStream(s, 'Spammer'));
  const v = new VoiceClient(g, 'Spammer');
  let heard = 0;
  hub.on('audio', () => heard++);
  await sleep(50);
  for (let i = 0; i < 1000; i++) v.send(Buffer.from('x'));
  await sleep(300);
  assert.ok(heard >= 100 && heard <= 140, `прошло ${heard} из 1000`);
  v.close();
  hub.close();
});

test('чужая ссылка-приглашение не обрывает текущую игру у друга', async () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { EventEmitter } = require('events');
  const { Services } = require('../core/services');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-sec2-'));
  const svc = new Services(root, { memories: Object.assign(new EventEmitter(), { list: async () => [], dir: root, gameStarted() {}, gameStopped() {} }) });
  await svc.saveSettings({ nickname: 'Friend1' });
  let closed = false;
  svc.guest = { connected: true, session: { close: async () => (closed = true) } };
  svc.launcher.client = { mode: 'guest' }; // игра у друга запущена
  await assert.rejects(svc.openInvite(`easylauncher://join?e=${'f'.repeat(32)}&t=${'x'.repeat(32)}`, null), /сначала нажми «Отключиться»/);
  assert.equal(closed, false, 'текущая сессия не закрыта');
  svc.launcher.client = null;
});
