'use strict';
// Голосовой чат: голосовой поток отличается от игрового по метке, хозяин пересылает звук всем,
// гость не может выдать себя за другого; игровые потоки идут на сервер Minecraft как раньше
const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const { PassThrough, Duplex } = require('stream');
const { routeStream, VoiceHub, VoiceClient, MAGIC } = require('../core/net/voice');

/** Пара связанных потоков (как у транспорта): что пишут в a — читают из b, и наоборот. */
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
        wr.end(); // как у настоящего транспорта: закрыл свою сторону — другая видит конец
        cb(err);
      },
    });
    rd.on('data', (c) => d.push(c));
    rd.on('end', () => d.push(null));
    return d;
  };
  return [mk(ba, ab), mk(ab, ba)];
}
const until = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('не дождались');
    await new Promise((r) => setTimeout(r, 10));
  }
};

test('игровой поток гостя по-прежнему идёт на сервер Minecraft, даже если первые байты пришли по одному', async () => {
  const got = [];
  const srv = net.createServer((s) => s.on('data', (c) => got.push(c)));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const [guest, host] = pair();
  let voice = false;
  routeStream(host, srv.address().port, () => (voice = true));
  // рукопожатие Minecraft: длина, пакет 0x00 … — частями
  const hs = Buffer.from([0x10, 0x00, 0xfd, 0x05, 0x09, ...Buffer.from('127.0.0.1'), 0x63, 0xdd, 0x02]);
  guest.write(hs.subarray(0, 1));
  await new Promise((r) => setTimeout(r, 30));
  guest.write(hs.subarray(1));
  await until(() => Buffer.concat(got).length >= hs.length);
  assert.ok(Buffer.concat(got).equals(hs), 'байты дошли до сервера целиком и по порядку');
  assert.equal(voice, false);
  guest.destroy();
  srv.close();
});

test('голос: гость → хозяин и другим гостям; «от кого» ставит хозяин; состав; хозяин говорит всем', async () => {
  const hub = new VoiceHub('Host');
  const route = (stream, name) => routeStream(stream, 1, (s) => hub.addStream(s, name));
  const [ga, ha] = pair();
  const [gb, hb] = pair();
  route(ha, 'Alice');
  route(hb, 'Bob');
  const alice = new VoiceClient(ga, 'Alice');
  const bob = new VoiceClient(gb, 'Bob');
  const hostHeard = [];
  hub.on('audio', (a) => hostHeard.push(a));
  const bobHeard = [];
  bob.on('audio', (a) => bobHeard.push(a));
  const aliceHeard = [];
  alice.on('audio', (a) => aliceHeard.push(a));
  await until(() => hub.peers.size === 2);
  hub.setHost(true);
  await until(() => alice.names.size === 3 && bob.names.size === 3);
  alice.send(Buffer.from('opus-from-alice'));
  await until(() => hostHeard.length === 1 && bobHeard.length === 1);
  assert.equal(hostHeard[0].name, 'Alice');
  assert.equal(bobHeard[0].name, 'Alice', 'Боб слышит Алису под её именем');
  assert.equal(bobHeard[0].data.toString(), 'opus-from-alice');
  assert.equal(aliceHeard.length, 0, 'себя не слышно');
  hub.hostSend(Buffer.from('host-voice'));
  await until(() => aliceHeard.length === 1 && bobHeard.length === 2);
  assert.equal(aliceHeard[0].name, 'Host');
  // гость выходит — состав обновляется у остальных
  alice.close();
  await until(() => bob.names.size === 2);
  assert.deepStrictEqual([...bob.names.values()].sort(), ['Bob', 'Host']);
  hub.close();
});

test('голос у хозяина EOS доступен сразу после открытия комнаты, без прихода друзей (последнее событие — уже с комнатой)', async () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { EventEmitter } = require('events');
  const { Services } = require('../core/services');
  const platform = Object.assign(new EventEmitter(), { start: async () => 'h'.repeat(32), send() {}, accept() {}, close() {} });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-v-'));
  const svc = new Services(root, { eos: () => platform, memories: Object.assign(new EventEmitter(), { list: async () => [], dir: root, gameStarted() {}, gameStopped() {} }) });
  const p = await svc.store.createProfile({ name: 'S', minecraft: '1.21.1', loader: 'vanilla' });
  svc.launcher.status = () => ({ server: 'running', port: 25565 });
  const seen = [];
  svc.on('room', () => seen.push(svc.voiceStatus().available));
  await svc.openRoom({ name: 'HostPlayer' }, p.id, 'world', {});
  assert.equal(seen.at(-1), true, 'в момент последнего события комнаты голосовой чат уже доступен: ' + JSON.stringify(seen));
  assert.deepStrictEqual((await svc.voiceJoin()).roster, [{ id: 0, name: 'HostPlayer' }]);
  await svc.stopRoom();
  assert.equal(svc.voiceStatus().available, false, 'сессия закрыта — голоса нет');
});

