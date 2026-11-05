'use strict';
// Сессии совместной игры. Три независимые части:
//   1) сервер комнат: обнаружение комнаты, приглашения, служебные сообщения (REST + WebSocket);
//   2) права входа: токен приглашения → билет → подтверждение хозяина → белый список Minecraft;
//   3) игровой трафик: транспорт (прямой путь, если возможен, иначе relay).
const { WebSocket } = require('ws');
const { api } = require('../http');
const { localListener, Emitter } = require('./transport');
const { routeStream, VoiceClient } = require('./voice');
const { wsUrl } = require('./relay');

const NAME_RE = /^[A-Za-z0-9_]{3,16}$/;

function friendly(e) {
  const msg = e.data?.error || e.message;
  return Object.assign(new Error(msg), { status: e.status, code: e.code || (e.status ? 'HTTP_' + e.status : 'NETWORK') });
}

/**
 * Ссылка-приглашение: через Epic Online Services — easylauncher://join?e=<id хозяина в EOS>&t=<токен>,
 * через сервер комнат — easylauncher://join?s=<сервер>&r=<комната>&t=<токен>.
 */
function parseInvite(link) {
  let u;
  try {
    u = new URL(String(link).trim());
  } catch {
    throw new Error('Это не ссылка-приглашение easyLauncher.');
  }
  if (u.protocol !== 'easylauncher:') throw new Error('Это не ссылка-приглашение easyLauncher.');
  if (u.searchParams.get('e')) {
    const host = u.searchParams.get('e');
    const token = u.searchParams.get('t') || '';
    if (!/^[0-9a-f]{32}$/.test(host) || !/^[\w-]{20,128}$/.test(token)) throw new Error('Приглашение повреждено.');
    return { kind: 'eos', host, token, roomId: host };
  }
  const server = u.searchParams.get('s') || '';
  const roomId = u.searchParams.get('r') || '';
  const token = u.searchParams.get('t') || '';
  let su;
  try {
    su = new URL(server);
  } catch {
    throw new Error('В приглашении нет адреса сервера.');
  }
  const local = ['127.0.0.1', 'localhost'].includes(su.hostname);
  if (su.protocol !== 'https:' && !(local && su.protocol === 'http:')) throw new Error('Сервер приглашения должен использовать HTTPS.');
  if (!/^[\w-]{8,64}$/.test(roomId) || !/^[\w-]{20,128}$/.test(token)) throw new Error('Приглашение повреждено.');
  return { kind: 'server', server: su.origin, roomId, token };
}

/** Постоянное служебное соединение с сервером комнат с переподключением. */
class SignalChannel extends Emitter {
  constructor(url, token) {
    super();
    this.url = url;
    this.token = token;
    this.closed = false;
    this.retry = 0;
  }
  open() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url, { headers: { Authorization: 'Bearer ' + this.token }, handshakeTimeout: 15000 });
      this.ws = ws;
      let opened = false;
      ws.on('open', () => {
        opened = true;
        this.retry = 0;
        this.emit('open');
        resolve();
      });
      ws.on('message', (raw) => {
        try {
          this.emit('message', JSON.parse(raw));
        } catch {}
      });
      ws.on('unexpected-response', (_q, res) => {
        const e = Object.assign(new Error(res.statusCode === 403 ? 'Сервер комнат отказал в доступе.' : `Сервер комнат ответил ${res.statusCode}.`), { status: res.statusCode });
        res.resume?.();
        ws.terminate(); // с этим обработчиком ws сам соединение не закрывает
        if (!opened) reject(e);
        // доступ запрещён — переподключаться бессмысленно; временная ошибка сервера — попробуем снова
        if (res.statusCode === 401 || res.statusCode === 403) this.denied = true;
      });
      ws.on('error', (e) => {
        if (!opened) reject(e);
      });
      ws.on('close', (code) => {
        this.emit('close', code);
        if (opened) this.everOpened = true;
        // переподключаемся, только если связь уже была (первое подключение ошибку показывает само)
        if (this.closed || this.denied || !this.everOpened || code >= 4000) return;
        this.reconnect();
      });
    });
  }
  /**
   * Обрыв связи с сервером комнат — переподключение с паузой (1, 2, 4… до 30 с). Раньше после первой
   * неудачной попытки (сервер ещё недоступен) попытки прекращались, и комната навсегда оставалась
   * «переподключается».
   */
  reconnect() {
    if (this.retryTimer) return;
    const delay = Math.min(30000, 1000 * 2 ** this.retry++);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.closed) this.open().catch(() => {}); // неудача — снова сработает 'close' и следующая попытка
    }, delay);
    this.retryTimer.unref?.();
  }
  send(msg) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(msg));
  }
  close() {
    this.closed = true;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.ws?.close();
  }
}

