'use strict';
// Карта мира: вид сверху по файлам регионов (region/r.X.Z.mca, формат Anvil). Один регион — 32×32 чанка,
// плитка 512×512 точек (точка = блок). Цвет — верхний блок колонки (карта высот WORLD_SURFACE), тень —
// перепад высот к северу, как на игровой карте. Поддержаны миры 1.13+ (до «уплощения» блоков формат другой).
const zlib = require('zlib');
const { parse } = require('./nbt');

const FLATTENING = 1451; // DataVersion 1.13: блоки по именам и палитрам
const NO_SPAN = 2529; // 1.16+: значения не переходят через границу 64-битных слов
const NEW_CHUNK = 2844; // 1.18+: секции в корне чанка, мир с Y = -64

// ---------- цвета блоков ----------
const DYES = {
  white: '#e9ecec', orange: '#f07613', magenta: '#bd44b3', light_blue: '#3aafd9', yellow: '#f8c527', lime: '#70b919', pink: '#ed8dac', gray: '#3e4447',
  light_gray: '#8e8e86', cyan: '#158991', purple: '#792aac', blue: '#35399d', brown: '#724728', green: '#546d1b', red: '#a12722', black: '#141519',
};
const EXACT = {
  grass_block: '#6fa83a', water: '#3a64c8', bubble_column: '#3a64c8', sand: '#e3d9a5', sandstone: '#d8cc95', cut_sandstone: '#d8cc95', red_sand: '#c46a2e', red_sandstone: '#b85f2a',
  dirt: '#8a5f3c', coarse_dirt: '#7c5536', rooted_dirt: '#8a5f3c', farmland: '#6e4a2c', dirt_path: '#94793c', podzol: '#6b4a24', mycelium: '#6f6273', mud: '#3c3837',
  stone: '#7d7d7d', cobblestone: '#767676', mossy_cobblestone: '#6a7a5a', andesite: '#888888', diorite: '#cfcfcf', granite: '#a06b55', gravel: '#837d7a', tuff: '#6c6d66', calcite: '#dfe0dc',
  deepslate: '#545458', cobbled_deepslate: '#4d4d51', bedrock: '#444444', obsidian: '#1b1726', crying_obsidian: '#2b1748',
  snow: '#f4fafb', snow_block: '#f4fafb', powder_snow: '#f4fafb', ice: '#9ebcf4', packed_ice: '#8db4f0', blue_ice: '#74a6ee', frosted_ice: '#9ebcf4',
  clay: '#a0a6b4', terracotta: '#985e43', lava: '#e8581c', magma_block: '#8e3f19', netherrack: '#6e2a2a', soul_sand: '#4f3c2f', soul_soil: '#4b3a2e', basalt: '#4b4b4f', blackstone: '#2b252b',
  crimson_nylium: '#8a1f1f', warped_nylium: '#2b7265', end_stone: '#dbdea0', purpur_block: '#a97ca9', moss_block: '#597d2b', moss_carpet: '#597d2b', sculk: '#0c2a33',
  pumpkin: '#e2861f', melon: '#7aa62c', hay_block: '#c8a51c', bricks: '#97523f', glowstone: '#f6d37b', sea_lantern: '#c5d9d3', prismarine: '#5ea596', lily_pad: '#2a7a2a',
  cactus: '#3a7d27', sugar_cane: '#8fbd5c', bamboo: '#6f8f2a', kelp: '#3a64c8', kelp_plant: '#3a64c8', seagrass: '#3a64c8', tall_seagrass: '#3a64c8', glass: '#b9d4dc',
};
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const colorCache = new Map();
function colorOf(fullName) {
  let c = colorCache.get(fullName);
  if (c) return c;
  const n = String(fullName).replace(/^minecraft:/, '');
  let h = EXACT[n];
  if (!h) {
    const dye = Object.keys(DYES).sort((a, b) => b.length - a.length).find((d) => n.startsWith(d + '_'));
    if (dye && /(wool|concrete|terracotta|carpet|stained_glass|bed|shulker|candle|banner)/.test(n)) h = DYES[dye];
    else if (/cherry_leaves/.test(n)) h = '#e9a5c4';
    else if (/azalea|leaves/.test(n)) h = '#3c7a28';
    else if (/(_log|_wood|_stem|_hyphae)$/.test(n)) h = '#5e4a2b';
    else if (/planks|_slab|_stairs|_fence|_door|trapdoor/.test(n)) h = /stone|brick|deepslate|blackstone|sandstone|quartz|purpur|prismarine/.test(n) ? '#8a8a8a' : '#9a7c4c';
    else if (/wheat|carrots|potatoes|beetroots|crop|stem/.test(n)) h = '#6aa84f';
    else if (/grass|fern|bush|vine|flower|tulip|poppy|dandelion|orchid|allium|bluet|daisy|lily|rose|peony|lilac|sapling|petals/.test(n)) h = '#5f9c34';
    else if (/ice/.test(n)) h = '#9ebcf4';
    else if (/snow/.test(n)) h = '#f4fafb';
    else if (/sand/.test(n)) h = '#e3d9a5';
    else if (/ore|stone|deepslate|cobble|brick/.test(n)) h = '#7d7d7d';
    else if (/copper/.test(n)) h = '#b4684d';
    else if (/glass/.test(n)) h = '#b9d4dc';
    else if (/mushroom/.test(n)) h = '#9c6b4a';
    else if (/coral/.test(n)) h = '#c14f8a';
    else h = '#8a8a8a';
  }
  c = hex(h);
  colorCache.set(fullName, c);
  return c;
}
const isWater = (n) => /(^|:)(water|bubble_column|kelp|kelp_plant|seagrass|tall_seagrass)$/.test(n);

