'use strict';
// Для тестов: начало настоящего входа в Minecraft (рукопожатие + «начало входа» с ником), как шлёт клиент 1.20.2+.
// next = 1 — запрос статуса (список серверов) вместо входа.
const crypto = require('crypto');

function mcLogin(name, next = 2) {
  const vi = (n) => {
    const out = [];
    do {
      let b = n & 0x7f;
      n >>>= 7;
      if (n) b |= 0x80;
      out.push(b);
    } while (n);
    return Buffer.from(out);
  };
  const s = (t) => Buffer.concat([vi(Buffer.byteLength(t)), Buffer.from(t)]);
  const pkt = (...parts) => {
    const body = Buffer.concat([vi(0), ...parts]);
    return Buffer.concat([vi(body.length), body]);
  };
  const port = Buffer.alloc(2);
  port.writeUInt16BE(25565);
  const hs = pkt(vi(767), s('localhost'), port, vi(next));
  return next === 1 ? hs : Buffer.concat([hs, pkt(s(name), crypto.randomBytes(16))]);
}

module.exports = { mcLogin };
