'use strict';
// Запуск: npx electron test/electron/webrtc-e2e.js  (на Linux без дисплея — через xvfb-run)
// Проверяет на localhost: прямой путь WebRTC, передачу данных, несколько соединений,
// и переход на relay, если прямой путь невозможен.
const { app } = require('electron');
const net = require('net');
const crypto = require('crypto');
const assert = require('assert');
const { createServer } = require('../../server');
const { HostSession, GuestSession } = require('../../core/net/session');
const { RelayHost, RelayGuest } = require('../../core/net/relay');
const { RtcEngine, RtcHost, RtcGuest } = require('../../core/net/webrtc');
const { mcLogin } = require('../mclogin');

// mDNS-имена вместо адресов кандидатов не разрешаются в изолированных средах
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');

const manifest = { format: 'easylauncher.room-manifest/1', room: { name: 'Мир', minecraft: '1.21.1', loader: 'vanilla' }, mods: [] };

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

async function scenario(engine, backend, gamePort, guestTransports) {
  const host = new HostSession({ backend, transports: [new RtcHost(engine), new RelayHost()], targetPort: gamePort, onGuest: async () => true });
  await host.open({ name: 'Мир', manifest, hostName: 'HostPlayer' });
  const inv = await host.invite({});
  const guest = new GuestSession({ transports: guestTransports });
  await guest.join(inv.link, 'Friend1');
  const t0 = Date.now();
  const conn = await guest.connect({ directTimeoutMs: 8000 });
  const connectMs = Date.now() - t0;
  // игровой поток начинается со входа в Minecraft под ником друга — иначе хозяин его не пропустит
  const big = Buffer.concat([mcLogin('Friend1'), crypto.randomBytes(2 * 1024 * 1024)]);
  const ping = Buffer.concat([mcLogin('Friend1'), Buffer.from('ping')]);
  const t1 = Date.now();
  const res = await Promise.all([roundTrip(conn.port, big), roundTrip(conn.port, ping), roundTrip(conn.port, Buffer.concat([mcLogin('Friend1'), crypto.randomBytes(50000)]))]);
  const ms = Date.now() - t1;
  assert.ok(res[0].equals(big), 'данные без искажений');
  assert.ok(res[1].equals(ping));
  // вход под ником хозяина по этому же каналу — закрывается, ничего не возвращается
  const spoof = await new Promise((resolve) => {
    const c = net.connect(conn.port, '127.0.0.1');
    let got = 0;
    c.on('data', (d) => (got += d.length));
    c.on('close', () => resolve(got));
    c.on('error', () => {});
    c.write(Buffer.concat([mcLogin('HostPlayer'), Buffer.from('x')]));
  });
  assert.equal(spoof, 0, 'вход под чужим ником отклонён');
  const routes = host.state('online').guests[0].routes;
  await guest.close();
  await host.close();
  return { route: conn.route, hostRoutes: routes, connectMs, transferMs: ms };
}

app.whenReady().then(async () => {
  const out = {};
  let code = 0;
  const srv = createServer({ stun: '' }); // без внешнего STUN: только локальные кандидаты
  const port = await srv.listen(0, '127.0.0.1');
  const backend = `http://127.0.0.1:${port}`;
  const game = await new Promise((r) => {
    const s = net.createServer((c) => c.pipe(c));
    s.listen(0, '127.0.0.1', () => r(s));
  });
  const engine = new RtcEngine();
  try {
    out.direct = await scenario(engine, backend, game.address().port, [new RtcGuest(engine), new RelayGuest()]);
    assert.equal(out.direct.route, 'direct');
    assert.deepEqual(out.direct.hostRoutes, ['direct']);
    // Прямой путь запрещён (как в сети без UDP и без TURN) → relay
    out.fallback = await scenario(engine, backend, game.address().port, [new RtcGuest(engine, { policy: 'relay' }), new RelayGuest()]);
    assert.equal(out.fallback.route, 'relay');
    out.ok = true;
  } catch (e) {
    out.error = e.stack || String(e);
    code = 1;
  }
  console.log('WEBRTC_E2E ' + JSON.stringify(out));
  engine.stop();
  game.close();
  await srv.close();
  app.exit(code);
});