// ---------- упакованные значения ----------
/** Значение номер idx из массива 64-битных слов (Buffer, big-endian). */
function packed(buf, idx, bits, spanning) {
  const mask = (1n << BigInt(bits)) - 1n;
  if (!spanning) {
    const per = Math.floor(64 / bits);
    const li = Math.floor(idx / per);
    if ((li + 1) * 8 > buf.length) return 0;
    return Number((buf.readBigUInt64BE(li * 8) >> BigInt((idx % per) * bits)) & mask);
  }
  const bit = idx * bits;
  const li = Math.floor(bit / 64);
  const off = bit % 64;
  if ((li + 1) * 8 > buf.length) return 0;
  let v = buf.readBigUInt64BE(li * 8) >> BigInt(off);
  if (off + bits > 64 && (li + 2) * 8 <= buf.length) v |= buf.readBigUInt64BE((li + 1) * 8) << BigInt(64 - off);
  return Number(v & mask);
}

/** Чанк из региона: распаковка (zlib/gzip/без сжатия). null — пусто или сжатие не поддерживается (LZ4, внешний файл). */
function readChunk(region, i) {
  const off = ((region[i * 4] << 16) | (region[i * 4 + 1] << 8) | region[i * 4 + 2]) * 4096;
  if (!off || off + 5 > region.length) return null;
  const len = region.readUInt32BE(off);
  const comp = region[off + 4];
  if (len < 2 || off + 4 + len > region.length) return null;
  const data = region.subarray(off + 5, off + 4 + len);
  try {
    if (comp === 2) return zlib.inflateSync(data);
    if (comp === 1) return zlib.gunzipSync(data);
    if (comp === 3) return data;
  } catch {}
  return null;
}

