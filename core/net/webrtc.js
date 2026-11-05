'use strict';
// Прямой путь: WebRTC data channel из встроенного Chromium (скрытое окно), без нативных модулей.
// Работает только в Electron. Каждое TCP-соединение Minecraft — отдельный упорядоченный канал.
const path = require('path');
const crypto = require('crypto');
const { Duplex } = require('stream');
const { Emitter } = require('./transport');

const CHUNK = 16 * 1024;

class RtcEngine extends Emitter {
  constructor() {
    super();
    this.win = null;
    this.ready = null;
    this.handlers = new Map(); // pcId → handler(msg)
  }

  start() {
    if (this.ready) return this.ready;
    const { BrowserWindow, ipcMain } = require('electron');
    this.ready = new Promise((resolve) => {
      ipcMain.on('rtc:event', (e, msg) => {
        if (e.sender !== this.win?.webContents) return;
        if (msg.ev === 'ready') return resolve();
        this.handlers.get(msg.pc)?.(msg);
      });
      this.win = new BrowserWindow({
        show: false,
        webPreferences: { preload: path.join(__dirname, 'webrtc-preload.js'), contextIsolation: true, sandbox: true, backgroundThrottling: false },
      });
      this.win.loadFile(path.join(__dirname, 'webrtc-worker.html'));
    });
    return this.ready;
  }

  cmd(c) {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send('rtc:cmd', c);
  }

  /** Новое соединение. Возвращает объект пира с событиями. */
  async peer({ role, iceServers, policy }) {
    await this.start();
    const id = crypto.randomBytes(6).toString('hex');
    const p = new Peer(this, id);
    this.handlers.set(id, (m) => p.onEvent(m));
    this.cmd({ op: 'create', pc: id, role, iceServers, policy });
    return p;
  }

  stop() {
    this.win?.destroy();
    this.win = null;
    this.ready = null;
  }
}

class Peer extends Emitter {
  constructor(engine, id) {
    super();
    this.engine = engine;
    this.id = id;
    this.channels = new Map(); // ch → ChannelStream
    this.state = 'new';
    this.route = null;
  }
  onEvent(m) {
    if (m.ev === 'signal') this.emit('signal', m.data);
    else if (m.ev === 'state') {
      this.state = m.state;
      if (m.route) this.route = m.route;
      this.emit('state', m.state);
    } else if (m.ev === 'channel') {
      if (m.ch === 'ctl') return;
      const s = this.stream(m.ch);
      this.emit('channel', s);
    } else if (m.ev === 'open') {
      if (m.ch === 'ctl') this.emit('ctl-open');
      else this.channels.get(m.ch)?.emit('ready');
    } else if (m.ev === 'data') this.channels.get(m.ch)?.push(Buffer.from(m.bytes));
    else if (m.ev === 'ack') this.channels.get(m.ch)?.ack(m.id, m.error);
    else if (m.ev === 'closed') {
      const s = this.channels.get(m.ch);
      this.channels.delete(m.ch);
      s?.push(null);
      s?.destroy();
    } else if (m.ev === 'error') this.emit('error', new Error(m.message));
  }
  signal(data) {
    this.engine.cmd({ op: 'signal', pc: this.id, data });
  }
  stream(ch) {
    const s = new ChannelStream(this, ch);
    this.channels.set(ch, s);
    return s;
  }
  /** Гость: новый канал для TCP-соединения. */
  openChannel() {
    const ch = 'tcp:' + crypto.randomBytes(6).toString('hex');
    const s = this.stream(ch);
    this.engine.cmd({ op: 'open-channel', pc: this.id, ch });
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('канал не открылся')), 10000);
      s.once('ready', () => {
        clearTimeout(t);
        resolve(s);
      });
    });
  }
  close() {
    for (const s of this.channels.values()) s.destroy();
    this.channels.clear();
    this.engine.cmd({ op: 'close', pc: this.id });
    this.engine.handlers.delete(this.id);
  }
}

