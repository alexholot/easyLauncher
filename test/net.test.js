'use strict';
// Сеть на localhost: сервер комнат, приглашения, допуск гостя, relay, отзыв, прокси CurseForge.
// Прямой путь (WebRTC) проверяется отдельно в Electron (test/electron/webrtc-e2e.js).
const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createServer } = require('../server');
const { HostSession, GuestSession, parseInvite } = require('../core/net/session');
const { RelayHost, RelayGuest } = require('../core/net/relay');
const { Emitter } = require('../core/net/transport');
const { Launcher } = require('../core/launcher');
const { buildFixtures, testLauncher, waitEvent } = require('./helpers');

const manifest = { format: 'easylauncher.room-manifest/1', room: { name: 'Мир', minecraft: '1.21.1', loader: 'vanilla' }, mods: [] };

function echoServer() {
  return new Promise((r) => {
    const s = net.createServer((c) => c.pipe(c));
    s.listen(0, '127.0.0.1', () => r(s));
  });
}

/** «Прямой путь», который всегда недоступен (как при симметричном NAT без TURN). */
class FailingDirect extends Emitter {
  constructor() {
    super();
    this.name = 'direct';
  }
  async connect() {
    throw new Error('ICE failed');
  }
  handle() {}
  close() {}
}

function roundTrip(port, payload) {
  return new Promise((resolve, reject) => {
    const c = net.connect(port, '127.0.0.1');
    const got = [];
    let n = 0;
    c.on('data', (d) => {
      got.push(d);
      n += d.length;
      if (n >= payload.length) {
        c.end();
        resolve(Buffer.concat(got));
      }
    });
    c.on('error', reject);
    c.write(payload);
  });
}

let srv;
let backend;
test.before(async () => {
  srv = createServer({ cfApiKey: 'SECRET-KEY', cfBase: 'http://cf.invalid', fetch: async (url, init) => new Response(JSON.stringify({ data: [{ id: 1 }], seenKey: init.headers['x-api-key'] === 'SECRET-KEY', url }), { status: 200 }) });
  const port = await srv.listen(0, '127.0.0.1');
  backend = `http://127.0.0.1:${port}`;
});
test.after(() => srv.close());

test('приглашение: ссылка, срок, лимит, имя, отзыв, хозяин не в сети', async () => {
  const game = await echoServer();
  const host = new HostSession({ backend, transports: [new RelayHost()], targetPort: game.address().port, onGuest: async () => true });
  await host.open({ name: 'Мир', manifest, hostName: 'HostPlayer' });
  const inv = await host.invite({ ttlMinutes: 30, maxUses: 1, allowedNames: ['Friend1'] });
  const p = parseInvite(inv.link);
  assert.equal(p.server, backend);
  assert.ok(inv.token.length >= 40, 'токен непредсказуемый (256 бит)');
  assert.throws(() => parseInvite('https://evil.example/join'), /не ссылка/);
  assert.throws(() => parseInvite(inv.link.replace(encodeURIComponent(backend), encodeURIComponent('http://evil.example'))), /HTTPS/);

  const g = new GuestSession({ transports: [] });
  await assert.rejects(g.join(inv.link, 'Stranger'), /другому игроку/);
  await assert.rejects(g.join(inv.link.replace(/t=[^&]+/, 't=' + 'A'.repeat(43)), 'Friend1'), /недействительно/);
  await g.join(inv.link, 'Friend1');
  await assert.rejects(new GuestSession({ transports: [] }).join(inv.link, 'Friend1'), /все участники/);

  // истёкшее приглашение
  const inv2 = await host.invite({ ttlMinutes: 5, maxUses: 3 });
  const realNow = srv.rooms.now;
  srv.rooms.now = () => Date.now() + 10 * 60000;
  await assert.rejects(new GuestSession({ transports: [] }).join(inv2.link, 'Friend2'), /Срок действия/);
  srv.rooms.now = realNow;
  // отзыв
  await host.revoke(inv2.inviteId);
  await assert.rejects(new GuestSession({ transports: [] }).join(inv2.link, 'Friend2'), /отозвал/);
  // хозяин закрыл лаунчер — мир недоступен
  const inv3 = await host.invite({});
  await host.close();
  await assert.rejects(new GuestSession({ transports: [] }).join(inv3.link, 'Friend3'), /Комната|недействительно|не в сети/);
  game.close();
});

test('гость: допуск хозяином, прямой путь недоступен → relay, несколько соединений, 4 МБ без искажений', async () => {
  const game = await echoServer();
  const asked = [];
  const host = new HostSession({ backend, transports: [new RelayHost()], targetPort: game.address().port, onGuest: async (name) => (asked.push(name), true) });
  await host.open({ name: 'Мир', manifest, hostName: 'HostPlayer' });
  const inv = await host.invite({});
  const guest = new GuestSession({ transports: [new FailingDirect(), new RelayGuest()] });
  const joined = await guest.join(inv.link, 'Friend1');
  assert.equal(joined.manifest.room.minecraft, '1.21.1', 'гость видит версию и состав до подготовки');
  const stages = [];
  guest.on('stage', (s) => stages.push(s));
  const conn = await guest.connect();
  assert.equal(conn.route, 'relay');
  assert.deepEqual(stages, ['waiting-host', 'try-direct', 'try-relay']);
  assert.deepEqual(asked, ['Friend1']);
  const big = crypto.randomBytes(4 * 1024 * 1024);
  const results = await Promise.all([roundTrip(conn.port, big), roundTrip(conn.port, Buffer.from('ping')), roundTrip(conn.port, crypto.randomBytes(100000))]);
  assert.ok(results[0].equals(big), '4 МБ через relay без искажений');
  assert.equal(results[1].toString(), 'ping');
  assert.ok(srv.stats.relayBytes >= big.length * 2);
  const st = host.state('online');
  assert.deepEqual(st.guests[0].routes, ['relay']);
  await guest.close();
  await host.close();
  game.close();
});

