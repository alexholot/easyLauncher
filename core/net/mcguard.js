'use strict';
// Проверка входа в Minecraft у хозяина: поток друга идёт на сервер, только если ник в пакете входа —
// тот самый, под которым хозяин принял друга по приглашению.
//
// Зачем: в сессии «без Microsoft» сервер ники не проверяет. Без этой проверки приглашённый друг мог бы
// поставить в своей игре ник хозяина (или другого игрока) и зайти под ним — с его правами оператора и вещами.
//
// Протокол Minecraft 1.7+ (игра с друзьями — с 1.7.2): сначала «рукопожатие»
//   [длина varint][id 0x00][версия протокола varint][адрес string][порт u16][следующее состояние varint]
// состояние 1 — запрос статуса (список серверов, пинг), 2 — вход, 3 — перенос (1.20.5+, тоже вход).
// При входе следом «начало входа»: [длина][id 0x00][ник string]… — до шифрования и сжатия, открытым текстом.

const MAX_HEAD = 4096; // рукопожатие и начало входа — меньше сотни байт; больше — не Minecraft

/** varint из buf с позиции pos → [значение, новая позиция] | null (данных не хватает) | throws (испорчен). */
function varint(buf, pos) {
  let v = 0;
  for (let i = 0; i < 5; i++) {
    if (pos + i >= buf.length) return null;
    const b = buf[pos + i];
    v |= (b & 0x7f) << (7 * i);
    if (!(b & 0x80)) return [v >>> 0, pos + i + 1];
  }
  throw new Error('испорченный varint');
}

/** Один пакет без сжатия → {id, body, next} | null (данных не хватает). */
function packet(buf, pos) {
  const len = varint(buf, pos);
  if (!len) return null;
  const [n, p] = len;
  if (n < 1 || n > MAX_HEAD) throw new Error('неожиданная длина пакета');
  if (p + n > buf.length) return null;
  const id = varint(buf, p);
  if (!id) throw new Error('пустой пакет');
  return { id: id[0], body: buf.subarray(id[1], p + n), next: p + n };
}

function str(buf, pos) {
  const l = varint(buf, pos);
  if (!l) throw new Error('строка обрезана');
  const [n, p] = l;
  if (p + n > buf.length) throw new Error('строка обрезана');
  return [buf.toString('utf8', p, p + n), p + n];
}

/**
 * Разбор начала потока: {need: true} — нужно больше байт; {status: true} — запрос статуса (пропускаем);
 * {name} — ник из пакета входа; throws — это не вход в Minecraft.
 */
function parseLogin(buf) {
  if (buf.length && buf[0] === 0xfe) return { status: true }; // старый запрос статуса (список серверов)
  const hs = packet(buf, 0);
  if (!hs) return { need: true };
  if (hs.id !== 0) throw new Error('не рукопожатие');
  let p = 0;
  const b = hs.body;
  const ver = varint(b, p);
  if (!ver) throw new Error('рукопожатие обрезано');
  p = ver[1];
  [, p] = str(b, p); // адрес
  p += 2; // порт
  const st = varint(b, p);
  if (!st) throw new Error('рукопожатие обрезано');
  if (st[0] === 1) return { status: true };
  if (st[0] !== 2 && st[0] !== 3) throw new Error('неизвестное состояние');
  const login = packet(buf, hs.next);
  if (!login) return { need: true };
  if (login.id !== 0) throw new Error('не начало входа');
  const [name] = str(login.body, 0);
  return { name };
}

/**
 * Поток друга → сервер Minecraft, только если ник совпадает с expected (как у приглашения) или это запрос
 * статуса. head — уже прочитанные байты. onOk(всеБайты) — пропустить; поток иначе закрывается.
 */
function guardLogin(stream, head, expected, onOk, { timeoutMs = 15000, onReject } = {}) {
  let buf = head;
  let done = false;
  const finish = (ok, why) => {
    if (done) return;
    done = true;
    clearTimeout(t);
    stream.off('data', onData);
    stream.pause();
    if (ok) return onOk(buf);
    onReject?.(why);
    stream.destroy();
  };
  const check = () => {
    let r;
    try {
      r = parseLogin(buf);
    } catch (e) {
      return finish(false, e.message);
    }
    if (r.need) return buf.length > MAX_HEAD ? finish(false, 'слишком длинное начало') : undefined;
    if (r.status) return finish(true);
    if (r.name === expected) return finish(true);
    finish(false, `ник ${JSON.stringify(String(r.name).slice(0, 32))} вместо ${expected}`);
  };
  const onData = (c) => {
    buf = Buffer.concat([buf, c]);
    check();
  };
  const t = setTimeout(() => finish(false, 'нет пакета входа'), timeoutMs);
  t.unref?.();
  stream.on('data', onData);
  stream.on('close', () => finish(false, 'поток закрыт'));
  check();
  if (!done) stream.resume();
}

module.exports = { parseLogin, guardLogin, varint };
