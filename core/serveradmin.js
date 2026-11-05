'use strict';
// Админ-панель сервера хозяина: состояние, игроки (кик, бан, оператор, режим), белый список, баны,
// настройки server.properties и правила игры (gamerule). Действия — штатными командами сервера Minecraft;
// списки — из его же файлов (whitelist.json, ops.json, banned-players.json), которые сервер обновляет сам.
const fsp = require('fs').promises;
const path = require('path');
const { parseProperties, writeProperties } = require('./server');

const NAME_RE = /^[A-Za-z0-9_]{3,16}$/;
const MODES = ['survival', 'creative', 'adventure', 'spectator'];
const DIFFS = ['peaceful', 'easy', 'normal', 'hard'];
const clean = (s, max = 100) => String(s || '').replace(/[\r\n§]/g, ' ').trim().slice(0, max);

/**
 * Настройки сервера, которые можно менять из панели. live — применяется сразу командой,
 * иначе — после перезапуска сервера (так читает server.properties сам Minecraft).
 */
const PROPS = {
  motd: { type: 'text', max: 59 },
  'max-players': { type: 'int', min: 1, max: 100 },
  difficulty: { type: 'enum', values: DIFFS, live: (v) => `difficulty ${v}` },
  gamemode: { type: 'enum', values: MODES, live: (v) => `defaultgamemode ${v}` },
  pvp: { type: 'bool' },
  'allow-flight': { type: 'bool' },
  'spawn-protection': { type: 'int', min: 0, max: 64 },
  'view-distance': { type: 'int', min: 2, max: 32 },
  'simulation-distance': { type: 'int', min: 2, max: 32 },
  'enable-command-block': { type: 'bool' },
};

/** Правила игры. Новые версии Minecraft называют их через подчёркивание (keep_inventory) — пробуем оба. */
const RULES = {
  keepInventory: { type: 'bool', alt: 'keep_inventory' },
  doDaylightCycle: { type: 'bool', alt: 'advance_time' },
  doWeatherCycle: { type: 'bool', alt: 'advance_weather' },
  doMobSpawning: { type: 'bool', alt: 'spawn_mobs' },
  mobGriefing: { type: 'bool', alt: 'mob_griefing' },
  doFireTick: { type: 'bool', alt: 'fire_spread_radius_around_player' },
  naturalRegeneration: { type: 'bool', alt: 'natural_health_regeneration' },
  doInsomnia: { type: 'bool', alt: 'spawn_phantoms' },
  playersSleepingPercentage: { type: 'int', min: 0, max: 100, alt: 'players_sleeping_percentage' },
};

/** Настройки, выбранные хозяином в панели, — в папке сервера сборки. */
const OVERRIDES = 'easylauncher-server.json';
async function readOverrides(dir) {
  try {
    const o = JSON.parse(await fsp.readFile(path.join(dir, OVERRIDES), 'utf8'));
    const out = {};
    for (const [k, v] of Object.entries(o || {})) {
      try {
        if (PROPS[k]) out[k] = value(PROPS[k], v);
      } catch {}
    }
    return out;
  } catch {
    return {};
  }
}

function checkName(name) {
  if (!NAME_RE.test(String(name || ''))) throw new Error('Ник: 3–16 символов, латиница, цифры и _.');
  return name;
}

function value(def, v) {
  if (def.type === 'bool') return v === true || v === 'true';
  if (def.type === 'int') {
    const n = Number(v);
    if (!Number.isInteger(n) || n < def.min || n > def.max) throw new Error(`Нужно целое число от ${def.min} до ${def.max}.`);
    return n;
  }
  if (def.type === 'enum') {
    if (!def.values.includes(v)) throw new Error('Недопустимое значение.');
    return v;
  }
  return clean(v, def.max);
}