/**
 * Хозяин. onGuest(name) → Promise<true | строка-причина отказа>: лаунчер добавляет игрока
 * в белый список сервера (online-mode проверит, что это его аккаунт Microsoft).
 */
class HostSession extends Emitter {
  constructor({ backend, transports, targetPort, onGuest }) {
    super();
    this.backend = backend.replace(/\/$/, '');
    this.transports = transports;
    this.targetPort = targetPort;
    this.onGuest = onGuest;
    this.guests = new Map(); // ticket → {name, status, routes:Set, streams}
  }

  async open({ name, manifest, hostName }) {
    try {
      const r = await api(this.backend + '/v1/rooms', { method: 'POST', json: { name, manifest, hostName } });
      this.roomId = r.roomId;
      this.secret = r.hostSecret;
    } catch (e) {
      throw friendly(e);
    }
    this.signal = new SignalChannel(`${wsUrl(this.backend)}/v1/signal?role=host&room=${encodeURIComponent(this.roomId)}`, this.secret);
    this.signal.on('message', (m) => this.onSignal(m));
    this.signal.on('close', () => this.emit('state', this.state('reconnecting')));
    this.signal.on('open', () => this.emit('state', this.state('online')));
    for (const t of this.transports) {
      t.start({ backend: this.backend, roomId: this.roomId, secret: this.secret, signal: (msg) => this.signal.send(msg) });
      t.on('stream', (stream, meta) => this.onStream(stream, meta));
      t.on('error', (e) => this.emit('warning', e.message));
    }
    await this.signal.open();
    return { roomId: this.roomId };
  }

  state(status) {
    return { status, roomId: this.roomId, guests: [...this.guests.entries()].map(([ticket, g]) => ({ ticket, name: g.name, status: g.status, routes: [...g.routes], streams: g.streams })) };
  }

  async onSignal(m) {
    if (m.type === 'guest-request') {
      if (!NAME_RE.test(m.name || '')) return this.signal.send({ type: 'guest-reject', ticket: m.ticket, reason: 'Некорректное имя.' });
      const g = this.guests.get(m.ticket) || { name: m.name, status: 'pending', routes: new Set(), streams: 0 };
      this.guests.set(m.ticket, g);
      let ok;
      // ник, под которым в сессии уже играет другой друг, второму не достаётся
      const twin = [...this.guests].find(([t, o]) => t !== m.ticket && o.status === 'accepted' && o.name.toLowerCase() === m.name.toLowerCase());
      if (twin) ok = 'Игрок с таким ником уже в сессии.';
      else {
        try {
          ok = await this.onGuest(m.name);
        } catch (e) {
          ok = e.message;
        }
      }
      if (ok === true) {
        g.status = 'accepted';
        this.signal.send({ type: 'guest-accept', ticket: m.ticket });
      } else {
        g.status = 'rejected';
        this.signal.send({ type: 'guest-reject', ticket: m.ticket, reason: typeof ok === 'string' ? ok : 'Хозяин не принял подключение.' });
      }
      this.emit('state', this.state('online'));
      return;
    }
    if (m.type === 'guest-left') {
      const g = this.guests.get(m.ticket);
      // отозванный или отклонённый гость остаётся с этим статусом
      if (g && g.status === 'accepted') g.status = 'left';
      this.emit('state', this.state('online'));
      return;
    }
    for (const t of this.transports) t.handle(m);
  }

  onStream(stream, meta) {
    const g = this.guests.get(meta.ticket);
    if (!g || g.status !== 'accepted') return stream.destroy();
    g.routes.add(meta.route);
    g.streams++;
    // Поток гостя направляется только на локальный сервер Minecraft; голосовой (с меткой) — в голосовой чат
    // в игру — только под ником, с которым друг принят (иначе мог бы зайти под ником хозяина)
    routeStream(stream, this.targetPort, (s) => this.emit('voice-stream', s, g.name), { name: g.name, onReject: (why) => this.emit('warning', `${g.name}: вход в игру отклонён — ${why}`) });
    stream.on('close', () => {
      g.streams--;
      this.emit('state', this.state('online'));
    });
    this.emit('state', this.state('online'));
  }

