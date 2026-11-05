'use strict';
// Исправления сетевого кода (4.5.2): переподключение к серверу комнат, порядок сообщений WebRTC у хозяина,
// пустая запись в канал, предел потоков EOS, состав голосового чата от хозяина.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { PassThrough, Duplex } = require('stream');
const { WebSocketServer } = require('ws');
const { SignalChannel } = require('../core/net/session');
const { RtcHost } = require('../core/net/webrtc');
const { PeerLink } = require('../core/net/eos/mux');
const { VoiceClient } = require('../core/net/voice');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('не дождались');
    await sleep(20);
  }
};

test('сервер комнат пропал и не сразу вернулся — служебная связь всё равно восстанавливается', async () => {
  // свой маленький сервер: принимает WebSocket, его можно «выключить» (порт закрыт) и включить снова
  let srv;
  let wss;
  let port = 0;
  const up = () =>
    new Promise((r) => {
      srv = http.createServer();
      wss = new WebSocketServer({ server: srv });
      srv.listen(port, '127.0.0.1', () => {
        port = srv.address().port;
        r();
      });
    });
  const down = () =>
    new Promise((r) => {
      for (const c of wss.clients) c.terminate();
      wss.close();
      srv.close(() => r());
    });
  await up();
  const ch = new SignalChannel(`ws://127.0.0.1:${port}/`, 'secret');
  let opens = 0;
  ch.on('open', () => opens++);
  await ch.open();
  assert.equal(opens, 1);
  await down();
  // сервер лежит дольше первой паузы (1 с): первая попытка неудачна — раньше на этом попытки и кончались
  await sleep(1700);
  await up();
  await until(() => opens === 2, 10000);
  ch.close();
  await down();
});

test('прямое соединение у хозяина: кандидаты ICE, пришедшие пока создаётся пир, не теряются', async () => {
  const got = [];
  const engine = {
    // создание пира — как в первый раз: окно WebRTC ещё загружается
    async peer() {
      await sleep(150);
      const p = new (require('events').EventEmitter)();
      p.signal = (d) => got.push(d.type + (d.n ?? ''));
      p.close = () => {};
      return p;
    },
  };
  const host = new RtcHost(engine);
  host.start({ signal: () => {} });
  host.handle({ type: 'rtc', ticket: 't1', data: { type: 'offer', sdp: 'x' } });
  host.handle({ type: 'rtc', ticket: 't1', data: { type: 'candidate', n: 1 } });
  await sleep(20);
  host.handle({ type: 'rtc', ticket: 't1', data: { type: 'candidate', n: 2 } });
  await until(() => got.length === 3);
  assert.deepStrictEqual(got, ['offer', 'candidate1', 'candidate2'], 'все сообщения дошли и по порядку');
});

test('канал прямого соединения: пустая запись не останавливает поток', async () => {
  const { RtcEngine } = require('../core/net/webrtc');
  // ChannelStream не экспортируется — берём его через пира с поддельным движком
  const cmds = [];
  const engine = Object.assign(new RtcEngine(), { cmd: (c) => cmds.push(c), start: async () => {} });
  const peer = await engine.peer({ role: 'guest' });
  const s = peer.stream('tcp:1');
  await new Promise((resolve, reject) => s.write(Buffer.alloc(0), (e) => (e ? reject(e) : resolve())));
  // следующая запись проходит, когда окно её подтвердит
  const done = new Promise((r) => s.write(Buffer.from('abc'), r));
  const data = cmds.find((c) => c.op === 'data');
  assert.ok(data, 'данные ушли в окно');
  s.ack(data.id);
  await done;
});

test('EOS: другая сторона не может открыть потоков без конца', () => {
  const sent = [];
  const link = new PeerLink((ch, buf) => sent.push(buf));
  let opened = 0;
  link.on('stream', () => opened++);
  const open = (id) => {
    const b = Buffer.alloc(5);
    b.writeUInt32BE(id, 0);
    b.writeUInt8(1, 4); // OPEN
    link.onPacket(1, b);
  };
  for (let i = 0; i < 100; i++) open(1 + i * 2);
  assert.equal(opened, 64, 'больше 64 — отказ');
  const resets = sent.filter((b) => b.readUInt8(4) === 5).length;
  assert.equal(resets, 36, 'лишним — сброс');
  link.close();
});

test('голос у гостя: состав от хозяина — только номер и короткий ник', async () => {
  const toGuest = new PassThrough();
  const stream = new Duplex({ read() {}, write(c, e, cb) { cb(); } });
  toGuest.on('data', (c) => stream.push(c));
  const v = new VoiceClient(stream, 'Me');
  let roster = null;
  v.on('roster', (r) => (roster = r));
  const json = Buffer.from(JSON.stringify([{ id: 0, name: 'Host' }, { id: 'x', name: 'bad' }, { id: 3, name: 'A'.repeat(200), extra: '<img>' }, null, { id: 999, name: 'big' }]));
  const f = Buffer.alloc(3 + json.length);
  f[0] = 2;
  f.writeUInt16BE(json.length, 1);
  json.copy(f, 3);
  toGuest.write(f);
  await until(() => roster);
  assert.deepStrictEqual(roster, [{ id: 0, name: 'Host' }, { id: 3, name: 'A'.repeat(16) }]);
  v.close();
});