test('отказ хозяина и отзыв приглашения во время игры', async () => {
  const game = await echoServer();
  const host = new HostSession({ backend, transports: [new RelayHost()], targetPort: game.address().port, onGuest: async (name) => (name === 'Griefer' ? 'Игрок заблокирован хозяином.' : true) });
  await host.open({ name: 'Мир', manifest, hostName: 'HostPlayer' });
  const inv = await host.invite({ maxUses: 5 });
  const bad = new GuestSession({ transports: [new RelayGuest()] });
  await bad.join(inv.link, 'Griefer');
  await assert.rejects(bad.connect(), /заблокирован/);
  bad.close();

  const guest = new GuestSession({ transports: [new RelayGuest()] });
  await guest.join(inv.link, 'Friend1');
  const { port } = await guest.connect();
  const sock = net.connect(port, '127.0.0.1');
  await new Promise((r) => sock.once('connect', r));
  sock.write('x');
  await new Promise((r) => sock.once('data', r));
  const revokedEvent = new Promise((r) => guest.once('revoked', r));
  const closed = new Promise((r) => sock.once('close', r));
  const names = await host.revoke(inv.inviteId);
  assert.deepEqual(names, ['Friend1'], 'лаунчер уберёт игрока из белого списка');
  await revokedEvent;
  await closed;
  assert.equal(host.state('online').guests.find((g) => g.name === 'Friend1').status, 'revoked');
  await guest.close();
  await host.close();
  game.close();
});

test('relay не принимает гостя без допуска и чужой билет у хозяина', async () => {
  const { openWs } = require('../core/net/relay');
  const host = new HostSession({ backend, transports: [new RelayHost()], targetPort: 1, onGuest: () => new Promise(() => {}) });
  await host.open({ name: 'Мир', manifest, hostName: 'HostPlayer' });
  const inv = await host.invite({});
  const g = new GuestSession({ transports: [] });
  await g.join(inv.link, 'Friend1');
  const wsBase = backend.replace('http', 'ws');
  await assert.rejects(openWs(`${wsBase}/v1/relay?conn=abcdefgh`, g.ticket), (e) => e.status === 403);
  await assert.rejects(openWs(`${wsBase}/v1/relay?role=host&room=${host.roomId}&ticket=${g.ticket}&conn=abcdefgh`, 'wrong-secret'), (e) => e.status === 403);
  await host.close();
});

test('прокси CurseForge: ключ только на сервере, разрешённые пути', async () => {
  const r = await (await fetch(`${backend}/cf/v1/mods/search?gameId=432&searchFilter=jei`)).json();
  assert.equal(r.seenKey, true, 'сервер добавил ключ');
  assert.ok(!JSON.stringify(r).includes('SECRET-KEY'), 'ключ не уходит клиенту');
  assert.equal((await fetch(`${backend}/cf/v1/mods/1/files/2/download-url`)).status, 404, 'лишние эндпоинты закрыты');
  assert.equal((await fetch(`${backend}/cf/v1/mods/search`, { method: 'POST' })).status, 404);
  const s2 = createServer({ cfApiKey: '' });
  const p2 = await s2.listen(0, '127.0.0.1');
  assert.equal((await fetch(`http://127.0.0.1:${p2}/cf/v1/mods/search`)).status, 503);
  await s2.close();
});

test('сквозной сценарий на одном ПК: сервер хозяина → туннель → клиент друга, белый список', async (t) => {
  if (!buildFixtures().ok) return t.skip('нет JDK');
  const hostL = testLauncher(Launcher, fs.mkdtempSync(path.join(os.tmpdir(), 'easy-h-')), { totalMem: 16 * 1024 ** 3 });
  const guestL = testLauncher(Launcher, fs.mkdtempSync(path.join(os.tmpdir(), 'easy-g-')), { totalMem: 16 * 1024 ** 3 });
  try {
    const p = await hostL.store.createProfile({ minecraft: '1.21.1', loader: 'vanilla' });
    const w = { name: 'Совместный' };
    process.env.FAKE_CLIENT_MS = '200';
    await hostL.startSession({ profileId: p.id, create: { name: w.name }, auth: { name: 'HostPlayer', uuid: 'a', accessToken: 't' }, eula: true, serverRam: 1 });
    const host = new HostSession({ backend, transports: [new RelayHost()], targetPort: hostL.server.port, onGuest: async (name) => (hostL.allowPlayer(name), true) });
    await host.open({ name: w.name, manifest, hostName: 'HostPlayer' });
    const inv = await host.invite({});
    const guest = new GuestSession({ transports: [new FailingDirect(), new RelayGuest()] });
    await guest.join(inv.link, 'Friend1');
    const { port } = await guest.connect();
    const gp = await guestL.store.createProfile({ minecraft: '1.21.1', loader: 'vanilla', kind: 'room' });
    await guestL.playGuest({ profileId: gp.id, address: '127.0.0.1:' + port, auth: { name: 'Friend1', uuid: 'b', accessToken: 't' }, ram: 2 });
    await waitEvent(guestL, (ev) => ev.type === 'client' && ev.state === 'stopped');
    assert.ok(guestL.clientLines.includes('connected:hello'), 'клиент друга дошёл до сервера хозяина через relay');
    assert.ok(hostL.server.lines.some((l) => l.includes('Added Friend1 to the whitelist')));
    await guest.close();
    await host.close();
  } finally {
    delete process.env.FAKE_CLIENT_MS;
    await hostL.shutdown();
  }
});
