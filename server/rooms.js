'use strict';
// Комнаты и приглашения. Сервер хранит только хеши секретов; сам мир и сервер Minecraft — на ПК хозяина.
const crypto = require('crypto');

const b64 = (n) => crypto.randomBytes(n).toString('base64url');
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const NAME_RE = /^[A-Za-z0-9_]{3,16}$/;

function safeEqual(a, b) {
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

class RoomRegistry {
  constructor({ now = () => Date.now(), maxRooms = 5000, roomTtlMs = 24 * 3600 * 1000 } = {}) {
    this.rooms = new Map();
    this.tickets = new Map(); // ticket → {roomId, name, inviteId, expiresAt, accepted}
    this.now = now;
    this.maxRooms = maxRooms;
    this.roomTtlMs = roomTtlMs;
  }

  /** Комната создаётся хозяином; hostSecret возвращается один раз и нужен для управления. */
  create({ name, manifest, hostName }) {
    this.gc();
    if (this.rooms.size >= this.maxRooms) throw httpError(503, 'Сервер перегружен, попробуй позже.');
    if (!NAME_RE.test(hostName || '')) throw httpError(400, 'Некорректное имя хозяина.');
    const id = b64(12);
    const hostSecret = b64(32);
    const room = {
      id,
      secretHash: sha(hostSecret),
      name: String(name || 'Мир').slice(0, 60),
      hostName,
      manifest: checkManifest(manifest),
      invites: new Map(),
      createdAt: this.now(),
      lastSeen: this.now(),
      hostOnline: false,
    };
    this.rooms.set(id, room);
    return { roomId: id, hostSecret };
  }

  authHost(roomId, secret) {
    const room = this.rooms.get(String(roomId));
    if (!room || !secret || !safeEqual(sha(secret), room.secretHash)) throw httpError(403, 'Нет доступа к комнате.');
    room.lastSeen = this.now();
    return room;
  }

  update(roomId, secret, { name, manifest }) {
    const room = this.authHost(roomId, secret);
    if (name !== undefined) room.name = String(name).slice(0, 60);
    if (manifest !== undefined) room.manifest = checkManifest(manifest);
    return room;
  }

  close(roomId, secret) {
    const room = this.authHost(roomId, secret);
    this.rooms.delete(room.id);
    for (const [t, g] of this.tickets) if (g.roomId === room.id) this.tickets.delete(t);
  }

  /**
   * Приглашение: непредсказуемый токен (256 бит), срок действия, лимит входов, необязательный список имён.
   * Возвращается один раз; хранится только хеш.
   */
  invite(roomId, secret, { ttlMinutes = 60, maxUses = 4, allowedNames = [] } = {}) {
    const room = this.authHost(roomId, secret);
    ttlMinutes = Math.max(5, Math.min(7 * 24 * 60, Number(ttlMinutes) || 60));
    maxUses = Math.max(1, Math.min(20, Number(maxUses) || 4));
    const names = (allowedNames || []).filter((n) => NAME_RE.test(n)).map((n) => n.toLowerCase());
    if (room.invites.size >= 50) throw httpError(429, 'Слишком много приглашений — отзови старые.');
    const inviteId = b64(6);
    const token = b64(32);
    const inv = { id: inviteId, tokenHash: sha(token), expiresAt: this.now() + ttlMinutes * 60000, maxUses, uses: 0, revoked: false, allowedNames: names, createdAt: this.now() };
    room.invites.set(inviteId, inv);
    return { inviteId, token, expiresAt: inv.expiresAt, maxUses };
  }

  listInvites(roomId, secret) {
    const room = this.authHost(roomId, secret);
    return [...room.invites.values()].map((i) => ({ id: i.id, expiresAt: i.expiresAt, maxUses: i.maxUses, uses: i.uses, revoked: i.revoked, allowedNames: i.allowedNames, expired: i.expiresAt < this.now() }));
  }

  /** Отзыв: приглашение больше не работает, уже выданные по нему билеты аннулируются. */
  revoke(roomId, secret, inviteId) {
    const room = this.authHost(roomId, secret);
    const inv = room.invites.get(inviteId);
    if (!inv) throw httpError(404, 'Приглашение не найдено.');
    inv.revoked = true;
    const revokedTickets = [];
    for (const [t, g] of this.tickets) {
      if (g.roomId === room.id && g.inviteId === inviteId) {
        this.tickets.delete(t);
        revokedTickets.push({ ticket: t, name: g.name });
      }
    }
    return revokedTickets;
  }

  /** Гость предъявляет токен приглашения. Проверки: срок, отзыв, лимит, имя, хозяин в сети. */
  join({ roomId, token, playerName }) {
    const room = this.rooms.get(String(roomId));
    if (!room || !token) throw httpError(404, 'Приглашение недействительно.');
    if (!NAME_RE.test(playerName || '')) throw httpError(400, 'Некорректное имя игрока.');
    const h = sha(token);
    const inv = [...room.invites.values()].find((i) => safeEqual(i.tokenHash, h));
    if (!inv) throw httpError(404, 'Приглашение недействительно.');
    if (inv.revoked) throw httpError(410, 'Хозяин отозвал это приглашение.');
    if (inv.expiresAt < this.now()) throw httpError(410, 'Срок действия приглашения истёк. Попроси новое.');
    if (inv.uses >= inv.maxUses) throw httpError(410, 'По этому приглашению уже вошли все участники.');
    if (inv.allowedNames.length && !inv.allowedNames.includes(playerName.toLowerCase()))
      throw httpError(403, 'Это приглашение выдано другому игроку.');
    if (!room.hostOnline) throw httpError(409, 'Хозяин сейчас не в сети: мир доступен, только пока у него запущен easyLauncher и сервер.');
    const ticket = b64(24);
    this.tickets.set(ticket, { roomId: room.id, name: playerName, inviteId: inv.id, expiresAt: this.now() + 12 * 3600 * 1000, accepted: false });
    return { ticket, room: { name: room.name, hostName: room.hostName }, manifest: room.manifest };
  }

  ticket(t) {
    const g = this.tickets.get(String(t));
    if (!g || g.expiresAt < this.now()) throw httpError(403, 'Билет гостя недействителен.');
    if (!this.rooms.has(g.roomId)) throw httpError(410, 'Комната закрыта.');
    return g;
  }

  /** Лимит расходуется только после решения хозяина, а не на просмотр ссылки или отказ. */
  accept(t) {
    const g = this.ticket(t);
    if (g.accepted) return g;
    const room = this.rooms.get(g.roomId);
    const inv = room?.invites.get(g.inviteId);
    if (!inv || inv.revoked || inv.expiresAt < this.now()) throw httpError(410, 'Приглашение больше не действует.');
    if (inv.uses >= inv.maxUses) throw httpError(410, 'По этому приглашению уже вошли все участники.');
    inv.uses++;
    g.accepted = true;
    return g;
  }

  gc() {
    const t = this.now();
    for (const [id, r] of this.rooms) if (!r.hostOnline && t - r.lastSeen > this.roomTtlMs) this.rooms.delete(id);
    for (const [k, g] of this.tickets) if (g.expiresAt < t) this.tickets.delete(k);
  }
}

function checkManifest(m) {
  if (!m || m.format !== 'easylauncher.room-manifest/1' || !m.room || !Array.isArray(m.mods)) throw httpError(400, 'Некорректный манифест комнаты.');
  if (JSON.stringify(m).length > 512 * 1024) throw httpError(413, 'Манифест слишком большой.');
  return m;
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

module.exports = { RoomRegistry, httpError };
