'use strict';
// Контракт сетевого транспорта. Интерфейс и оркестратор работают только с ним,
// поэтому relay, WebRTC или EOS заменяются без изменений остального кода.
//
// HostTransport (на ПК хозяина):
//   name                         'relay' | 'direct' | ...
//   start(ctx)                   ctx: {backend, roomId, secret, signal(msg)}
//   handle(msg)                  служебное сообщение от сервера комнат (relay-open, rtc, ...)
//   dropGuest(ticket)            отключить все потоки гостя
//   stop()
//   событие 'stream' (duplex, {ticket})  — новый игровой поток от гостя
//
// GuestTransport (на ПК друга):
//   name
//   connect(ctx)  → Promise      ctx: {backend, ticket, iceServers, signal(msg), timeoutMs}
//   handle(msg)                  служебные сообщения (rtc, ...)
//   openStream() → Promise<Duplex>  новый поток к игровому серверу хозяина
//   close()
//
// Хозяин всегда направляет поток только на 127.0.0.1:<порт своего сервера Minecraft>:
// гость не выбирает адрес и порт на ПК хозяина.
const net = require('net');
const { EventEmitter } = require('events');

/** Локальная точка входа для клиента Minecraft гостя: 127.0.0.1:<случайный порт>. */
function localListener(openStream, { onError } = {}) {
  const sockets = new Set();
  const server = net.createServer(async (sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    sock.pause();
    let stream;
    try {
      stream = await openStream();
    } catch (e) {
      onError?.(e);
      sock.destroy();
      return;
    }
    bridge(sock, stream);
    sock.resume();
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () =>
      resolve({
        port: server.address().port,
        connections: () => sockets.size,
        close: () =>
          new Promise((r) => {
            for (const s of sockets) s.destroy();
            server.close(() => r());
          }),
      }),
    );
  });
}

/** Двунаправленная склейка потоков с обратным давлением и закрытием обоих концов. */
function bridge(a, b) {
  a.pipe(b);
  b.pipe(a);
  let done = false;
  const end = () => {
    if (done) return;
    done = true;
    a.destroy();
    b.destroy();
  };
  a.on('error', end);
  b.on('error', end);
  a.on('close', end);
  b.on('close', end);
}

/** Хозяин: поток гостя → только локальный сервер Minecraft. */
function toLocalServer(stream, port) {
  const sock = net.connect({ host: '127.0.0.1', port });
  bridge(stream, sock);
  return sock;
}

class Emitter extends EventEmitter {}

module.exports = { localListener, bridge, toLocalServer, Emitter };
