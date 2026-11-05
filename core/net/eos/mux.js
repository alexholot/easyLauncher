'use strict';
// Потоки TCP поверх пакетов P2P (EOS: до 1170 байт, надёжно и по порядку).
//   канал 0 — служебные сообщения: JSON по строкам, длинное сообщение режется на пакеты;
//   канал 1 — игровые потоки: [u32 id][u8 операция][данные].
// Окно отправки на поток (WINDOW): отправитель не уходит дальше, чем получатель подтвердил, —
// медленный игрок не переполняет очереди EOS, а TCP игры сам притормаживает.
const { Duplex } = require('stream');
const { EventEmitter } = require('events');

const MAX_PACKET = 1170;
const HEADER = 5;
const PAYLOAD = MAX_PACKET - HEADER;
const WINDOW = 512 * 1024;
const ACK_STEP = 32 * 1024;
const MAX_CONTROL = 4 * 1024 * 1024;
const MAX_STREAMS = 64; // игра — 1–2 потока, голос — 1; с запасом на переподключения
const OP = { OPEN: 1, DATA: 2, END: 3, ACK: 4, RESET: 5 };
const CONTROL = 0;
const STREAMS = 1;

function frame(id, op, payload = null) {
  const b = Buffer.alloc(HEADER + (payload ? payload.length : 0));
  b.writeUInt32BE(id, 0);
  b.writeUInt8(op, 4);
  if (payload) payload.copy(b, HEADER);
  return b;
}

class MuxStream extends Duplex {
  constructor(link, id) {
    super({ allowHalfOpen: false });
    this.link = link;
    this.id = id;
    this.credit = WINDOW;
    this.pending = []; // {chunk, cb} ждут окна
    this.unacked = 0;
    this.ended = false;
  }
  _write(chunk, _enc, cb) {
    this.pending.push({ chunk, cb });
    this.pump();
  }
  pump() {
    while (this.pending.length && this.credit > 0 && !this.destroyed) {
      const p = this.pending[0];
      const n = Math.min(p.chunk.length, PAYLOAD, this.credit);
      this.link.raw(frame(this.id, OP.DATA, p.chunk.subarray(0, n)));
      this.credit -= n;
      p.chunk = p.chunk.subarray(n);
      if (!p.chunk.length) {
        this.pending.shift();
        p.cb();
      }
    }
  }
  /** Данные от другой стороны: в поток и, когда прочитаны, — подтверждение. */
  deliver(data) {
    this.push(data);
    this.unacked += data.length;
    this.maybeAck();
  }
  maybeAck(force = false) {
    if (this.unacked && (force || this.unacked >= ACK_STEP) && this.readableLength < this.readableHighWaterMark) {
      const b = Buffer.alloc(4);
      b.writeUInt32BE(this.unacked, 0);
      this.unacked = 0;
      this.link.raw(frame(this.id, OP.ACK, b));
    }
  }
  _read() {
    this.maybeAck(true);
  }
  _final(cb) {
    this.link.raw(frame(this.id, OP.END));
    cb();
  }
  _destroy(err, cb) {
    if (!this.ended || !this.writableFinished) this.link.raw(frame(this.id, OP.RESET));
    this.link.streams.delete(this.id);
    for (const p of this.pending) p.cb(err || new Error('поток закрыт'));
    this.pending = [];
    cb(err);
  }
}

/**
 * Связь с одним игроком. send(channel, Buffer) — отправка пакета через P2P.
 * События: 'control' (объект), 'stream' (MuxStream — открыт другой стороной), 'close'.
 */
class PeerLink extends EventEmitter {
  constructor(send, { initiator = false, maxControl = MAX_CONTROL } = {}) {
    super();
    this.sendPacket = send;
    this.maxControl = maxControl;
    this.streams = new Map();
    this.nextId = initiator ? 1 : 2; // разные чётности: стороны не путают номера потоков
    this.ctrl = Buffer.alloc(0);
    this.closed = false;
  }

  raw(buf) {
    if (!this.closed) this.sendPacket(STREAMS, buf);
  }

  /** Служебное сообщение — JSON-строка, разрезанная на пакеты. */
  control(obj) {
    if (this.closed) return;
    const data = Buffer.from(JSON.stringify(obj) + '\n');
    for (let i = 0; i < data.length; i += MAX_PACKET) this.sendPacket(CONTROL, data.subarray(i, i + MAX_PACKET));
  }

  openStream() {
    if (this.closed) throw new Error('Связь с хозяином закрыта.');
    const id = this.nextId;
    this.nextId += 2;
    const s = new MuxStream(this, id);
    this.streams.set(id, s);
    this.raw(frame(id, OP.OPEN));
    return s;
  }

  onPacket(channel, buf) {
    if (this.closed) return;
    if (channel === CONTROL) return this.onControl(buf);
    if (channel !== STREAMS || buf.length < HEADER) return;
    const id = buf.readUInt32BE(0);
    const op = buf.readUInt8(4);
    const body = buf.subarray(HEADER);
    let s = this.streams.get(id);
    if (op === OP.OPEN) {
      if (s) return;
      // другая сторона не может открывать потоки без конца (каждый — соединение с сервером Minecraft)
      if (this.streams.size >= MAX_STREAMS) return this.raw(frame(id, OP.RESET));
      s = new MuxStream(this, id);
      this.streams.set(id, s);
      return this.emit('stream', s);
    }
    if (!s) return;
    if (op === OP.DATA) s.deliver(Buffer.from(body));
    else if (op === OP.ACK && body.length >= 4) {
      s.credit += body.readUInt32BE(0);
      s.pump();
    } else if (op === OP.END) {
      s.ended = true;
      s.push(null);
    } else if (op === OP.RESET) {
      s.ended = true;
      s.destroy();
    }
  }

  onControl(buf) {
    this.ctrl = Buffer.concat([this.ctrl, buf]);
    if (this.ctrl.length > this.maxControl) {
      this.ctrl = Buffer.alloc(0);
      return;
    }
    let nl;
    while ((nl = this.ctrl.indexOf(10)) >= 0) {
      const line = this.ctrl.subarray(0, nl).toString('utf8');
      this.ctrl = this.ctrl.subarray(nl + 1);
      try {
        this.emit('control', JSON.parse(line));
      } catch {}
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const s of [...this.streams.values()]) s.destroy();
    this.streams.clear();
    this.emit('close');
  }
}

module.exports = { PeerLink, MuxStream, MAX_PACKET, WINDOW, CONTROL, STREAMS };
