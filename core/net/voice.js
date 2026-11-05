'use strict';
// Голосовой чат в сессии с друзьями — по тому же соединению, что и игра (EOS, прямое, relay).
//
// Гость открывает отдельный поток к хозяину и пишет в начало метку ELVOICE1. Хозяин по первым байтам
// отличает его от игрового: пакет рукопожатия Minecraft начинается с длины и номера пакета 0x00 —
// вторым байтом никогда не бывает «L». Голосовой поток уходит в узел хозяина, игровой — на сервер Minecraft.
//
// Узел (VoiceHub) у хозяина пересылает звук каждого участника всем остальным; звук — кадры Opus из окна.
// Кадр потока: [тип u8][длина u16][данные]. Типы: 1 — звук [от кого u8][номер u16][opus],
// 2 — состав участников (JSON), 3 — приветствие гостя (JSON {name}), 4 — где стоят игроки (JSON, для объёмного звука).
const { EventEmitter } = require('events');
const { toLocalServer } = require('./transport');
const { cleanPositions } = require('../voicepos');
const { guardLogin } = require('./mcguard');

const MAGIC = Buffer.from('ELVOICE1');
const AUDIO = 1;
const ROSTER = 2;
const HELLO = 3;
const POS = 4;
const MAX_FRAME = 4000; // кадр Opus 20 мс — сотни байт; больше — не голос
const HOST_ID = 0;

/**
 * Поток гостя: голос → onVoice(stream), остальное — на сервер Minecraft. opts.name — ник, под которым хозяин
 * принял друга: игровой поток пропускается, только если в пакете входа этот же ник (core/net/mcguard.js).
 */
function routeStream(stream, port, onVoice, opts = {}) {
  let head = Buffer.alloc(0);
  const decide = () => {
    stream.off('data', onData);
    stream.pause();
    if (head.length >= MAGIC.length && head.subarray(0, MAGIC.length).equals(MAGIC)) {
      const rest = head.subarray(MAGIC.length);
      if (rest.length) stream.unshift(rest);
      onVoice(stream);
      // игровой поток снимает паузу сам (pipe), голосовой — здесь, после подключения обработчика кадров
      stream.resume();
    } else if (opts.name) {
      guardLogin(
        stream,
        head,
        opts.name,
        (all) => {
          stream.unshift(all);
          toLocalServer(stream, port);
        },
        { onReject: opts.onReject },
      );
    } else {
      stream.unshift(head);
      toLocalServer(stream, port);
    }
  };
  const onData = (c) => {
    head = Buffer.concat([head, c]);
    // пока байты совпадают с началом метки и их меньше 8 — ждём; иначе решаем сразу
    if (head.length < MAGIC.length && MAGIC.subarray(0, head.length).equals(head)) return;
    decide();
  };
  stream.on('data', onData);
}

function frame(type, payload) {
  const b = Buffer.allocUnsafe(3 + payload.length);
  b[0] = type;
  b.writeUInt16BE(payload.length, 1);
  payload.copy(b, 3);
  return b;
}
function audioFrame(from, seq, opus) {
  const p = Buffer.allocUnsafe(3 + opus.length);
  p[0] = from;
  p.writeUInt16BE(seq & 0xffff, 1);
  Buffer.from(opus).copy(p, 3);
  return frame(AUDIO, p);
}

/** Разбор кадров из потока: onFrame(type, payload). Испорченный поток закрывается. */
function frameReader(stream, onFrame) {
  let buf = Buffer.alloc(0);
  stream.on('data', (c) => {
    buf = buf.length ? Buffer.concat([buf, c]) : c;
    while (buf.length >= 3) {
      const len = buf.readUInt16BE(1);
      if (len > MAX_FRAME + 3) {
        stream.destroy();
        return;
      }
      if (buf.length < 3 + len) break;
      const type = buf[0];
      const payload = buf.subarray(3, 3 + len);
      buf = buf.subarray(3 + len);
      onFrame(type, payload);
    }
  });
}

/**
 * Узел голоса у хозяина. События: 'audio' {from, name, seq, data} — звук гостя для хозяина;
 * 'roster' [{id, name}] — кто в голосовом чате.
 */
class VoiceHub extends EventEmitter {
  constructor(hostName) {
    super();
    this.hostName = hostName || 'Хозяин';
    this.peers = new Map(); // id → {stream, name}
    this.hostOn = false;
    this.seq = 0;
    this.heard = new Map(); // id → когда последний раз пришёл звук
    this.talking = new Set(); // кто говорит прямо сейчас (для значка в игре)
    this.silenceMs = 500;
  }