class ServerAdmin {
  /** launcher — Launcher (его server, store); rss(pid) → МБ памяти процесса. */
  constructor(launcher, { rss } = {}) {
    this.launcher = launcher;
    this.rss = rss || (async () => 0);
    this.ruleNames = new Map(); // правило → имя, которое понял этот сервер
  }

  get server() {
    return this.launcher.server;
  }

  dir() {
    if (this.server.state === 'stopped' || !this.server.profileId) throw new Error('Сервер не запущен.');
    return this.launcher.store.serverDir(this.server.profileId);
  }

  async readJson(file) {
    try {
      return JSON.parse(await fsp.readFile(path.join(this.dir(), file), 'utf8'));
    } catch {
      return [];
    }
  }

  async properties() {
    let map = new Map();
    try {
      map = parseProperties(await fsp.readFile(path.join(this.dir(), 'server.properties'), 'utf8'));
    } catch {}
    const out = {};
    for (const [k, def] of Object.entries(PROPS)) {
      const raw = map.get(k);
      if (raw === undefined) continue;
      // до 1.13 режим и сложность записаны числами
      if (k === 'gamemode' && /^\d$/.test(raw)) out[k] = MODES[Number(raw)] || 'survival';
      else if (k === 'difficulty' && /^\d$/.test(raw)) out[k] = DIFFS[Number(raw)] || 'normal';
      else out[k] = def.type === 'bool' ? raw === 'true' : def.type === 'int' ? Number(raw) : raw;
    }
    return out;
  }