  async invite({ ttlMinutes = 60, maxUses = 4, allowedNames = [] } = {}) {
    try {
      return await api(`${this.backend}/v1/rooms/${this.roomId}/invites`, { method: 'POST', headers: { Authorization: 'Bearer ' + this.secret }, json: { ttlMinutes, maxUses, allowedNames } });
    } catch (e) {
      throw friendly(e);
    }
  }

  async invites() {
    return api(`${this.backend}/v1/rooms/${this.roomId}/invites`, { headers: { Authorization: 'Bearer ' + this.secret } });
  }

  /** Отзыв приглашения: гости по нему отключаются; вернёт имена, которых нужно убрать из белого списка. */
  async revoke(inviteId) {
    const r = await api(`${this.backend}/v1/rooms/${this.roomId}/invites/${inviteId}`, { method: 'DELETE', headers: { Authorization: 'Bearer ' + this.secret } });
    for (const [ticket, g] of this.guests) {
      if (r.revokedPlayers.includes(g.name)) {
        g.status = 'revoked';
        for (const t of this.transports) t.dropGuest(ticket);
      }
    }
    this.emit('state', this.state('online'));
    return r.revokedPlayers;
  }

  async updateManifest(manifest) {
    await api(`${this.backend}/v1/rooms/${this.roomId}`, { method: 'PUT', headers: { Authorization: 'Bearer ' + this.secret }, json: { manifest } });
  }

  async close() {
    for (const t of this.transports) t.stop();
    this.signal?.close();
    if (this.roomId) await api(`${this.backend}/v1/rooms/${this.roomId}`, { method: 'DELETE', headers: { Authorization: 'Bearer ' + this.secret } }).catch(() => {});
  }
}

/** Гость: проверка приглашения → ожидание допуска хозяином → транспорт → локальный порт для Minecraft. */
class GuestSession extends Emitter {
  constructor({ transports }) {
    super();
    this.transports = transports; // в порядке предпочтения: прямой путь, затем relay
  }

  async join(link, playerName) {
    const inv = parseInvite(link);
    this.backend = inv.server;
    try {
      this.info = await api(this.backend + '/v1/join', { method: 'POST', json: { roomId: inv.roomId, token: inv.token, playerName } });
    } catch (e) {
      throw friendly(e);
    }
    this.ticket = this.info.ticket;
    return { room: this.info.room, manifest: this.info.manifest };
  }

  async connect({ acceptTimeoutMs = 60000, directTimeoutMs = 12000 } = {}) {
    this.signal = new SignalChannel(`${wsUrl(this.backend)}/v1/signal?role=guest`, this.ticket);
    const accepted = new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(Object.assign(new Error('Хозяин не ответил на запрос подключения.'), { code: 'ACCEPT_TIMEOUT' })), acceptTimeoutMs);
      this.signal.on('message', (m) => {
        if (m.type === 'accepted') {
          clearTimeout(t);
          resolve();
        } else if (m.type === 'rejected') {
          clearTimeout(t);
          reject(Object.assign(new Error(m.reason || 'Хозяин не принял подключение.'), { code: 'REJECTED' }));
        } else if (m.type === 'revoked') {
          this.emit('revoked');
        } else if (m.type === 'host-offline') this.emit('host-offline');
        for (const tr of this.transports) tr.handle?.(m);
      });
    });
    await this.signal.open();
    this.emit('stage', 'waiting-host');
    await accepted;
    const errors = [];
    for (const tr of this.transports) {
      this.emit('stage', 'try-' + tr.name);
      try {
        await tr.connect({ backend: this.backend, ticket: this.ticket, iceServers: this.info.iceServers, signal: (msg) => this.signal.send(msg), timeoutMs: directTimeoutMs });
        this.transport = tr;
        break;
      } catch (e) {
        errors.push(`${tr.name}: ${e.message}`);
        tr.close();
      }
    }
    if (!this.transport) throw Object.assign(new Error('Не удалось установить соединение с хозяином. ' + errors.join('; ')), { code: 'NO_ROUTE' });
    this.listener = await localListener(() => this.transport.openStream(), { onError: (e) => this.emit('warning', e.message) });
    return { port: this.listener.port, route: this.transport.name };
  }

  /** Голосовой чат: отдельный поток к хозяину по тому же соединению. */
  async openVoice(name) {
    if (!this.transport) throw new Error('Сначала подключись к сессии.');
    return new VoiceClient(await this.transport.openStream(), name);
  }

  async close() {
    await this.listener?.close();
    this.transport?.close();
    this.signal?.close();
  }
}

module.exports = { HostSession, GuestSession, parseInvite, SignalChannel };
