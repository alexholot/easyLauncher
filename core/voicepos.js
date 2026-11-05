'use strict';
// Где стоят игроки — для объёмного голоса (как в модах Simple Voice Chat / Plasmo Voice): друга слышно
// с той стороны, где стоит его персонаж, и тише с расстоянием; в другом измерении — не слышно.
//
// Сервер сессии работает на ПК хозяина. Лаунчер несколько раз в секунду спрашивает у него координаты,
// поворот и измерение игроков (команда data get entity, Minecraft 1.13+) и читает ответы из вывода сервера.
// Ответы не попадают ни в журнал окна, ни в чат игроков (broadcast-console-to-ops=false в server.properties).
const { EventEmitter } = require('events');

const NICK = /^[A-Za-z0-9_]{1,16}$/;
const LINE = /: ([A-Za-z0-9_]{1,16}) has the following entity data: (.+)$/;
const NONE = /: No entity was found$/;

/** Ответ сервера на data get entity → {name, pos:[x,y,z]} | {name, rot:[yaw,pitch]} | {name, dim} | null. */
function parseEntityLine(line) {
  const m = LINE.exec(String(line));
  if (!m) return null;
  const v = m[2].trim();
  const list = /^\[(.*)\]$/.exec(v);
  if (list) {
    const nums = list[1].split(',').map((s) => parseFloat(s));
    if (!nums.length || nums.some((n) => !Number.isFinite(n))) return null;
    if (nums.length === 3) return { name: m[1], pos: nums };
    if (nums.length === 2) return { name: m[1], rot: nums };
    return null;
  }
  // 1.16+: "minecraft:overworld"; до 1.16 — число (0, -1, 1)
  const s = /^"([a-z0-9_.:/-]{1,64})"$/.exec(v);
  if (s) return { name: m[1], dim: s[1] };
  if (/^-?\d{1,6}$/.test(v)) return { name: m[1], dim: 'dim' + v };
  return null;
}

class PositionTracker extends EventEmitter {
  /** server — LocalServer (state, players, command, quiet). События: 'positions' {ник: [x, y, z, поворот, измерение]}. */
  constructor(server, { interval = 250 } = {}) {
    super();
    this.server = server;
    this.interval = interval;
    this.data = new Map(); // ник → {pos, rot, dim, at}
    this.timer = null;
    this.round = 0;
    this.lastPoll = 0;
  }

  get running() {
    return !!this.timer;
  }

  start() {
    if (this.timer) return;
    this.server.quiet = (line) => this.feed(line);
    this.timer = setInterval(() => this.tick(), this.interval);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    if (this.server.quiet) this.server.quiet = null;
    this.data.clear();
  }

  tick() {
    const srv = this.server;
    if (srv.state !== 'running') return;
    // сначала — то, что сервер ответил на прошлый опрос
    this.emit('positions', this.snapshot());
    const names = [...srv.players].filter((n) => NICK.test(n));
    if (!names.length) return;
    this.lastPoll = Date.now();
    for (const n of names) {
      try {
        srv.command(`data get entity ${n} Pos`);
        srv.command(`data get entity ${n} Rotation`);
        // измерение меняется редко — раз в секунду
        if (this.round % 4 === 0) srv.command(`data get entity ${n} Dimension`);
      } catch {}
    }
    this.round++;
  }

  /** Строка вывода сервера: ответ на наш опрос — запомнить и спрятать (true); остальное — как было (false). */
  feed(line) {
    const r = parseEntityLine(line);
    if (r) {
      if (!this.server.players.has(r.name)) return false; // не наш опрос — пусть видно, как раньше
      const d = this.data.get(r.name) || {};
      if (r.pos) {
        d.pos = r.pos;
        d.at = Date.now();
      }
      if (r.rot) d.rot = r.rot;
      if (r.dim) d.dim = r.dim;
      this.data.set(r.name, d);
      return true;
    }
    // игрок вышел между опросами
    if (NONE.test(line) && Date.now() - this.lastPoll < 2000) return true;
    return false;
  }

  snapshot() {
    const out = {};
    const now = Date.now();
    for (const [name, d] of this.data) {
      if (!d.pos || now - d.at > 2000 || !this.server.players.has(name)) continue;
      const r2 = (x) => Math.round(x * 100) / 100;
      out[name] = [r2(d.pos[0]), r2(d.pos[1]), r2(d.pos[2]), r2(d.rot?.[0] || 0), d.dim || ''];
    }
    return out;
  }
}

/** Позиции от хозяина (у гостя) — только похожие на правду: ник, числа, короткое имя измерения. */
function cleanPositions(p) {
  const out = {};
  if (!p || typeof p !== 'object') return out;
  for (const [name, v] of Object.entries(p).slice(0, 64)) {
    if (!NICK.test(name) || !Array.isArray(v) || v.length !== 5) continue;
    if (!v.slice(0, 4).every((n) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) < 1e8)) continue;
    out[name] = [v[0], v[1], v[2], v[3], typeof v[4] === 'string' ? v[4].slice(0, 64) : ''];
  }
  return out;
}

module.exports = { PositionTracker, parseEntityLine, cleanPositions };