test('настройки голоса: только известные поля и разумные значения; версии Minecraft для значка', () => {
  const { normalizeVoice, indicatorSupport, voiceCommands } = require('../core/voicecfg');
  const v = normalizeVoice({ mode: 'toggle', hotkey: 'Ctrl+Alt+Del', threshold: 5, micGain: -1, volume: '1.5', micId: 'abc"; rm', peers: { Alex: { volume: 9, muted: 1 }, 'bad name!': { volume: 1 } }, evil: true });
  assert.deepStrictEqual([v.mode, v.hotkey, v.threshold, v.micGain, v.volume, v.micId], ['toggle', 'F8', 0.2, 0, 1.5, '']);
  assert.deepStrictEqual(v.peers, { Alex: { volume: 2, muted: false } }, 'muted — только true; плохой ник отброшен');
  assert.ok(!('evil' in v));
  assert.deepStrictEqual([normalizeVoice(null).tab, normalizeVoice(null).actionbar, normalizeVoice(null).mode], [true, false, 'voice']);
  for (const [mc, tab, bar] of [['1.20.1', true, true], ['26.3', true, true], ['1.13', true, true], ['1.12.2', false, true], ['1.8.9', false, false], ['24w14a', false, false], ['b1.7.3', false, false]])
    assert.deepStrictEqual(indicatorSupport(mc), { tab, actionbar: bar, spatial: tab }, mc);
  assert.deepStrictEqual([normalizeVoice({}).spatial, normalizeVoice({}).range, normalizeVoice({ range: 500 }).range, normalizeVoice({ spatial: false }).spatial], [true, 48, 128, false]);
  assert.deepStrictEqual(voiceCommands.speak('Alex_1', true), ['team join el_voice Alex_1']);
  assert.deepStrictEqual(voiceCommands.speak('Alex_1', false), ['team leave Alex_1']);
  assert.deepStrictEqual(voiceCommands.speak('bad name; op me', true), [], 'ник не из Minecraft — команда не отправляется');
  assert.deepStrictEqual(voiceCommands.actionbar(['A', 'evil"}']), []);
});

test('кто говорит: сразу «говорит», после паузы «замолчал»; ушёл посреди фразы — тоже «замолчал»', async () => {
  const hub = new VoiceHub('Host');
  hub.silenceMs = 150;
  const ev = [];
  hub.on('speaking', (e) => ev.push(`${e.name}:${e.on}`));
  const [g, h] = pair();
  routeStream(h, 1, (s) => hub.addStream(s, 'Alice'));
  const alice = new VoiceClient(g, 'Alice');
  await until(() => hub.peers.size === 1);
  hub.setHost(true);
  alice.send(Buffer.from('a'));
  alice.send(Buffer.from('b'));
  hub.hostSend(Buffer.from('h'));
  await until(() => ev.includes('Alice:true') && ev.includes('Host:true'));
  assert.equal(ev.filter((e) => e === 'Alice:true').length, 1, 'одна фраза — одно «говорит»');
  await until(() => ev.includes('Alice:false') && ev.includes('Host:false'), 2000);
  alice.send(Buffer.from('c'));
  await until(() => ev.filter((e) => e === 'Alice:true').length === 2);
  alice.close();
  await until(() => ev.filter((e) => e === 'Alice:false').length === 2);
  hub.close();
});

