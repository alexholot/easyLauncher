'use strict';
// Игра с друзьями через EOS: потоки TCP поверх пакетов, приглашения и допуск хозяином.
// Сеть EOS здесь — имитация в памяти (пакеты до 1170 байт, надёжно и по порядку);
// настоящие вход по устройству и P2P проверяются вручную (test/eos-live) — им нужен интернет и ключи.
const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { PeerLink, MAX_PACKET } = require('../core/net/eos/mux');
const { EosHostSession, EosGuestSession } = require('../core/net/eos/rooms');
const { parseInvite } = require('../core/net/session');

/** Имитация платформы EOS: два «компьютера» в одной памяти; пакеты доставляются по одному, асинхронно. */
function fakeNet() {
  const nodes = new Map();
  let sent = 0;
  class FakePlatform extends EventEmitter {
    constructor(puid) {
      super();
      this.puidValue = puid;
      this.connected = new Set();
      nodes.set(puid, this);
    }
    async start() {
      this.puid = this.puidValue;
      return this.puid;
    }
    send(peer, channel, data) {
      assert.ok(data.length <= MAX_PACKET, 'пакет не больше 1170 байт');
      const other = nodes.get(peer);
      if (!other) return;
      sent++;
      const copy = Buffer.from(data);
      setImmediate(() => {
        if (!other.connected.has(this.puid)) {
          other.connected.add(this.puid);
          this.connected.add(peer);
          other.emit('request', this.puid);
          other.emit('established', this.puid, 'eos-direct');
          this.emit('established', peer, 'eos-direct');
        }
        other.emit('packet', this.puid, channel, copy);
      });
    }
    accept() {}
    close(peer) {
      const other = nodes.get(peer);
      if (!other || !this.connected.has(peer)) return;
      this.connected.delete(peer);
      other.connected.delete(this.puid);
      setImmediate(() => other.emit('closed', this.puid, 'закрыто другом'));
    }
  }
  return { FakePlatform, packets: () => sent };
}

/** «Сервер Minecraft» хозяина: отвечает тем же (эхо) — так видно, что поток дошёл туда и обратно. */
function echoServer() {
  const srv = net.createServer((s) => s.pipe(s));
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ port: srv.address().port, close: () => srv.close() })));
}

const { mcLogin } = require('./mclogin');

function roundTrip(port, payload) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1');
    const parts = [];
    let got = 0;
    sock.on('data', (d) => {
      parts.push(d);
      got += d.length;
      if (got >= payload.length) {
        sock.end();
        resolve(Buffer.concat(parts));
      }
    });
    sock.on('error', reject);
    sock.write(payload);
  });
}

test('потоки TCP поверх пакетов P2P: большие данные, окно отправки, несколько потоков', async () => {
  const { FakePlatform } = fakeNet();
  const a = new FakePlatform('a'.repeat(32));
  const b = new FakePlatform('b'.repeat(32));
  const la = new PeerLink((ch, buf) => a.send(b.puidValue, ch, buf), { initiator: true });
  const lb = new PeerLink((ch, buf) => b.send(a.puidValue, ch, buf));
  a.on('packet', (_p, ch, buf) => la.onPacket(ch, buf));
  b.on('packet', (_p, ch, buf) => lb.onPacket(ch, buf));
  lb.on('stream', (s) => s.pipe(s)); // эхо на стороне хозяина
  // служебное сообщение длиннее пакета (как список модов сборки) режется и собирается обратно
  const big = { t: 'room', manifest: { mods: Array.from({ length: 300 }, (_, i) => ({ name: 'Мод ' + i, sha1: crypto.randomBytes(20).toString('hex') })) } };
  const got = new Promise((r) => lb.once('control', r));
  la.control(big);
  assert.deepEqual(await got, big);
  // три потока одновременно, 3 МБ каждый — больше окна отправки (512 КБ)
  const runs = [0, 1, 2].map(async () => {
    const data = crypto.randomBytes(3 * 1024 * 1024);
    const s = la.openStream();
    const chunks = [];
    let got = 0;
    const done = new Promise((r) =>
      s.on('data', (d) => {
        chunks.push(d);
        got += d.length;
        if (got >= data.length) r();
      }),
    );
    s.write(data);
    await done;
    assert.ok(Buffer.concat(chunks).equals(data), 'данные дошли целыми и по порядку');
    s.end();
  });
  await Promise.all(runs);
  la.close();
  lb.close();
});

