'use strict';
// Игра с друзьями через Epic Online Services — без своего сервера комнат.
// Хозяин входит в EOS по устройству; его идентификатор и токен приглашения — в ссылке
// easylauncher://join?e=<id хозяина>&t=<токен>. Гость открывает P2P-связь с хозяином (напрямую или
// через ретранслятор Epic), показывает токен, получает сборку комнаты и после допуска играет:
// его Minecraft подключается к 127.0.0.1:<порт>, а поток идёт по P2P прямо на сервер хозяина.
// Приглашения (срок, число игроков, ники, отзыв) хранит и проверяет сам хозяин.
const crypto = require('crypto');
const { PeerLink } = require('./mux');
const { localListener, Emitter } = require('../transport');
const { routeStream, VoiceClient } = require('../voice');

const NAME_RE = /^[A-Za-z0-9_]{3,16}$/;
const PUID_RE = /^[0-9a-f]{32}$/;
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const safeEqual = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Подписка на события платформы, которую сессия снимает при закрытии (платформа общая на лаунчер). */
function listen(platform, handlers) {
  for (const [ev, fn] of Object.entries(handlers)) platform.on(ev, fn);
  return () => {
    for (const [ev, fn] of Object.entries(handlers)) platform.off(ev, fn);
  };
}

/** Хозяин. onGuest(name) → true | строка-причина отказа (лаунчер добавляет ник в белый список сервера). */
class EosHostSession extends Emitter {
  constructor({ platform, targetPort, onGuest, now = () => Date.now(), helloTimeoutMs = 30000 }) {
    super();
    this.platform = platform;
    this.targetPort = targetPort;
    this.onGuest = onGuest;
    this.now = now;
    this.helloTimeoutMs = helloTimeoutMs;
    this.invitesMap = new Map(); // id → {id, tokenHash, expiresAt, maxUses, uses, revoked, allowedNames}
    this.peers = new Map(); // id игрока EOS → {link, guest, timer}
    this.guests = new Map(); // id игрока EOS → {name, status, inviteId, routes:Set, streams}
    this.routes = new Map(); // id игрока EOS → маршрут соединения ('eos-direct' | 'eos-relay')
  }

  async open({ name, manifest, hostName }) {
    this.roomId = await this.platform.start();
    this.room = { name, hostName };
    this.manifest = manifest;
    this.off = listen(this.platform, {
      request: (peer) => this.platform.accept(peer),
      packet: (peer, ch, buf) => this.peer(peer).link.onPacket(ch, buf),
      // соединение устанавливается раньше, чем игрок покажет приглашение, — маршрут запоминаем сразу
      established: (peer, route) => {
        this.routes.set(peer, route);
        const g = this.guests.get(peer);
        if (g) {
          g.routes.add(route);
          this.emit('state', this.state('online'));
        }
      },
      closed: (peer) => this.drop(peer, 'left'),
      relogin: () => this.emit('state', this.state('online')),
    });
    return { roomId: this.roomId };
  }

  /** Связь с игроком: создаётся при первом пакете; без верного приглашения закрывается через helloTimeoutMs. */
  peer(id) {
    let p = this.peers.get(id);
    if (p) return p;
    // связь открыть может любой, кто знает номер хозяина из ссылки: пока не показал приглашение — не больше
    // 32 таких одновременно (остальным — отказ), и служебные сообщения от них короткие (hello/join/bye)
    const strangers = [...this.peers.keys()].filter((k) => !this.guests.has(k)).length;
    if (strangers >= 32 && !this.guests.has(id)) {
      this.platform.close(id);
      return { link: { onPacket() {} }, stranger: true };
    }
    const link = new PeerLink((ch, buf) => this.platform.send(id, ch, buf), { maxControl: 64 * 1024 });
    p = { link, timer: setTimeout(() => !this.guests.has(id) && this.drop(id), this.helloTimeoutMs) };
    p.timer.unref?.();
    this.peers.set(id, p);
    link.on('control', (m) => this.onControl(id, m).catch((e) => this.emit('warning', e.message)));
    link.on('stream', (s) => this.onStream(id, s));
    return p;
  }