test('значок в игре: команды серверу сессии по версии Minecraft и настройкам; конец сессии — команда игроков убрана', async () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { EventEmitter } = require('events');
  const { Services } = require('../core/services');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-vg-'));
  const svc = new Services(root, { memories: Object.assign(new EventEmitter(), { list: async () => [], dir: root, gameStarted() {}, gameStopped() {} }) });
  const cmds = [];
  const srv = { state: 'running', command: (c) => cmds.push(c), stop: async () => {} };
  Object.defineProperty(svc.launcher, 'server', { value: srv, configurable: true });
  const modern = await svc.store.createProfile({ name: 'M', minecraft: '1.20.1', loader: 'fabric' });
  svc.host = { profileId: modern.id, close: async () => {} };
  await svc.voiceInGame('Alex', true);
  await svc.voiceInGame('Alex', false);
  assert.deepStrictEqual(cmds, ['team add el_voice', 'team modify el_voice suffix {"text":" \\u266a","color":"green","bold":true}', 'team empty el_voice', 'team join el_voice Alex', 'team leave Alex']);
  cmds.length = 0;
  // надпись над хотбаром — по настройке
  await svc.saveSettings({ voice: { actionbar: true, tab: false } });
  await svc.voiceInGame('Bob', true);
  assert.deepStrictEqual(cmds, ['title @a actionbar {"text":"\\u266a Bob","color":"green"}']);
  await svc.voiceInGame('Bob', false);
  cmds.length = 0;
  // 1.12 — значка в табе нет (команды игроков без приставки), надпись есть; 1.8 — ничего
  await svc.saveSettings({ voice: { actionbar: true, tab: true } });
  const old = await svc.store.createProfile({ name: 'O', minecraft: '1.12.2', loader: 'forge' });
  svc.host.profileId = old.id;
  await svc.voiceInGame('Alex', true);
  assert.deepStrictEqual(cmds, ['title @a actionbar {"text":"\\u266a Alex","color":"green"}']);
  await svc.voiceInGame('Alex', false);
  cmds.length = 0;
  const vold = await svc.store.createProfile({ name: 'V', minecraft: '1.8.9', loader: 'vanilla' });
  svc.host.profileId = vold.id;
  await svc.voiceInGame('Alex', true);
  assert.deepStrictEqual(cmds, []);
  // конец сессии: команда игроков удаляется
  svc.host.profileId = modern.id;
  svc.voiceTeam = true;
  await svc.stopRoom();
  assert.ok(cmds.includes('team remove el_voice'));
});

test('голос: испорченный поток закрывается, огромный кадр не принимается, отставший гость не копит очередь', async () => {
  const hub = new VoiceHub('Host');
  const [g, h] = pair();
  routeStream(h, 1, (s) => hub.addStream(s, 'Eve'));
  g.write(Buffer.concat([MAGIC, Buffer.from([1, 0xff, 0xff])]));
  await until(() => h.destroyed && hub.peers.size === 0);
  const sent = [];
  const fake = { destroyed: false, writableLength: 100 * 1024, write: (b) => sent.push(b), on() {}, destroy() {} };
  hub.peers.set(5, { stream: fake, name: 'Slow' });
  hub.setHost(true);
  hub.hostSend(Buffer.from('x'));
  assert.equal(sent.length, 0, 'медленному гостю кадры не копятся');
  hub.hostSend(Buffer.alloc(5000));
  hub.close();
});

test('координаты игроков: ответы сервера разбираются, прячутся из журнала, чужие строки остаются', () => {
  const { PositionTracker, parseEntityLine, cleanPositions } = require('../core/voicepos');
  // как пишут настоящие серверы 1.20.1 и 26.3 (у 26.3 — «System chat:»)
  assert.deepStrictEqual(parseEntityLine('[02:25:24] [Server thread/INFO]: Alex_1 has the following entity data: [-250.5d, 72.0d, -116.5d]'), { name: 'Alex_1', pos: [-250.5, 72, -116.5] });
  assert.deepStrictEqual(parseEntityLine('[02:27:19] [Server thread/INFO]: System chat: Alex_1 has the following entity data: [90.0f, 12.5f]'), { name: 'Alex_1', rot: [90, 12.5] });
  assert.deepStrictEqual(parseEntityLine('[x] [Server thread/INFO]: Alex_1 has the following entity data: "minecraft:the_nether"'), { name: 'Alex_1', dim: 'minecraft:the_nether' });
  assert.deepStrictEqual(parseEntityLine('[x] [Server thread/INFO] [minecraft/DedicatedServer]: Bob has the following entity data: -1'), { name: 'Bob', dim: 'dim-1' });
  assert.equal(parseEntityLine('[x] [Server thread/INFO]: Alex_1 has the following entity data: {Inventory: []}'), null);
  assert.equal(parseEntityLine('<Alex_1> hello'), null);
  const cmds = [];
  const srv = { state: 'running', players: new Set(['Alex_1', 'Bob']), command: (c) => cmds.push(c), quiet: null };
  const tr = new PositionTracker(srv, { interval: 100000 });
  let got = null;
  tr.on('positions', (p) => (got = p));
  tr.start();
  assert.equal(typeof srv.quiet, 'function', 'вывод сервера идёт через трекер');
  tr.tick();
  assert.deepStrictEqual(cmds, ['data get entity Alex_1 Pos', 'data get entity Alex_1 Rotation', 'data get entity Alex_1 Dimension', 'data get entity Bob Pos', 'data get entity Bob Rotation', 'data get entity Bob Dimension']);
  assert.equal(srv.quiet('[x] [Server thread/INFO]: Alex_1 has the following entity data: [1.234d, 64.0d, -3.0d]'), true, 'ответ спрятан');
  assert.equal(srv.quiet('[x] [Server thread/INFO]: Alex_1 has the following entity data: [180.0f, 0.0f]'), true);
  assert.equal(srv.quiet('[x] [Server thread/INFO]: Alex_1 has the following entity data: "minecraft:overworld"'), true);
  assert.equal(srv.quiet('[x] [Server thread/INFO]: Zed has the following entity data: [1.0d, 2.0d, 3.0d]'), false, 'не игрок сессии — строка остаётся');
  assert.equal(srv.quiet('[x] [Server thread/INFO]: <Alex_1> привет'), false, 'чат остаётся');
  cmds.length = 0;
  tr.tick();
  assert.deepStrictEqual(got, { Alex_1: [1.23, 64, -3, 180, 'minecraft:overworld'] }, 'у Боба ещё нет координат — его нет в списке');
  assert.ok(!cmds.some((c) => /Dimension/.test(c)), 'измерение — не каждый раз');
  tr.stop();
  assert.equal(srv.quiet, null);
  // у гостя — только похожее на правду
  assert.deepStrictEqual(cleanPositions({ A: [1, 2, 3, 4, 'minecraft:overworld'], 'b a d': [1, 2, 3, 4, ''], C: [1, 2, 'x', 4, ''], D: [1, 2, 3, 4, 5], E: [Infinity, 0, 0, 0, ''] }), { A: [1, 2, 3, 4, 'minecraft:overworld'], D: [1, 2, 3, 4, ''] });
});