/** Duplex поверх data channel: запись подтверждается окном (обратное давление). */
class ChannelStream extends Duplex {
  constructor(peer, ch) {
    super();
    this.peer = peer;
    this.ch = ch;
    this.seq = 0;
    this.waiting = new Map();
  }
  _read() {}
  _write(chunk, _enc, cb) {
    if (!chunk.length) return cb(); // пустой кусок: подтверждать нечего — иначе поток встал бы навсегда
    const parts = [];
    for (let i = 0; i < chunk.length; i += CHUNK) parts.push(chunk.subarray(i, i + CHUNK));
    let left = parts.length;
    let failed = false;
    for (const part of parts) {
      const id = ++this.seq;
      this.waiting.set(id, (err) => {
        if (err) failed = true;
        if (--left === 0) cb(failed ? new Error('канал закрыт') : null);
      });
      this.peer.engine.cmd({ op: 'data', pc: this.peer.id, ch: this.ch, id, bytes: part });
    }
  }
  ack(id, error) {
    const f = this.waiting.get(id);
    this.waiting.delete(id);
    f?.(error);
  }
  _final(cb) {
    this.peer.engine.cmd({ op: 'close-channel', pc: this.peer.id, ch: this.ch });
    cb();
  }
  _destroy(err, cb) {
    for (const f of this.waiting.values()) f(true);
    this.waiting.clear();
    this.peer.engine.cmd({ op: 'close-channel', pc: this.peer.id, ch: this.ch });
    cb(err);
  }
}

/** Хозяин: принимает предложения гостей через сервер комнат. */
class RtcHost extends Emitter {
  constructor(engine) {
    super();
    this.engine = engine;
    this.name = 'direct';
    this.peers = new Map(); // ticket → Peer
    this.queues = new Map(); // ticket → цепочка обработки сообщений
  }
  start(ctx) {
    this.ctx = ctx;
  }
  /**
   * Сообщения одного гостя — строго по очереди. Создание пира ждёт скрытое окно (в первый раз — сотни мс);
   * кандидаты ICE, пришедшие за это время, раньше уходили к ещё не созданному пиру и терялись —
   * прямое соединение могло не сойтись и уйти на relay.
   */
  handle(msg) {
    if (msg.type !== 'rtc' || !msg.ticket) return Promise.resolve();
    const next = (this.queues.get(msg.ticket) || Promise.resolve()).then(() => this.handleNow(msg)).catch((e) => this.emit('error', e));
    this.queues.set(msg.ticket, next);
    next.then(() => this.queues.get(msg.ticket) === next && this.queues.delete(msg.ticket));
    return next;
  }
  async handleNow(msg) {
    let p = this.peers.get(msg.ticket);
    if (msg.data?.type === 'offer') {
      p?.close();
      p = await this.engine.peer({ role: 'host', iceServers: msg.data.iceServers || [] });
      this.peers.set(msg.ticket, p);
      p.on('signal', (data) => this.ctx.signal({ type: 'rtc', ticket: msg.ticket, data }));
      p.on('channel', (s) => s.once('ready', () => this.emit('stream', s, { ticket: msg.ticket, route: p.route || 'direct' })));
    }
    p?.signal(msg.data);
  }
  dropGuest(ticket) {
    this.peers.get(ticket)?.close();
    this.peers.delete(ticket);
  }
  stop() {
    for (const t of [...this.peers.keys()]) this.dropGuest(t);
  }
}

/** Гость: прямое соединение; если ICE не сошёлся за timeoutMs — ошибка, и сессия переходит на relay. */
class RtcGuest extends Emitter {
  constructor(engine, { policy } = {}) {
    super();
    this.engine = engine;
    this.name = 'direct';
    this.policy = policy;
  }
  async connect(ctx) {
    this.peer = await this.engine.peer({ role: 'guest', iceServers: ctx.iceServers, policy: this.policy });
    this.peer.on('signal', (data) => ctx.signal({ type: 'rtc', data: data.type === 'offer' ? { ...data, iceServers: ctx.iceServers } : data }));
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('прямое соединение не установилось (NAT/сеть)')), ctx.timeoutMs || 12000);
      this.peer.on('state', (st) => {
        if (st === 'failed') {
          clearTimeout(t);
          reject(new Error('прямое соединение невозможно в этой сети'));
        }
      });
      this.peer.once('ctl-open', () => {
        clearTimeout(t);
        resolve();
      });
    });
    // уточняем тип маршрута (прямой или через TURN)
    await new Promise((r) => setTimeout(r, 50));
    this.name = this.peer.route === 'turn' ? 'turn' : 'direct';
  }
  handle(msg) {
    if (msg.type === 'rtc' && this.peer) this.peer.signal(msg.data);
  }
  openStream() {
    return this.peer.openChannel();
  }
  close() {
    this.peer?.close();
  }
}

module.exports = { RtcEngine, RtcHost, RtcGuest };
