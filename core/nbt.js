'use strict';
// Минимальный читатель NBT (формат level.dat Minecraft: gzip + бинарное дерево тегов). Только чтение.
const zlib = require('zlib');

function parse(buf) {
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
      case 12: { const n = i32(); const a = []; for (let i = 0; i < n; i++) a.push(i64()); return a; }
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
  return {
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

/** Запись NBT — только для тестов (сборка поддельного level.dat). */
function write(obj) {
  const parts = [];
  const b = (n) => Buffer.alloc(n);
  const str = (s) => {
    const v = Buffer.from(s, 'utf8');
    const h = b(2);
    h.writeUInt16BE(v.length);
    parts.push(h, v);
  };
  const typeOf = (v) => (typeof v === 'string' ? 8 : typeof v === 'bigint' ? 4 : typeof v === 'number' ? (Number.isInteger(v) ? 3 : 6) : typeof v === 'boolean' ? 1 : 10);
  function val(t, v) {
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
  return zlib.gzipSync(Buffer.concat(parts));
}

module.exports = { parse, readLevel, write };