test('позиции от хозяина доходят до гостя; тестовый игрок повторяет хозяина с задержкой и «говорит»', async () => {
  const hub = new VoiceHub('Host');
  hub.silenceMs = 150;
  const [g, h] = pair();
  routeStream(h, 1, (s) => hub.addStream(s, 'Alice'));
  const alice = new VoiceClient(g, 'Alice');
  let pos = null;
  alice.on('positions', (p) => (pos = p));
  const aliceHeard = [];
  alice.on('audio', (a) => aliceHeard.push(a));
  await until(() => hub.peers.size === 1);
  hub.setHost(true);
  hub.sendPositions({ Host: [0, 64, 0, 90, 'minecraft:overworld'], Alice: [5, 64, 5, 0, 'minecraft:overworld'] });
  await until(() => pos);
  assert.deepStrictEqual(pos.Alice, [5, 64, 5, 0, 'minecraft:overworld']);
  const id = hub.addBot('Test_2', 100);
  assert.equal(hub.addBot('Test_2', 100), id, 'второй раз не добавляется');
  await until(() => alice.names.size === 3);
  const hostHeard = [];
  const speak = [];
  hub.on('audio', (a) => hostHeard.push(a));
  hub.on('speaking', (e) => speak.push(`${e.name}:${e.on}`));
  const t0 = Date.now();
  hub.hostSend(Buffer.from('hello'));
  await until(() => hostHeard.length === 1 && aliceHeard.length === 2);
  assert.ok(Date.now() - t0 >= 90, 'с задержкой');
  assert.equal(hostHeard[0].name, 'Test_2');
  assert.equal(hostHeard[0].data.toString(), 'hello', 'хозяин слышит себя голосом Test_2');
  assert.equal(aliceHeard[1].name, 'Test_2');
  assert.ok(speak.includes('Test_2:true'), 'значок ♪ у Test_2');
  hub.removeBot('Test_2');
  await until(() => alice.names.size === 2);
  assert.ok(speak.includes('Test_2:false'), 'убрали посреди фразы — значок снят');
  hub.hostSend(Buffer.from('again'));
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(hostHeard.length, 1, 'после «Убрать» эха нет');
  hub.close();
});
test('тестовый игрок не повторяет своё же эхо из колонок (без наушников повтор шёл бы по кругу)', async () => {
  const hub = new VoiceHub('Host');
  hub.setHost(true);
  hub.addBot('Test_2', 500);
  const heard = [];
  hub.on('audio', (a) => heard.push(a.data.toString()));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const burst = async (tag, n) => {
    for (let i = 0; i < n; i++) {
      hub.hostSend(Buffer.from(tag));
      await sleep(20);
    }
  };
  await burst('речь', 4); // хозяин сказал фразу
  await sleep(450); // замолчал; через 0,5 с Test_2 повторяет
  await burst('эхо', 4); // микрофон слышит повтор из колонок — новая «фраза», пока Test_2 говорит
  await sleep(1300);
  await burst('снова', 3); // Test_2 замолчал — новая фраза хозяина повторяется
  await sleep(700);
  assert.deepStrictEqual([...new Set(heard)], ['речь', 'снова'], 'эхо не повторено: ' + JSON.stringify(heard));
  assert.equal(heard.filter((x) => x === 'речь').length, 4, 'фраза повторена целиком');
  hub.close();
});