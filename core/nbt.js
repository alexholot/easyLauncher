'use strict';
// Минимальный читатель NBT (формат level.dat Minecraft: gzip + бинарное дерево тегов). Только чтение.
const zlib = require('zlib');

/**
 * opts.rawLongs — длинные массивы (тег 12) отдавать как Buffer, без перевода в числа: в упакованных данных
 * блоков 64-битные значения не помещаются в Number без потери младших бит (нужно для карты мира).
 */
function parse(buf, opts = {}) {
  let p = 0;
  const u8 = () => buf.readUInt8(p++);
  const i16 = () => ((p += 2), buf.readInt16BE(p - 2));
  const i32 = () => ((p += 4), buf.readInt32BE(p - 4));
  const i64 = () => ((p += 8), Number(buf.readBigInt64BE(p - 8)));
  const f32 = () => ((p += 4), buf.readFloatBE(p - 4));
  const f64 = () => ((p += 8), buf.readDoubleBE(p - 8));
  const str = () => {
    const n = buf.readUInt16BE(p);
    p += 2;
    const s = buf.toString('utf8', p, p + n);
    p += n;
    return s;
  };
  function payload(type, depth) {
    if (depth > 64) throw new Error('NBT слишком глубокий');
    switch (type) {
      case 1: return buf.readInt8(p++);
      case 2: return i16();
      case 3: return i32();
      case 4: return i64();
      case 5: return f32();
      case 6: return f64();
      case 7: { const n = i32(); const v = buf.subarray(p, p + n); p += n; return v; }
      case 8: return str();
      case 9: {
        const t = u8();
        const n = i32();
        const out = [];
        for (let i = 0; i < n; i++) out.push(payload(t, depth + 1));
        return out;
      }
      case 10: {
        const o = {};
        for (;;) {
          const t = u8();
          if (t === 0) return o;
          const name = str();
          o[name] = payload(t, depth + 1);
        }
      }
      case 11: { const n = i32(); const a = []; for (let i = 0; i < n; i++) a.push(i32()); return a; }
      case 12: {
        const n = i32();
        if (opts.rawLongs) { const v = buf.subarray(p, p + n * 8); p += n * 8; return v; }
        const a = [];
        for (let i = 0; i < n; i++) a.push(i64());
        return a;
      }
      default: throw new Error('Неизвестный тег NBT ' + type);
    }
  }
  const type = u8();
  if (type !== 10) throw new Error('Корень NBT — не compound');
  str();
  return payload(10, 0);
}

/** level.dat → основные сведения о мире. */
function readLevel(fileBuf) {
  let raw = fileBuf;
  if (raw[0] === 0x1f && raw[1] === 0x8b) raw = zlib.gunzipSync(raw);
  const root = parse(raw);
  const d = root.Data || {};
  const modes = ['survival', 'creative', 'adventure', 'spectator'];
  const pl = d.Player || {};
  const xyz = (a) => (Array.isArray(a) && a.length >= 3 && a.every((v) => Number.isFinite(v)) ? a.slice(0, 3).map((v) => Math.floor(v)) : null);
  // измерение: в новых версиях строка «minecraft:the_nether», в старых — число (-1, 0, 1)
  const dim = (v) => (typeof v === 'string' ? v.replace(/^minecraft:/, '') : v === -1 ? 'the_nether' : v === 1 ? 'the_end' : 'overworld');
  const death = pl.LastDeathLocation;
  return {
    // игровой день (DayTime учитывает пропуск ночи сном) — для «Летописи мира»
    day: Number.isFinite(d.DayTime) ? Math.floor(d.DayTime / 24000) + 1 : null,
    spawn: Number.isFinite(d.SpawnX) && Number.isFinite(d.SpawnZ) ? [d.SpawnX, d.SpawnY ?? 64, d.SpawnZ] : null,
    // одиночная игра: игрок хранится в level.dat (сохраняется раз в несколько минут и при выходе)
    player: xyz(pl.Pos) ? { pos: xyz(pl.Pos), dim: dim(pl.Dimension) } : null,
    lastDeath: death && xyz(death.pos) ? { pos: xyz(death.pos), dim: dim(death.dimension) } : null,
    name: d.LevelName || null,
    lastPlayed: d.LastPlayed ? new Date(d.LastPlayed).toISOString() : null,
    version: d.Version?.Name || null,
    dataVersion: d.DataVersion || d.Version?.Id || null,
    gamemode: modes[d.GameType] || null,
    hardcore: !!d.hardcore,
    // seed: в 1.16+ лежит в WorldGenSettings, раньше — в RandomSeed
    seed: d.WorldGenSettings?.seed ?? d.RandomSeed ?? null,
  };
}

/** Запись NBT — только для тестов (поддельные level.dat, файлы игрока и чанки). gzip — по умолчанию. */
function write(obj, { gzip = true } = {}) {
  const parts = [];
  const b = (n) => Buffer.alloc(n);
  const str = (s) => {
    const v = Buffer.from(s, 'utf8');
    const h = b(2);
    h.writeUInt16BE(v.length);
    parts.push(h, v);
  };
  // Int32Array → массив int (11), BigInt64Array → массив long (12), Float64Array и обычный массив → список (9)
  const typeOf = (v) =>
    v instanceof Int32Array ? 11 : v instanceof BigInt64Array ? 12 : v instanceof Float64Array || Array.isArray(v) ? 9 : typeof v === 'string' ? 8 : typeof v === 'bigint' ? 4 : typeof v === 'number' ? (Number.isInteger(v) ? 3 : 6) : typeof v === 'boolean' ? 1 : 10;
  function val(t, v) {
    if (t === 11 || t === 12) {
      const n = b(4);
      n.writeInt32BE(v.length);
      parts.push(n);
      for (const x of v) {
        const e = b(t === 11 ? 4 : 8);
        t === 11 ? e.writeInt32BE(x) : e.writeBigInt64BE(x);
        parts.push(e);
      }
      return;
    }
    if (t === 9) {
      const items = [...v];
      const et = v instanceof Float64Array ? 6 : items.length ? typeOf(items[0]) : 0;
      const h = b(5);
      h[0] = et;
      h.writeInt32BE(items.length, 1);
      parts.push(h);
      for (const x of items) val(et, x);
      return;
    }
    if (t === 8) return str(v);
    if (t === 4) { const x = b(8); x.writeBigInt64BE(BigInt(v)); return parts.push(x); }
    if (t === 3) { const x = b(4); x.writeInt32BE(v); return parts.push(x); }
    if (t === 6) { const x = b(8); x.writeDoubleBE(v); return parts.push(x); }
    if (t === 1) return parts.push(Buffer.from([v ? 1 : 0]));
    for (const [k, w] of Object.entries(v)) {
      const tt = typeOf(w);
      parts.push(Buffer.from([tt]));
      str(k);
      val(tt, w);
    }
    parts.push(Buffer.from([0]));
  }
  parts.push(Buffer.from([10]));
  str('');
  val(10, obj);
  return gzip ? zlib.gzipSync(Buffer.concat(parts)) : Buffer.concat(parts);
}

module.exports = { parse, readLevel, write };