/** Верхние блоки чанка: 256 записей {name, y} (null — колонка пустая или чанк не догенерирован). */
function chunkTops(raw, fallbackVersion) {
  const root = parse(raw, { rawLongs: true });
  const dv = root.DataVersion || fallbackVersion || 0;
  const lvl = dv >= NEW_CHUNK ? root : root.Level || root;
  const status = String(lvl.Status || root.Status || 'full').replace(/^minecraft:/, '');
  if (!['full', 'spawn', 'heightmaps', 'postprocessed', 'fullchunk'].includes(status)) return null;
  const spanning = dv < NO_SPAN;
  const minY = dv >= NEW_CHUNK ? (Number.isInteger(root.yPos) ? root.yPos : -4) * 16 : 0;
  const hm = lvl.Heightmaps?.WORLD_SURFACE || lvl.Heightmaps?.MOTION_BLOCKING;
  if (!Buffer.isBuffer(hm)) return null;
  const sections = new Map();
  for (const s of lvl.sections || lvl.Sections || []) {
    const bs = s.block_states;
    const palette = bs ? bs.palette : s.Palette;
    const data = bs ? bs.data : s.BlockStates;
    if (Array.isArray(palette) && palette.length) sections.set(s.Y, { palette, data: Buffer.isBuffer(data) ? data : null, bits: Math.max(4, Math.ceil(Math.log2(palette.length))) });
  }
  // палитра: до 26.x всегда {Name, Properties}; в 26.x — строка, {id, properties} или {"": имя}
  // (так игра хранит список из значений разных типов)
  const nameOf = (e) => (typeof e === 'string' ? e : e?.Name || e?.id || e?.['']) || 'minecraft:air';
  const blockAt = (x, y, z) => {
    const s = sections.get(Math.floor(y / 16));
    if (!s) return 'minecraft:air';
    if (!s.data) return nameOf(s.palette[0]);
    return nameOf(s.palette[packed(s.data, ((y & 15) * 16 + z) * 16 + x, s.bits, spanning)]);
  };
  const out = new Array(256).fill(null);
  for (let z = 0; z < 16; z++) {
    for (let x = 0; x < 16; x++) {
      const h = packed(hm, z * 16 + x, 9, spanning);
      if (!h) continue;
      const y = h - 1 + minY;
      const name = blockAt(x, y, z);
      if (/(^|:)(air|cave_air|void_air)$/.test(name)) continue;
      let depth = 0;
      if (isWater(name)) while (depth < 12 && isWater(blockAt(x, y - depth - 1, z))) depth++;
      out[z * 16 + x] = { name, y, depth };
    }
  }
  return out;
}

/** Плитка региона: RGBA 512×512 (прозрачно, где мир не сгенерирован) и число нарисованных чанков. */
function renderRegion(region, dataVersion) {
  const W = 512;
  const rgba = Buffer.alloc(W * W * 4);
  const height = new Int16Array(W * W).fill(-32768);
  const cols = new Array(W * W);
  let chunks = 0;
  for (let i = 0; i < 1024; i++) {
    const raw = readChunk(region, i);
    if (!raw) continue;
    let tops;
    try {
      tops = chunkTops(raw, dataVersion);
    } catch {
      continue;
    }
    if (!tops) continue;
    chunks++;
    const cx = i % 32;
    const cz = Math.floor(i / 32);
    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 16; x++) {
        const t = tops[z * 16 + x];
        if (!t) continue;
        const p = (cz * 16 + z) * W + cx * 16 + x;
        height[p] = t.y;
        cols[p] = t;
      }
    }
  }
  for (let p = 0; p < W * W; p++) {
    const t = cols[p];
    if (!t) continue;
    let [r, g, b] = colorOf(t.name);
    let k = 1;
    if (isWater(t.name)) k = 1.08 - Math.min(12, t.depth) * 0.035; // глубже — темнее
    else {
      // тень рельефа: выше северного соседа — светлее, ниже — темнее
      const north = p >= W ? height[p - W] : -32768;
      if (north !== -32768) k = t.y > north ? 1.12 : t.y < north ? 0.82 : 1;
    }
    rgba[p * 4] = Math.min(255, r * k);
    rgba[p * 4 + 1] = Math.min(255, g * k);
    rgba[p * 4 + 2] = Math.min(255, b * k);
    rgba[p * 4 + 3] = 255;
  }
  return { rgba, width: W, height: W, chunks };
}

// ---------- PNG ----------
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** RGBA → PNG (без фильтров строк, deflate). */
function encodePng(rgba, w, h) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}

/** Регион по имени файла: r.-1.3.mca → {x: -1, z: 3}. */
function regionCoords(name) {
  const m = /^r\.(-?\d+)\.(-?\d+)\.mca$/.exec(name);
  return m ? { x: Number(m[1]), z: Number(m[2]) } : null;
}

module.exports = { renderRegion, encodePng, chunkTops, packed, colorOf, regionCoords, crc32, FLATTENING };