test('ссылка-приглашение EOS: разбор и защита от подмены', () => {
  const host = 'f'.repeat(32);
  assert.deepEqual(parseInvite(`easylauncher://join?e=${host}&t=${'x'.repeat(32)}`), { kind: 'eos', host, token: 'x'.repeat(32), roomId: host });
  assert.throws(() => parseInvite('easylauncher://join?e=../../etc&t=' + 'x'.repeat(32)), /повреждено/);
  assert.throws(() => parseInvite(`easylauncher://join?e=${host}&t=short`), /повреждено/);
});

test('игра через EOS: приглашение → сборка комнаты → допуск → Minecraft гостя ходит на сервер хозяина', async () => {
  const { FakePlatform } = fakeNet();
  const mc = await echoServer();
  const hostP = new FakePlatform('1'.repeat(32));
  const allowed = [];
  const host = new EosHostSession({ platform: hostP, targetPort: mc.port, onGuest: async (name) => (allowed.push(name), true) });
  const states = [];
  host.on('state', (s) => states.push(s));
  const manifest = { room: { minecraft: '1.21.1', loader: 'fabric' }, mods: [{ name: 'Sodium' }] };
  await host.open({ name: 'Мир с друзьями', manifest, hostName: 'HostPlayer' });
  const inv = await host.invite({ ttlMinutes: 60, maxUses: 1 });
  assert.match(inv.link, /^easylauncher:\/\/join\?e=1{32}&t=[\w-]{20,}$/);

  const guestP = new FakePlatform('2'.repeat(32));
  const guest = new EosGuestSession({ platform: guestP });
  const joined = await guest.join(parseInvite(inv.link), 'Friend1');
  assert.deepEqual(joined.room, { name: 'Мир с друзьями', hostName: 'HostPlayer' });
  assert.deepEqual(joined.manifest, manifest, 'сборка комнаты пришла от хозяина');
  const conn = await guest.connect();
  assert.equal(conn.route, 'eos-direct');
  assert.deepEqual(allowed, ['Friend1'], 'хозяин добавил ник в белый список');
  const payload = Buffer.concat([mcLogin('Friend1'), crypto.randomBytes(200 * 1024)]);
  assert.ok((await roundTrip(conn.port, payload)).equals(payload), 'поток гостя дошёл до сервера хозяина и обратно');
  // тот же друг пытается войти в игру под ником хозяина — поток закрывается, до сервера не доходит
  const spoof = await new Promise((resolve) => {
    const sock = net.connect(conn.port, '127.0.0.1');
    let got = 0;
    sock.on('data', (d) => (got += d.length));
    sock.on('close', () => resolve(got));
    sock.on('error', () => {});
    sock.write(Buffer.concat([mcLogin('HostPlayer'), Buffer.from('secret')]));
  });
  assert.equal(spoof, 0, 'вход под чужим ником отклонён');
  // запрос статуса (список серверов) — пропускается
  const ping = mcLogin('', 1);
  assert.ok((await roundTrip(conn.port, ping)).equals(ping), 'пинг сервера проходит');
  const last = host.state('online').guests[0];
  assert.deepEqual([last.name, last.status, last.routes], ['Friend1', 'accepted', ['eos-direct']]);

  // второй игрок по тому же приглашению (на одного) — отказ; отзыв — гость отключается
  const third = new EosGuestSession({ platform: new FakePlatform('3'.repeat(32)) });
  await assert.rejects(third.join(parseInvite(inv.link), 'Friend2'), /уже вошли все/);
  const revoked = new Promise((r) => guest.once('revoked', r));
  assert.deepEqual(await host.revoke(inv.inviteId), ['Friend1']);
  await revoked;
  const list = await host.invites();
  assert.equal(list[0].revoked, true);
  assert.equal(list[0].uses, 1);
  await guest.close();
  await third.close();
  await host.close();
  mc.close();
});