  /** Звук от участника: начал говорить — событие сразу; замолчал на silenceMs — событие «замолчал». */
  mark(id) {
    this.heard.set(id, Date.now());
    if (!this.talking.has(id)) {
      this.talking.add(id);
      this.emit('speaking', { id, name: this.nameOf(id), on: true });
    }
    if (!this.silenceTimer) {
      this.silenceTimer = setInterval(() => {
        for (const t of [...this.talking]) {
          if (Date.now() - (this.heard.get(t) || 0) < this.silenceMs) continue;
          this.talking.delete(t);
          this.emit('speaking', { id: t, name: this.nameOf(t), on: false });
        }
        if (!this.talking.size) {
          clearInterval(this.silenceTimer);
          this.silenceTimer = null;
        }
      }, 100);
      this.silenceTimer.unref?.();
    }
  }
  nameOf(id) {
    return id === HOST_ID ? this.hostName : this.peers.get(id)?.name || '';
  }

  /** Голосовой поток гостя (после метки). name — ник, под которым хозяин его принял. */
  addStream(stream, name) {
    let id = 1;
    while (this.peers.has(id) && id < 250) id++;
    if (this.peers.has(id)) return stream.destroy();
    const peer = { stream, name: String(name || 'Гость').slice(0, 16) };
    this.peers.set(id, peer);
    // не больше ~75 кадров в секунду от одного друга (голос — 50): поток мусора не забьёт канал остальным
    let tokens = 100;
    let refill = Date.now();
    frameReader(stream, (type, p) => {
      if (type !== AUDIO || p.length < 4) return;
      const now = Date.now();
      tokens = Math.min(100, tokens + ((now - refill) * 75) / 1000);
      refill = now;
      if (tokens < 1) return;
      tokens--;
      const seq = p.readUInt16BE(1);
      const opus = p.subarray(3);
      // гость не может выдать себя за другого: «от кого» ставит хозяин
      this.mark(id);
      this.emit('audio', { from: id, name: peer.name, seq, data: opus });
      this.broadcast(audioFrame(id, seq, opus), id);
    });
    const drop = () => {
      if (this.peers.get(id)?.stream !== stream) return;
      // вышел посреди фразы — значок в игре снимается
      if (this.talking.delete(id)) this.emit('speaking', { id, name: peer.name, on: false });
      this.peers.delete(id);
      this.sendRoster();
    };
    stream.on('close', drop);
    stream.on('end', drop); // друг закрыл свою сторону
    stream.on('error', drop);
    this.sendRoster();
    return id;
  }

  roster() {
    return [...(this.hostOn ? [{ id: HOST_ID, name: this.hostName }] : []), ...[...this.peers].map(([id, p]) => ({ id, name: p.name }))];
  }
  sendRoster() {
    const r = this.roster();
    this.broadcast(frame(ROSTER, Buffer.from(JSON.stringify(r))));
    this.emit('roster', r);
  }
  broadcast(buf, except = null) {
    for (const [id, p] of this.peers) {
      if (id === except || !p.stream || p.stream.destroyed) continue; // у тестового игрока потока нет
      // голос не копится: если гость не успевает принимать — кадр пропускается, а не ждёт в очереди
      if (p.stream.writableLength > 64 * 1024) continue;
      p.stream.write(buf);
    }
  }

  /** Хозяин вошёл в голосовой чат / вышел. */
  setHost(on) {
    this.hostOn = !!on;
    this.sendRoster();
  }
  /** Звук хозяина (кадр Opus) — всем гостям. */
  hostSend(opus) {
    if (!this.hostOn || !opus?.length || opus.length > MAX_FRAME) return;
    this.mark(HOST_ID);
    this.broadcast(audioFrame(HOST_ID, this.seq++, opus));
    // тестовый игрок повторяет голос хозяина с задержкой — как будто говорит он
    const now = Date.now();
    for (const [id, p] of this.peers) {
      if (!p.bot) continue;
      // Без наушников микрофон слышит повтор из колонок — повтор повторялся бы снова и снова, то тише, то громче.
      // Поэтому новая фраза хозяина (после паузы) повторяется, только если тестовый игрок сейчас молчит;
      // фраза, начатая, пока он говорит, — это его же эхо в микрофоне.
      if (now - p.lastIn > 300) p.accept = now >= p.playUntil;
      p.lastIn = now;
      if (!p.accept) continue;
      p.playUntil = now + p.delay + 400;
      const data = Buffer.from(opus);
      const seq = (p.seq = (p.seq + 1) & 0xffff);
      const t = setTimeout(() => {
        if (this.peers.get(id) !== p) return;
        this.mark(id);
        this.emit('audio', { from: id, name: p.name, seq, data });
        this.broadcast(audioFrame(id, seq, data));
      }, p.delay);
      t.unref?.();
    }
  }