  async onControl(id, m) {
    const p = this.peers.get(id);
    if (!p) return;
    if (m.t === 'hello') {
      const deny = (reason) => p.link.control({ t: 'deny', reason });
      if (!NAME_RE.test(m.name || '')) return deny('Некорректный ник.');
      const h = sha(m.token || '');
      const inv = [...this.invitesMap.values()].find((i) => safeEqual(i.tokenHash, h));
      if (!inv) return deny('Приглашение не найдено: попроси у друга новую ссылку.');
      if (inv.revoked) return deny('Это приглашение отозвано.');
      if (inv.expiresAt < this.now()) return deny('Срок действия приглашения истёк. Попроси новое.');
      if (inv.allowedNames.length && !inv.allowedNames.some((n) => n.toLowerCase() === m.name.toLowerCase())) return deny('Это приглашение не для этого ника.');
      const known = this.guests.get(id);
      // Место расходуется после допуска хозяином; просмотр сборки и отказ лимит не тратят.
      if (!(known && known.inviteId === inv.id && known.name === m.name)) {
        if (inv.uses >= inv.maxUses) return deny('По этому приглашению уже вошли все участники.');
        this.guests.set(id, { name: m.name, status: 'checking', inviteId: inv.id, counted: false, routes: new Set([...(known?.routes || []), ...(this.routes.has(id) ? [this.routes.get(id)] : [])]), streams: 0 });
      }
      clearTimeout(p.timer);
      p.link.control({ t: 'room', room: this.room, manifest: this.manifest });
      this.emit('state', this.state('online'));
      return;
    }
    const g = this.guests.get(id);
    if (!g || g.status === 'revoked') return;
    if (m.t === 'join') {
      g.status = 'pending';
      this.emit('state', this.state('online'));
      let ok;
      // ник, под которым в сессии уже играет другой подключённый друг, второму не достаётся
      const twin = [...this.guests].find(([pid, o]) => pid !== id && o.status === 'accepted' && this.peers.has(pid) && o.name.toLowerCase() === g.name.toLowerCase());
      if (twin) ok = 'Игрок с таким ником уже в сессии.';
      else {
        try {
          ok = await this.onGuest(g.name);
        } catch (e) {
          ok = e.message;
        }
      }
      if (ok === true && !g.counted) {
        const inv = this.invitesMap.get(g.inviteId);
        if (!inv || inv.revoked || inv.expiresAt < this.now()) ok = 'Приглашение больше не действует.';
        else if (inv.uses >= inv.maxUses) ok = 'По этому приглашению уже вошли все участники.';
        else {
          inv.uses++;
          g.counted = true;
        }
      }
      g.status = ok === true ? 'accepted' : 'rejected';
      p.link.control(ok === true ? { t: 'accepted' } : { t: 'rejected', reason: typeof ok === 'string' ? ok : 'Хозяин не принял подключение.' });
      this.emit('state', this.state('online'));
    } else if (m.t === 'bye') this.drop(id, 'left');
  }

  onStream(id, stream) {
    const g = this.guests.get(id);
    if (!g || g.status !== 'accepted') return stream.destroy();
    // поток гостя ведёт только на сервер Minecraft этого ПК — адрес и порт выбирает хозяин;
    // голосовой поток (с меткой) — в голосовой чат хозяина
    // в игру — только под ником, с которым друг принят (иначе мог бы зайти под ником хозяина)
    routeStream(stream, this.targetPort, (s) => this.emit('voice-stream', s, g.name), { name: g.name, onReject: (why) => this.emit('warning', `${g.name}: вход в игру отклонён — ${why}`) });
    g.streams++;
    stream.on('close', () => {
      g.streams--;
      this.emit('state', this.state('online'));
    });
    this.emit('state', this.state('online'));
  }

  drop(id, status = null) {
    const p = this.peers.get(id);
    if (p) {
      clearTimeout(p.timer);
      p.link.close();
      this.peers.delete(id);
    }
    const g = this.guests.get(id);
    if (g && status && g.status === 'accepted') g.status = status;
    this.emit('state', this.state('online'));
  }

  state(status) {
    return { status, roomId: this.roomId, via: 'eos', guests: [...this.guests.entries()].map(([ticket, g]) => ({ ticket, name: g.name, status: g.status, routes: [...g.routes], streams: g.streams })) };
  }

  async invite({ ttlMinutes = 60, maxUses = 4, allowedNames = [] } = {}) {
    if (this.invitesMap.size >= 50) throw new Error('Слишком много приглашений — отзови старые.');
    const ttl = Math.max(5, Math.min(7 * 24 * 60, Number(ttlMinutes) || 60));
    const max = Math.max(1, Math.min(20, Number(maxUses) || 4));
    const names = (allowedNames || []).map((n) => String(n).trim()).filter((n) => NAME_RE.test(n)).slice(0, 20);
    const token = crypto.randomBytes(24).toString('base64url');
    const inv = { id: crypto.randomBytes(6).toString('base64url'), tokenHash: sha(token), expiresAt: this.now() + ttl * 60000, maxUses: max, uses: 0, revoked: false, allowedNames: names };
    this.invitesMap.set(inv.id, inv);
    return { inviteId: inv.id, token, expiresAt: inv.expiresAt, maxUses: max, link: `easylauncher://join?e=${this.roomId}&t=${token}` };
  }

