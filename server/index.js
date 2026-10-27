'use strict';
// Сервер easyLauncher: комнаты и приглашения, сигналинг для прямого соединения,
// запасной relay (TCP поверх WebSocket) и прокси CurseForge API.
//
// Переменные окружения:
//   PORT            порт (по умолчанию 8787)
//   PUBLIC_URL      внешний адрес сервера, например https://rooms.example.com
//   CF_API_KEY      ключ CurseForge for Studios (хранится только здесь)
//   STUN_URLS       через запятую, по умолчанию stun:stun.l.google.com:19302
//   TURN_URLS       через запятую, например turn:turn.example.com:3478?transport=udp
//   TURN_SECRET     общий секрет coturn (use-auth-secret) для временных учётных данных
//   RELAY_MAX_CONNS лимит одновременных relay-соединений на комнату (64)
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { RoomRegistry, httpError } = require('./rooms');

/** Файл .env рядом с сервером: КЛЮЧ=значение. Переменные окружения важнее файла. */
function loadEnv(file = path.join(__dirname, '.env')) {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    const v = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

const CF_PATHS = [/^\/v1\/mods\/search$/, /^\/v1\/mods\/\d+$/, /^\/v1\/mods\/\d+\/files$/, /^\/v1\/mods\/\d+\/files\/\d+$/, /^\/v1\/categories$/];

function createServer(cfg = {}) {
  const config = {
    port: Number(cfg.port ?? process.env.PORT ?? 8787),
    // на Render внешний адрес приходит сам (RENDER_EXTERNAL_URL) — вписывать PUBLIC_URL вручную не нужно
    publicUrl: cfg.publicUrl ?? process.env.PUBLIC_URL ?? process.env.RENDER_EXTERNAL_URL ?? '',
    cfApiKey: cfg.cfApiKey ?? process.env.CF_API_KEY ?? '',
    cfBase: cfg.cfBase ?? 'https://api.curseforge.com',
    stun: (cfg.stun ?? process.env.STUN_URLS ?? 'stun:stun.l.google.com:19302').split(',').filter(Boolean),
    turn: (cfg.turn ?? process.env.TURN_URLS ?? '').split(',').filter(Boolean),
    turnSecret: cfg.turnSecret ?? process.env.TURN_SECRET ?? '',
    relayMax: Number(cfg.relayMax ?? process.env.RELAY_MAX_CONNS ?? 64),
    fetch: cfg.fetch || globalThis.fetch,
  };
  const rooms = new RoomRegistry(cfg.registry || {});
  const hosts = new Map(); // roomId → ws хозяина
  const guests = new Map(); // ticket → ws гостя
  const relayWaiting = new Map(); // `${ticket}|${conn}` → {ws, timer}
  const relayCount = new Map(); // roomId → активные relay-пары
  const stats = { relayBytes: 0, relayPairs: 0 };
  const cfCache = new Map();
  const limits = new Map();

  function limited(ip, bucket, perMinute) {
    const k = bucket + '|' + ip;
    const t = Date.now();
    const e = limits.get(k) || { n: 0, reset: t + 60000 };
    if (t > e.reset) {
      e.n = 0;
      e.reset = t + 60000;
    }
    e.n++;
    limits.set(k, e);
    return e.n > perMinute;
  }

  function send(ws, msg) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
  }

  function iceServers(ticket) {
    const list = config.stun.length ? [{ urls: config.stun }] : [];
    if (config.turn.length && config.turnSecret) {
      // Временные учётные данные TURN (coturn REST API): действуют 12 часов
      const username = `${Math.floor(Date.now() / 1000) + 12 * 3600}:${ticket.slice(0, 16)}`;
      const credential = crypto.createHmac('sha1', config.turnSecret).update(username).digest('base64');
      list.push({ urls: config.turn, username, credential });
    }
    return list;
  }

  async function body(req, limit = 600 * 1024) {
    let size = 0;
    const chunks = [];
    for await (const c of req) {
      size += c.length;
      if (size > limit) throw httpError(413, 'Слишком большой запрос.');
      chunks.push(c);
    }
    if (!chunks.length) return {};
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw httpError(400, 'Некорректный JSON.');
    }
  }

  function bearer(req) {
    const h = req.headers.authorization || '';
    return h.startsWith('Bearer ') ? h.slice(7) : '';
  }

  async function cfProxy(req, res, u) {
    const p = u.pathname.slice(3);
    if (req.method !== 'GET' || !CF_PATHS.some((re) => re.test(p))) throw httpError(404, 'Не поддерживается.');
    if (!config.cfApiKey) throw httpError(503, 'CurseForge не настроен на этом сервере.');
    const key = p + u.search;
    const hit = cfCache.get(key);
    if (hit && hit.until > Date.now()) return reply(res, 200, hit.data, true);
    const r = await config.fetch(config.cfBase + key, { headers: { 'x-api-key': config.cfApiKey, Accept: 'application/json' } });
    const text = await r.text();
    if (!r.ok) {
      res.writeHead(r.status === 403 ? 502 : r.status, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'upstream', status: r.status }));
    }
    cfCache.set(key, { data: text, until: Date.now() + 5 * 60 * 1000 });
    if (cfCache.size > 5000) cfCache.delete(cfCache.keys().next().value);
    reply(res, 200, text, true);
  }

  function reply(res, code, data, raw = false) {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(raw ? data : JSON.stringify(data));
  }

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://local');
    const ip = req.socket.remoteAddress;
    try {
      if (limited(ip, 'all', 600)) throw httpError(429, 'Слишком много запросов.');
      if (u.pathname.startsWith('/cf/')) {
        if (limited(ip, 'cf', 120)) throw httpError(429, 'Слишком много запросов к каталогу.');
        return await cfProxy(req, res, u);
      }
      let m;
      if (req.method === 'GET' && u.pathname === '/v1/health') return reply(res, 200, { ok: true, curseforge: !!config.cfApiKey, turn: !!(config.turn.length && config.turnSecret) });
      if (req.method === 'POST' && u.pathname === '/v1/rooms') {
        if (limited(ip, 'create', 20)) throw httpError(429, 'Слишком много комнат.');
        const b = await body(req);
        return reply(res, 201, rooms.create(b));
      }
      if ((m = u.pathname.match(/^\/v1\/rooms\/([\w-]+)$/))) {
        if (req.method === 'PUT') {
          rooms.update(m[1], bearer(req), await body(req));
          return reply(res, 200, { ok: true });
        }
        if (req.method === 'DELETE') {
          rooms.close(m[1], bearer(req));
          return reply(res, 200, { ok: true });
        }
      }
      if ((m = u.pathname.match(/^\/v1\/rooms\/([\w-]+)\/invites$/))) {
        if (req.method === 'POST') {
          const inv = rooms.invite(m[1], bearer(req), await body(req));
          const base = config.publicUrl || `http://${req.headers.host}`;
          const link = `easylauncher://join?s=${encodeURIComponent(base)}&r=${encodeURIComponent(m[1])}&t=${encodeURIComponent(inv.token)}`;
          return reply(res, 201, { ...inv, link });
        }
        if (req.method === 'GET') return reply(res, 200, rooms.listInvites(m[1], bearer(req)));
      }
      if ((m = u.pathname.match(/^\/v1\/rooms\/([\w-]+)\/invites\/([\w-]+)$/)) && req.method === 'DELETE') {
        const revoked = rooms.revoke(m[1], bearer(req), m[2]);
        for (const r of revoked) {
          send(guests.get(r.ticket), { type: 'revoked' });
          guests.get(r.ticket)?.close(4003, 'revoked');
        }
        return reply(res, 200, { revokedPlayers: revoked.map((r) => r.name) });
      }
      if (req.method === 'POST' && u.pathname === '/v1/join') {
        if (limited(ip, 'join', 30)) throw httpError(429, 'Слишком много попыток входа.');
        const r = rooms.join(await body(req));
        return reply(res, 200, { ...r, iceServers: iceServers(r.ticket) });
      }
      throw httpError(404, 'Не найдено.');
    } catch (e) {
      reply(res, e.status || 500, { error: e.status ? e.message : 'Внутренняя ошибка сервера.' });
    }
  });

  // ---------- WebSocket: сигналинг и relay ----------
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    const u = new URL(req.url, 'http://local');
    try {
      let ctx;
      if (u.pathname === '/v1/signal') {
        if (u.searchParams.get('role') === 'host') {
          const room = rooms.authHost(u.searchParams.get('room'), bearer(req));
          ctx = { kind: 'signal-host', room };
        } else {
          const ticket = bearer(req);
          ctx = { kind: 'signal-guest', ticket, guest: rooms.ticket(ticket) };
        }
      } else if (u.pathname === '/v1/relay') {
        const conn = u.searchParams.get('conn') || '';
        if (!/^[\w-]{6,40}$/.test(conn)) throw httpError(400, 'conn');
        const ticket = u.searchParams.get('ticket') || '';
        if (u.searchParams.get('role') === 'host') {
          const room = rooms.authHost(u.searchParams.get('room'), bearer(req));
          const g = rooms.ticket(ticket);
          if (g.roomId !== room.id) throw httpError(403, 'Чужой билет.');
          ctx = { kind: 'relay-host', room, ticket, conn };
        } else {
          const g = rooms.ticket(bearer(req));
          if (!g.accepted) throw httpError(403, 'Хозяин ещё не принял гостя.');
          ctx = { kind: 'relay-guest', ticket: bearer(req), guest: g, conn };
        }
      } else throw httpError(404, 'Не найдено.');
      wss.handleUpgrade(req, socket, head, (ws) => onSocket(ws, ctx));
    } catch (e) {
      socket.write(`HTTP/1.1 ${e.status || 400} Rejected\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    }
  });

  function onSocket(ws, ctx) {
    if (ctx.kind === 'signal-host') {
      const room = ctx.room;
      hosts.get(room.id)?.close(4000, 'replaced');
      hosts.set(room.id, ws);
      room.hostOnline = true;
      ws.on('message', (raw) => {
        let msg;
        try {
          msg = JSON.parse(raw);
        } catch {
          return;
        }
        const g = rooms.tickets.get(msg.ticket);
        if (!g || g.roomId !== room.id) return;
        const gws = guests.get(msg.ticket);
        if (msg.type === 'guest-accept') {
          g.accepted = true;
          send(gws, { type: 'accepted' });
        } else if (msg.type === 'guest-reject') {
          send(gws, { type: 'rejected', reason: String(msg.reason || '').slice(0, 200) });
          rooms.tickets.delete(msg.ticket);
          gws?.close(4003, 'rejected');
        } else if (msg.type === 'rtc' && g.accepted) send(gws, { type: 'rtc', data: msg.data });
      });
      ws.on('close', () => {
        if (hosts.get(room.id) === ws) {
          hosts.delete(room.id);
          room.hostOnline = false;
          room.lastSeen = Date.now();
          for (const [t, g] of rooms.tickets) if (g.roomId === room.id) send(guests.get(t), { type: 'host-offline' });
        }
      });
      // гости, ожидавшие хозяина
      for (const [t, g] of rooms.tickets) if (g.roomId === room.id && guests.has(t)) send(ws, { type: 'guest-request', ticket: t, name: g.name });
      return;
    }
    if (ctx.kind === 'signal-guest') {
      const { ticket, guest } = ctx;
      guests.get(ticket)?.close(4000, 'replaced');
      guests.set(ticket, ws);
      send(hosts.get(guest.roomId), { type: 'guest-request', ticket, name: guest.name });
      if (guest.accepted) send(ws, { type: 'accepted' });
      ws.on('message', (raw) => {
        let msg;
        try {
          msg = JSON.parse(raw);
        } catch {
          return;
        }
        if (msg.type === 'rtc' && guest.accepted) send(hosts.get(guest.roomId), { type: 'rtc', ticket, data: msg.data });
      });
      ws.on('close', () => {
        if (guests.get(ticket) === ws) {
          guests.delete(ticket);
          send(hosts.get(guest.roomId), { type: 'guest-left', ticket });
        }
      });
      return;
    }
    // ---------- relay: пара сокетов гость ↔ хозяин по (ticket, conn) ----------
    const pairKey = ctx.ticket + '|' + ctx.conn;
    if (ctx.kind === 'relay-guest') {
      const roomId = ctx.guest.roomId;
      if ((relayCount.get(roomId) || 0) >= config.relayMax) return ws.close(4029, 'too many connections');
      const host = hosts.get(roomId);
      if (!host) return ws.close(4004, 'host offline');
      // до образования пары данные гостя не читаем — иначе первые байты (рукопожатие Minecraft) потеряются
      ws.pause();
      const timer = setTimeout(() => {
        relayWaiting.delete(pairKey);
        ws.close(4008, 'host did not answer');
      }, 15000);
      relayWaiting.set(pairKey, { ws, timer, roomId });
      ws.on('close', () => {
        const w = relayWaiting.get(pairKey);
        if (w?.ws === ws) {
          clearTimeout(w.timer);
          relayWaiting.delete(pairKey);
        }
      });
      send(host, { type: 'relay-open', ticket: ctx.ticket, conn: ctx.conn });
      return;
    }
    if (ctx.kind === 'relay-host') {
      const w = relayWaiting.get(pairKey);
      if (!w) return ws.close(4004, 'no guest');
      clearTimeout(w.timer);
      relayWaiting.delete(pairKey);
      pipe(w.ws, ws, w.roomId);
    }
  }

  function pipe(a, b, roomId) {
    relayCount.set(roomId, (relayCount.get(roomId) || 0) + 1);
    stats.relayPairs++;
    let closed = false;
    const fwd = (from, to) =>
      from.on('message', (data, isBinary) => {
        if (!isBinary) return; // только игровой трафик
        stats.relayBytes += data.length;
        if (to.readyState !== 1) return;
        // обратное давление: не копим больше 4 МБ на соединение, продолжаем после отправки
        to.send(data, { binary: true }, () => {
          if (from.isPaused && to.bufferedAmount < 1024 * 1024) from.resume();
        });
        if (to.bufferedAmount > 4 * 1024 * 1024) from.pause();
      });
    fwd(a, b);
    fwd(b, a);
    a.resume();
    const end = () => {
      if (closed) return;
      closed = true;
      relayCount.set(roomId, Math.max(0, (relayCount.get(roomId) || 1) - 1));
      a.close();
      b.close();
    };
    a.on('close', end);
    b.on('close', end);
    a.on('error', end);
    b.on('error', end);
  }

  return {
    server,
    rooms,
    stats,
    config,
    listen: (port = config.port, host = '0.0.0.0') => new Promise((r) => server.listen(port, host, () => r(server.address().port))),
    close: () =>
      new Promise((r) => {
        for (const c of wss.clients) c.terminate();
        server.close(() => r());
      }),
  };
}

if (require.main === module) {
  loadEnv();
  const s = createServer();
  s.listen().then((port) => console.log(`easyLauncher server on :${port}${s.config.cfApiKey ? ' (CurseForge proxy on)' : ''}`));
}

module.exports = { createServer, loadEnv };