test('голосовой чат по соединению EOS: игра и голос одновременно, хозяин слышит гостя под его ником', async () => {
  const { VoiceHub } = require('../core/net/voice');
  const { FakePlatform } = fakeNet();
  const mc = await echoServer();
  const host = new EosHostSession({ platform: new FakePlatform('a1'.repeat(16)), targetPort: mc.port, onGuest: async () => true });
  const hub = new VoiceHub('HostPlayer');
  host.on('voice-stream', (s, name) => hub.addStream(s, name));
  await host.open({ name: 'Мир', manifest: { room: {}, mods: [] }, hostName: 'HostPlayer' });
  const inv = await host.invite({});
  const guest = new EosGuestSession({ platform: new FakePlatform('b2'.repeat(16)) });
  await guest.join(parseInvite(inv.link), 'Friend1');
  const conn = await guest.connect();
  hub.setHost(true);
  const voice = await guest.openVoice('Friend1');
  const heard = [];
  hub.on('audio', (a) => heard.push(a));
  const guestHeard = [];
  voice.on('audio', (a) => guestHeard.push(a));
  const roster = await new Promise((r) => voice.on('roster', (x) => x.length === 2 && r(x)));
  assert.deepEqual(roster.map((x) => x.name), ['HostPlayer', 'Friend1']);
  // игра идёт параллельно — её поток по-прежнему доходит до сервера
  const payload = Buffer.concat([mcLogin('Friend1'), crypto.randomBytes(64 * 1024)]);
  const game = roundTrip(conn.port, payload);
  for (let i = 0; i < 20; i++) voice.send(Buffer.from(`opus-${i}`));
  hub.hostSend(Buffer.from('host-hello'));
  assert.ok((await game).equals(payload), 'игровой поток не пострадал');
  for (let i = 0; i < 100 && (heard.length < 20 || !guestHeard.length); i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(heard.length, 20, 'все кадры гостя дошли, по порядку');
  assert.deepEqual([heard[0].name, heard[19].data.toString()], ['Friend1', 'opus-19']);
  assert.deepEqual([guestHeard[0].name, guestHeard[0].data.toString()], ['HostPlayer', 'host-hello']);
  voice.close();
  hub.close();
  await guest.close();
  await host.close();
  mc.close();
});

test('EOS: истёкшее приглашение, чужой ник, хозяин не в сети, отказ хозяина', async () => {
  const { FakePlatform } = fakeNet();
  let t = 1_000_000;
  const hostP = new FakePlatform('4'.repeat(32));
  const host = new EosHostSession({ platform: hostP, targetPort: 1, now: () => t, onGuest: async () => 'Сервер хозяина сейчас не запущен.' });
  await host.open({ name: 'Мир', manifest: { mods: [] }, hostName: 'Host' });
  const onlyAlex = await host.invite({ allowedNames: ['Alex_1'] });
  const g1 = new EosGuestSession({ platform: new FakePlatform('5'.repeat(32)) });
  await assert.rejects(g1.join(parseInvite(onlyAlex.link), 'Steve'), /не для этого ника/);
  const g2 = new EosGuestSession({ platform: new FakePlatform('6'.repeat(32)) });
  await g2.join(parseInvite(onlyAlex.link), 'Alex_1');
  await assert.rejects(g2.connect(), /Сервер хозяина сейчас не запущен/, 'хозяин может отказать — гость видит причину');
  t += 2 * 3600 * 1000;
  const g3 = new EosGuestSession({ platform: new FakePlatform('7'.repeat(32)) });
  await assert.rejects(g3.join(parseInvite(onlyAlex.link), 'Alex_1'), /истёк/);
  // хозяин не в сети: на приглашение никто не отвечает — понятная ошибка, а не вечное ожидание
  const g4 = new EosGuestSession({ platform: new FakePlatform('8'.repeat(32)), replyTimeoutMs: 300 });
  await assert.rejects(g4.join({ kind: 'eos', host: '9'.repeat(32), token: 'x'.repeat(32) }, 'Alex_1'), /Хозяин не отвечает/);
  for (const g of [g1, g3, g4]) assert.equal(g.platform.listenerCount('packet'), 0, 'после неудачного входа подписки EOS сняты');
  // своё же приглашение на этом ПК
  const self = new EosGuestSession({ platform: hostP });
  await assert.rejects(self.join(parseInvite(onlyAlex.link), 'Host'), /этого же компьютера/);
  for (const g of [g1, g2, g3, g4]) await g.close();
  await host.close();
});