  /** Всё для панели: состояние, игроки, списки, настройки. */
  async info() {
    const s = this.server;
    if (s.state === 'stopped') return { state: 'stopped' };
    const [whitelist, ops, bans, props] = await Promise.all([this.readJson('whitelist.json'), this.readJson('ops.json'), this.readJson('banned-players.json'), this.properties()]);
    const opNames = new Set(ops.map((o) => o.name));
    const uniqueNames = (items) => {
      const seen = new Set();
      return items.map((x) => x.name).filter((name) => {
        const key = String(name || '').toLowerCase();
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    };
    return {
      state: s.state,
      port: s.port,
      startedAt: s.startedAt || null,
      memoryMb: s.proc ? await this.rss(s.proc.pid) : 0,
      ramGb: s.ramGb || null,
      online: [...s.players].map((name) => ({ name, op: opNames.has(name) })),
      whitelist: uniqueNames(whitelist),
      ops: uniqueNames(ops),
      bans: bans.map((b) => ({ name: b.name, reason: b.reason || '', created: b.created || null })),
      properties: props,
      restartNeeded: [...(this.pendingRestart || [])],
    };
  }

  /** Действие с игроком. */
  player(action, name, extra = {}) {
    checkName(name);
    const cmd = {
      kick: () => `kick ${name} ${clean(extra.reason) || 'Хозяин отключил тебя от сервера'}`,
      ban: () => `ban ${name} ${clean(extra.reason) || 'Забанен хозяином'}`,
      pardon: () => `pardon ${name}`,
      op: () => `op ${name}`,
      deop: () => `deop ${name}`,
      'whitelist-add': () => `whitelist add ${name}`,
      'whitelist-remove': () => `whitelist remove ${name}`,
      gamemode: () => {
        if (!MODES.includes(extra.mode)) throw new Error('Неизвестный режим игры.');
        return `gamemode ${extra.mode} ${name}`;
      },
    }[action];
    if (!cmd) throw new Error('Неизвестное действие.');
    this.server.command(cmd());
    // убрали из белого списка — сразу отключаем, иначе игрок доиграет до выхода
    if (action === 'whitelist-remove') this.server.command(`kick ${name} Тебя убрали из белого списка`);
  }

  /** Быстрые действия с миром. */
  world(action, arg) {
    const cmd = {
      day: 'time set day',
      night: 'time set night',
      clear: 'weather clear',
      rain: 'weather rain',
      thunder: 'weather thunder',
      save: 'save-all',
      say: () => {
        const m = clean(arg, 200);
        if (!m) throw new Error('Напиши сообщение.');
        return `say ${m}`;
      },
    }[action];
    if (!cmd) throw new Error('Неизвестное действие.');
    this.server.command(typeof cmd === 'function' ? cmd() : cmd);
  }

  /** Изменить настройки сервера: то, что можно, — сразу командой; остальное — после перезапуска. */
  async setProperties(patch) {
    const values = {};
    const later = [];
    for (const [k, v] of Object.entries(patch || {})) {
      const def = PROPS[k];
      if (!def) throw new Error('Эту настройку менять нельзя: ' + k);
      values[k] = value(def, v);
    }
    const dir = this.dir();
    const current = await this.properties();
    // старые версии (до 1.13) читают режим и сложность числами
    const numeric = /^\d$/.test(String((await fsp.readFile(path.join(dir, 'server.properties'), 'utf8').catch(() => '')).match(/^gamemode=(.*)$/m)?.[1] || ''));
    const out = { ...values };
    if (numeric && out.gamemode) out.gamemode = MODES.indexOf(out.gamemode);
    if (numeric && out.difficulty) out.difficulty = DIFFS.indexOf(out.difficulty);
    await writeProperties(path.join(dir, 'server.properties'), out);
    // запоминаем выбор: при следующем запуске (и перезапуске) лаунчер не вернёт свои значения по умолчанию
    const saved = await readOverrides(dir);
    await fsp.writeFile(path.join(dir, OVERRIDES), JSON.stringify({ ...saved, ...values }, null, 2));
    for (const [k, v] of Object.entries(values)) {
      if (current[k] === v) continue;
      if (PROPS[k].live && this.server.state === 'running') this.server.command(PROPS[k].live(v));
      else later.push(k);
    }
    this.pendingRestart = new Set([...(this.pendingRestart || []), ...later]);
    return { restartNeeded: [...this.pendingRestart] };
  }

  /** Спросить у сервера значение правила: ответ приходит строкой журнала. */
  async askRule(name) {
    const re = new RegExp(`(?:Gamerule|Game rule) ${name} is (?:currently set to|now set to)?:? (\\S+)`, 'i');
    const bad = /Incorrect argument|Unknown or incomplete command|Unknown game ?rule|Invalid/i;
    const wait = new Promise((resolve) => {
      const t = setTimeout(() => (this.server.off('log', on), resolve(null)), 3000);
      const on = (line) => {
        const m = line.match(re);
        if (m) return clearTimeout(t), this.server.off('log', on), resolve(m[1]);
        if (bad.test(line)) return clearTimeout(t), this.server.off('log', on), resolve(undefined);
      };
      this.server.on('log', on);
    });
    this.server.command(`gamerule ${name}`);
    return wait;
  }

  /** Текущие правила игры (одно за другим: сервер отвечает в журнал). */
  async gamerules() {
    if (this.server.state !== 'running') throw new Error('Правила игры появятся, когда сервер запустится.');
    const out = {};
    for (const [rule, def] of Object.entries(RULES)) {
      let name = this.ruleNames.get(rule);
      let v = name ? await this.askRule(name) : undefined;
      if (v === undefined && !name) {
        const snake = rule.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());
        for (const n of [...new Set([rule, def.alt, snake])]) {
          v = await this.askRule(n);
          if (v !== undefined) {
            this.ruleNames.set(rule, (name = n));
            break;
          }
        }
      }
      if (v == null) continue; // правила нет в этой версии
      out[rule] = def.type === 'bool' ? v === 'true' : Number(v);
    }
    return out;
  }

  async setGamerule(rule, v) {
    const def = RULES[rule];
    if (!def) throw new Error('Неизвестное правило.');
    const val = value(def, v);
    const name = this.ruleNames.get(rule) || rule;
    this.server.command(`gamerule ${name} ${val}`);
    return { [rule]: val };
  }
}

module.exports = { ServerAdmin, PROPS, RULES, MODES, readOverrides };
