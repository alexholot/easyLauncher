'use strict';
// Сведения о мире для летописи и карты — во всех форматах папки мира:
//  • до 26.x: level.dat (Data.Player, SpawnX/Z, DayTime), region/, playerdata/ у серверов;
//  • 26.x: level.dat (spawn.pos, singleplayer_uuid), data/minecraft/world_clocks.dat,
//    players/data/<uuid>.dat, dimensions/minecraft/overworld/region/.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const zlib = require('zlib');
const { parse, readLevel } = require('./nbt');

async function readNbt(file) {
  let b = await fsp.readFile(file);
  if (b[0] === 0x1f && b[1] === 0x8b) b = zlib.gunzipSync(b);
  return parse(b);
}

/** UUID из четырёх int32 (формат NBT 1.16+) → строка с дефисами. */
function uuidFromInts(a) {
  if (!Array.isArray(a) || a.length !== 4) return null;
  const h = a.map((n) => (n >>> 0).toString(16).padStart(8, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const xyz = (a) => (Array.isArray(a) && a.length >= 3 && a.slice(0, 3).every(Number.isFinite) ? a.slice(0, 3).map((v) => Math.floor(v)) : null);
const dimName = (v) => (typeof v === 'string' ? v.replace(/^minecraft:/, '') : v === -1 ? 'the_nether' : v === 1 ? 'the_end' : 'overworld');

/** Игрок из NBT (level.dat Player или файл игрока). */
function playerOf(p) {
  if (!p || !xyz(p.Pos)) return { player: null, lastDeath: null };
  const d = p.LastDeathLocation;
  return { player: { pos: xyz(p.Pos), dim: dimName(p.Dimension) }, lastDeath: d && xyz(d.pos) ? { pos: xyz(d.pos), dim: dimName(d.dimension) } : null };
}

/** Папка регионов верхнего мира. */
function regionDir(worldDir) {
  const modern = path.join(worldDir, 'dimensions', 'minecraft', 'overworld', 'region');
  return fs.existsSync(modern) ? modern : path.join(worldDir, 'region');
}

/** UUID в виде с дефисами (так называются файлы игроков), из любого вида. */
function dashed(u) {
  const h = String(u || '').toLowerCase().replace(/-/g, '');
  return /^[0-9a-f]{32}$/.test(h) ? `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}` : null;
}

/**
 * Файл игрока: по UUID одиночной игры, затем по своим UUID (аккаунт Microsoft и офлайн-ник — на сервере сессии
 * у хозяина свой файл, у друзей — свои); если своего нет — самый свежий. Раньше на сервере с друзьями брался
 * просто самый свежий файл — и в летопись хозяина могли попасть место и смерть друга.
 */
async function playerFile(worldDir, uuids) {
  const want = [...new Set((Array.isArray(uuids) ? uuids : [uuids]).map(dashed).filter(Boolean))];
  for (const dir of [path.join(worldDir, 'players', 'data'), path.join(worldDir, 'playerdata')]) {
    let names = [];
    try {
      names = (await fsp.readdir(dir)).filter((n) => /^[0-9a-f-]{36}\.dat$/i.test(n));
    } catch {
      continue;
    }
    for (const u of want) if (names.includes(u + '.dat')) return path.join(dir, u + '.dat');
    let best = null;
    for (const n of names) {
      const t = (await fsp.stat(path.join(dir, n))).mtimeMs;
      if (!best || t > best.t) best = { f: path.join(dir, n), t };
    }
    if (best) return best.f;
  }
  return null;
}

/**
 * Всё, что лаунчеру нужно знать о мире: имя, версия, игровой день, точка появления, где игрок,
 * где была последняя смерть, папка регионов. Чего нет — null (а не ошибка).
 */
async function readWorld(worldDir, { uuids = [] } = {}) {
  const raw = await fsp.readFile(path.join(worldDir, 'level.dat'));
  const lv = readLevel(raw);
  const root = parse(raw[0] === 0x1f && raw[1] === 0x8b ? zlib.gunzipSync(raw) : raw);
  const d = root.Data || {};
  let day = lv.day;
  // сколько мир уже прожил (тиков): для «Вызова» новый мир — моложе одних игровых суток
  let ticks = Number.isFinite(d.Time) ? d.Time : null;
  if (day == null) {
    // 26.x: время мира — в data/minecraft/world_clocks.dat
    try {
      const c = await readNbt(path.join(worldDir, 'data', 'minecraft', 'world_clocks.dat'));
      const t = c.data?.['minecraft:overworld']?.total_ticks;
      if (Number.isFinite(t)) {
        day = Math.floor(t / 24000) + 1;
        ticks = t;
      }
    } catch {}
    if (day == null && Number.isFinite(d.Time)) day = Math.floor(d.Time / 24000) + 1;
  }
  const spawn = lv.spawn || (xyz(d.spawn?.pos) ? xyz(d.spawn.pos) : null);
  let { player, lastDeath } = { player: lv.player, lastDeath: lv.lastDeath };
  if (!player) {
    const f = await playerFile(worldDir, [uuidFromInts(d.singleplayer_uuid), ...uuids]);
    if (f) {
      try {
        ({ player, lastDeath } = playerOf(await readNbt(f)));
      } catch {}
    }
  }
  return { name: lv.name, version: lv.version, dataVersion: lv.dataVersion, day, ticks, spawn, player, lastDeath, regionDir: regionDir(worldDir) };
}

module.exports = { readWorld, uuidFromInts, regionDir, playerOf, dashed };