  /**
   * Где стоят игроки ({ник: [x, y, z, поворот, измерение]}) — всем гостям, для объёмного звука.
   * Хозяин узнаёт их у своего сервера (core/voicepos.js).
   */
  sendPositions(players) {
    const b = Buffer.from(JSON.stringify(players || {}));
    if (b.length <= MAX_FRAME) this.broadcast(frame(POS, b));
  }

  /**
   * ВРЕМЕННО, для проверки на одном компьютере: участник без соединения, который повторяет голос хозяина
   * через delay мс. Вместе со вторым Minecraft под тем же ником хозяин слышит себя со стороны его персонажа.
   */
  addBot(name, delay = 1200) {
    for (const [id, p] of this.peers) if (p.bot && p.name === name) return id;
    let id = 1;
    while (this.peers.has(id) && id < 250) id++;
    if (this.peers.has(id)) return null;
    this.peers.set(id, { stream: null, bot: true, name: String(name).slice(0, 16), delay, seq: 0, lastIn: 0, playUntil: 0, accept: false });
    this.sendRoster();
    return id;
  }
  removeBot(name) {
    for (const [id, p] of this.peers) {
      if (!p.bot || p.name !== name) continue;
      if (this.talking.delete(id)) this.emit('speaking', { id, name: p.name, on: false });
      this.peers.delete(id);
      this.sendRoster();
    }
  }

  close() {
    for (const t of this.talking) this.emit('speaking', { id: t, name: this.nameOf(t), on: false });
    this.talking.clear();
    clearInterval(this.silenceTimer);
    this.silenceTimer = null;
    for (const p of this.peers.values()) p.stream?.destroy();
    this.peers.clear();
    this.hostOn = false;
    this.emit('roster', []);
  }
}

/** Гость: голосовой поток к хозяину. События 'audio' {from, name, seq, data}, 'roster', 'closed'. */
class VoiceClient extends EventEmitter {
  constructor(stream, name) {
    super();
    this.stream = stream;
    this.seq = 0;
    this.names = new Map();
    stream.write(Buffer.concat([MAGIC, frame(HELLO, Buffer.from(JSON.stringify({ name })))]));
    frameReader(stream, (type, p) => {
      if (type === ROSTER) {
        try {
          // состав от хозяина — только похожее на правду: номер 0–254 и короткий ник (дальше он идёт в окно)
          const r = JSON.parse(p.toString('utf8'));
          if (Array.isArray(r)) {
            const clean = r
              .slice(0, 64)
              .filter((x) => x && Number.isInteger(x.id) && x.id >= 0 && x.id < 255)
              .map((x) => ({ id: x.id, name: String(x.name || '').slice(0, 16) }));
            this.names = new Map(clean.map((x) => [x.id, x.name]));
            this.emit('roster', clean);
          }
        } catch {}
      } else if (type === AUDIO && p.length >= 4) this.emit('audio', { from: p[0], name: this.names.get(p[0]) || '', seq: p.readUInt16BE(1), data: p.subarray(3) });
      else if (type === POS) {
        try {
          this.emit('positions', cleanPositions(JSON.parse(p.toString('utf8'))));
        } catch {}
      }
    });
    stream.on('close', () => this.emit('closed'));
    stream.on('error', () => {});
  }
  send(opus) {
    if (!opus?.length || opus.length > MAX_FRAME || this.stream.destroyed || this.stream.writableLength > 64 * 1024) return;
    // «от кого» в кадре гостя не важно — хозяин подставит своё
    this.stream.write(audioFrame(255, this.seq++, opus));
  }
  close() {
    this.stream.destroy();
  }
}

module.exports = { routeStream, VoiceHub, VoiceClient, MAGIC, audioFrame, frameReader, HOST_ID };
