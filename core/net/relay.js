'use strict';
// Запасной маршрут: TCP-поток поверх WebSocket через relay сервера easyLauncher.
// Relay пересылает байты; мир и сервер Minecraft остаются на ПК хозяина.
const crypto = require('crypto');
const { WebSocket, createWebSocketStream } = require('ws');
const { Emitter } = require('./transport');

const wsUrl = (backend) => backend.replace(/^http/, 'ws').replace(/\/$/, '');

/**
 * Открыть WebSocket. Если stream=true, поток создаётся сразу, до события open:
 * сервер может прислать данные в том же такте, что и рукопожатие, и они не должны потеряться.
 */
function openWs(url, token, timeoutMs = 15000, { stream = false } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { Authorization: 'Bearer ' + token }, handshakeTimeout: timeoutMs, maxPayload: 1024 * 1024 });
    const duplex = stream ? createWebSocketStream(ws) : null;
    duplex?.on('error', () => {});
    ws.once('open', () => resolve(stream ? duplex : ws));
    ws.once('unexpected-response', (_req, res) => {
      // с этим обработчиком ws сам соединение не закрывает — закрываем, иначе сокет висит
      res.resume?.();
      ws.terminate();
      reject(Object.assign(new Error(`relay отклонил соединение (${res.statusCode})`), { status: res.statusCode }));
    });
    ws.once('error', reject);
  });
}

class RelayHost extends Emitter {
  constructor() {
    super();
    this.name = 'relay';
    this.byGuest = new Map(); // ticket → Set<stream>
  }
  start(ctx) {
    this.ctx = ctx;
  }
  async handle(msg) {
    if (msg.type !== 'relay-open') return;
    const { backend, roomId, secret } = this.ctx;
    const url = `${wsUrl(backend)}/v1/relay?role=host&room=${encodeURIComponent(roomId)}&ticket=${encodeURIComponent(msg.ticket)}&conn=${encodeURIComponent(msg.conn)}`;
    try {
      const stream = await openWs(url, secret, 15000, { stream: true });
      const set = this.byGuest.get(msg.ticket) || new Set();
      set.add(stream);
      this.byGuest.set(msg.ticket, set);
      stream.on('close', () => set.delete(stream));
      this.emit('stream', stream, { ticket: msg.ticket, route: 'relay' });
    } catch (e) {
      this.emit('error', e);
    }
  }
  dropGuest(ticket) {
    for (const s of this.byGuest.get(ticket) || []) s.destroy();
    this.byGuest.delete(ticket);
  }
  stop() {
    for (const t of this.byGuest.keys()) this.dropGuest(t);
  }
}

class RelayGuest extends Emitter {
  constructor() {
    super();
    this.name = 'relay';
    this.streams = new Set();
  }
  /** Проверяем, что relay действительно доступен, пробным соединением не делаем — достаточно билета. */
  async connect(ctx) {
    this.ctx = ctx;
  }
  handle() {}
  async openStream() {
    const conn = crypto.randomBytes(9).toString('base64url');
    const stream = await openWs(`${wsUrl(this.ctx.backend)}/v1/relay?conn=${conn}`, this.ctx.ticket, 15000, { stream: true });
    this.streams.add(stream);
    stream.on('close', () => this.streams.delete(stream));
    return stream;
  }
  close() {
    for (const s of this.streams) s.destroy();
  }
}

module.exports = { RelayHost, RelayGuest, openWs, wsUrl };