  async invites() {
    return [...this.invitesMap.values()].map((i) => ({ id: i.id, expiresAt: i.expiresAt, maxUses: i.maxUses, uses: i.uses, revoked: i.revoked, allowedNames: i.allowedNames, expired: i.expiresAt < this.now() }));
  }

  /** Отзыв: гости по этому приглашению отключаются; вернёт ники для удаления из белого списка. */
  async revoke(inviteId) {
    const inv = this.invitesMap.get(inviteId);
    if (!inv) throw new Error('Приглашение не найдено.');
    inv.revoked = true;
    const names = [];
    for (const [id, g] of this.guests) {
      if (g.inviteId !== inviteId) continue;
      g.status = 'revoked';
      names.push(g.name);
      this.peers.get(id)?.link.control({ t: 'revoked' });
      setTimeout(() => {
        this.drop(id);
        this.platform.close(id);
      }, 300);
    }
    this.emit('state', this.state('online'));
    return names;
  }

  async updateManifest(manifest) {
    this.manifest = manifest;
  }

  async close() {
    for (const [id, p] of this.peers) {
      p.link.control({ t: 'bye' });
      setTimeout(() => this.platform.close(id), 300);
      clearTimeout(p.timer);
    }
    await new Promise((r) => setTimeout(r, 350));
    for (const p of this.peers.values()) p.link.close();
    this.peers.clear();
    this.off?.();
  }
}

/** Гость: приглашение → сборка комнаты → допуск хозяином → локальный порт для Minecraft. */
class EosGuestSession extends Emitter {
  constructor({ platform, replyTimeoutMs = 45000 }) {
    super();
    this.platform = platform;
    this.replyTimeoutMs = replyTimeoutMs;
    this.route = null;
  }

  wait(types, ms, timeoutMessage) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.link.off('control', on);
        reject(Object.assign(new Error(timeoutMessage), { code: 'NO_REPLY' }));
      }, ms);
      const on = (m) => {
        if (!types.includes(m.t)) return;
        clearTimeout(t);
        this.link.off('control', on);
        resolve(m);
      };
      this.link.on('control', on);
    });
  }

  async join(inv, playerName) {
    const me = await this.platform.start();
    if (inv.host === me) throw new Error('Это приглашение с этого же компьютера — открой его на компьютере друга.');
    this.host = inv.host;
    this.link = new PeerLink((ch, buf) => this.platform.send(this.host, ch, buf), { initiator: true });
    this.link.on('control', (m) => {
      if (m.t === 'revoked') this.emit('revoked');
      else if (m.t === 'bye') this.emit('host-offline');
    });
    this.off = listen(this.platform, {
      packet: (peer, ch, buf) => peer === this.host && this.link.onPacket(ch, buf),
      established: (peer, route) => {
        if (peer !== this.host) return;
        this.route = route;
        this.emit('route', route);
      },
      closed: (peer) => {
        if (peer !== this.host) return;
        this.link.close();
        this.emit('host-offline');
      },
    });
    const reply = this.wait(['room', 'deny'], this.replyTimeoutMs, 'Хозяин не отвечает: возможно, сессия уже закончилась или его компьютер не в сети. Попроси новую ссылку.');
    this.link.control({ t: 'hello', v: 1, token: inv.token, name: playerName });
    try {
      const m = await reply;
      if (m.t === 'deny') throw Object.assign(new Error(m.reason || 'Хозяин не принял приглашение.'), { code: 'DENIED' });
      return { room: m.room, manifest: m.manifest };
    } catch (e) {
      await this.close().catch(() => {});
      throw e;
    }
  }

  async connect({ acceptTimeoutMs = 60000 } = {}) {
    this.emit('stage', 'waiting-host');
    const answer = this.wait(['accepted', 'rejected'], acceptTimeoutMs, 'Хозяин не ответил на запрос подключения.');
    this.link.control({ t: 'join' });
    const m = await answer;
    if (m.t === 'rejected') throw Object.assign(new Error(m.reason || 'Хозяин не принял подключение.'), { code: 'REJECTED' });
    this.listener = await localListener(async () => this.link.openStream(), { onError: (e) => this.emit('warning', e.message) });
    return { port: this.listener.port, route: this.route || 'eos' };
  }

  /** Голосовой чат: отдельный поток к хозяину по тому же соединению EOS. */
  async openVoice(name) {
    if (!this.link || this.closed) throw new Error('Сначала подключись к сессии.');
    return new VoiceClient(await this.link.openStream(), name);
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.listener?.close();
    if (this.link && !this.link.closed) {
      this.link.control({ t: 'bye' });
      await new Promise((r) => setTimeout(r, 200));
      this.link.close();
    }
    if (this.host) this.platform.close(this.host);
    this.off?.();
  }
}

module.exports = { EosHostSession, EosGuestSession, PUID_RE };
