'use strict';
// «Вызов другу»: цель (достижение игры) + лимит времени + правила на честность. Вызов — короткий код,
// который друг вставляет у себя; результат — тоже код, его можно отправить обратно и сравнить время.
// Время считается только игрой в мире вызова; цель засчитывается по строке достижения в журнале игры.
const path = require('path');
const crypto = require('crypto');
const { readJson, writeJson } = require('./store');

// названия — из языковых файлов Mojang (ru_ru одинаковы в 1.12–26.x) и английские
const GOALS = [
  { id: 'stone', ru: 'Каменный век', en: 'Stone Age', text: 'Добыть булыжник', min: [5, 10, 15] },
  { id: 'iron', ru: 'Куй железо...', en: 'Acquire Hardware', text: 'Выплавить железо', min: [10, 15, 20] },
  { id: 'iron_pick', ru: 'И кирка без дела ржавеет', en: "Isn't It Iron Pick", text: 'Сделать железную кирку', min: [10, 15, 20] },
  { id: 'lava', ru: 'Горячая штучка', en: 'Hot Stuff', text: 'Набрать ведро лавы', min: [15, 20, 30] },
  { id: 'diamond', ru: 'Алмазы!', en: 'Diamonds!', text: 'Найти алмаз', min: [20, 30, 45] },
  { id: 'obsidian', ru: 'Две стихии', en: 'Ice Bucket Challenge', text: 'Добыть обсидиан', min: [20, 30, 45] },
  { id: 'nether', ru: 'Огненные недра', en: 'We Need to Go Deeper', text: 'Попасть в Незер', min: [20, 30, 45] },
  { id: 'fortress', ru: 'Чертоги страха', en: 'A Terrible Fortress', text: 'Найти крепость Незера', min: [30, 45, 60] },
  { id: 'blaze', ru: 'В полымя', en: 'Into Fire', text: 'Добыть огненный стержень', min: [30, 45, 60] },
  { id: 'enchant', ru: 'Чародей', en: 'Enchanter', text: 'Зачаровать предмет', min: [30, 45, 60] },
  { id: 'eye', ru: 'Недреманное око', en: 'Eye Spy', text: 'Найти крепость Края по оку', min: [45, 60, 90] },
  { id: 'end', ru: 'Конец?', en: 'The End?', text: 'Попасть в Край', min: [45, 60, 90] },
  { id: 'dragon', ru: 'Освободите Энд', en: 'Free the End', text: 'Победить дракона', min: [60, 90, 120] },
  { id: 'trade', ru: 'Не отходя от кассы!', en: 'What a Deal!', text: 'Поторговать с жителем', min: [15, 30, 45] },
  { id: 'tame', ru: 'Друг человека', en: 'Best Friends Forever', text: 'Приручить животное', min: [10, 15, 20] },
];
const RULES = [
  { id: 'hardcore', text: 'Мир в режиме «Хардкор»' },
  { id: 'no_sleep', text: 'Не спать в кровати' },
  { id: 'no_shield', text: 'Без щита' },
  { id: 'no_boat', text: 'Без лодки' },
  { id: 'peaceful_no', text: 'Сложность не ниже «Нормальной»' },
  { id: 'no_chests', text: 'Не открывать сундуки сокровищниц' },
  { id: 'wood_only', text: 'Только деревянные и каменные инструменты' },
  { id: 'no_f3', text: 'Без F3 (не смотреть координаты)' },
];

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const unb64 = (s) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
const norm = (s) => String(s || '').toLowerCase().replace(/[«»"[\]]/g, '').replace(/\.{3}|…/g, '').replace(/\s+/g, ' ').trim();

/** Код вызова → вызов. Принимаются только известные цели и правила, разумный лимит. */
function parseChallenge(code) {
  const m = /^EL1-([\w-]{8,600})$/.exec(String(code || '').trim());
  if (!m) throw new Error('Это не код вызова: он начинается с «EL1-».');
  let o;
  try {
    o = unb64(m[1]);
  } catch {
    throw new Error('Код вызова повреждён — попроси друга скопировать его заново.');
  }
  const goal = GOALS.find((g) => g.id === o.g);
  if (!goal || !Number.isInteger(o.l) || o.l < 1 || o.l > 600) throw new Error('В коде неизвестная цель или странный лимит времени.');
  return { goal: goal.id, limitMin: o.l, rules: (Array.isArray(o.r) ? o.r : []).filter((r) => RULES.some((x) => x.id === r)), from: String(o.n || '').slice(0, 16), seed: String(o.s || '').slice(0, 12) };
}

function makeCode({ goal, limitMin, rules, from }) {
  return 'EL1-' + b64({ g: goal, l: limitMin, r: rules, n: from, s: crypto.randomBytes(4).toString('hex') });
}

/** Код результата: цель, время в секундах, ник, к какому вызову (seed). Честность — на совести игроков. */
function makeResult(ch, seconds, nick) {
  return 'EL1R-' + b64({ g: ch.goal, t: Math.round(seconds), n: nick, s: ch.seed, l: ch.limitMin });
}
function parseResult(code) {
  const m = /^EL1R-([\w-]{8,400})$/.exec(String(code || '').trim());
  if (!m) throw new Error('Это не код результата: он начинается с «EL1R-».');
  let o;
  try {
    o = unb64(m[1]);
  } catch {
    throw new Error('Код результата повреждён.');
  }
  if (!GOALS.some((g) => g.id === o.g) || !Number.isFinite(o.t) || o.t < 0) throw new Error('В коде результата странные данные.');
  return { goal: o.g, seconds: Math.round(o.t), nick: String(o.n || 'Друг').slice(0, 16), seed: String(o.s || '').slice(0, 12), limitMin: o.l };
}

class Challenges {
  constructor(root) {
    this.file = path.join(root, 'challenges.json');
  }
  async data() {
    const d = (await readJson(this.file)) || {};
    return { active: d.active || null, history: Array.isArray(d.history) ? d.history.slice(-30) : [] };
  }
  async save(d) {
    await writeJson(this.file, d);
  }

  /** Новый вызов: случайная цель и правила (или заданные), код для друга. Сам игрок тоже его принимает. */
  create({ goal, limitMin, rules, from }) {
    const g = GOALS.find((x) => x.id === goal) || GOALS[crypto.randomInt(GOALS.length)];
    const lim = Number.isInteger(limitMin) && limitMin >= 1 && limitMin <= 600 ? limitMin : g.min[1];
    const rs = Array.isArray(rules) ? rules.filter((r) => RULES.some((x) => x.id === r)).slice(0, 3) : [];
    return makeCode({ goal: g.id, limitMin: lim, rules: rs, from: String(from || '').slice(0, 16) });
  }

  /** Случайный вызов «удиви»: цель, подходящий лимит и 1–2 правила. */
  random(from) {
    const g = GOALS[crypto.randomInt(GOALS.length)];
    const rules = RULES.slice().sort(() => Math.random() - 0.5).slice(0, 1 + crypto.randomInt(2)).map((r) => r.id);
    return this.create({ goal: g.id, limitMin: g.min[crypto.randomInt(g.min.length)], rules, from });
  }

  async accept(code) {
    const ch = parseChallenge(code);
    const d = await this.data();
    if (d.active && !d.active.done) d.history.push({ ...d.active, abandoned: true });
    d.active = { code: String(code).trim(), ...ch, acceptedAt: new Date().toISOString(), pid: null, folder: null, playedMs: 0, sessionStart: null, done: null };
    await this.save(d);
    return this.view(d.active);
  }

  async abandon() {
    const d = await this.data();
    if (d.active) d.history.push({ ...d.active, abandoned: !d.active.done });
    d.active = null;
    await this.save(d);
    return true;
  }

  /**
   * Вход в мир. Вызов привязывается к первому НОВОМУ миру после принятия (у которого ещё нет летописи):
   * старый мир с готовыми алмазами не годится. Дальше время считается только в нём.
   */
  async worldBegin(pid, folder, { isNew }) {
    const d = await this.data();
    const a = d.active;
    if (!a || a.done) return null;
    if (!a.folder && isNew) Object.assign(a, { pid, folder });
    if (a.pid !== pid || a.folder !== folder) return null;
    a.sessionStart = Date.now();
    await this.save(d);
    return a;
  }

  async worldEnd(pid, folder) {
    const d = await this.data();
    const a = d.active;
    if (!a || a.done || a.pid !== pid || a.folder !== folder || !a.sessionStart) return;
    a.playedMs += Date.now() - a.sessionStart;
    a.sessionStart = null;
    await this.save(d);
  }

  /** Достижение в мире вызова: совпало с целью — вызов выполнен, время и код результата. */
  async moment(pid, folder, m, nick) {
    const d = await this.data();
    const a = d.active;
    if (!a || a.done || a.pid !== pid || a.folder !== folder || m.kind === 'death') return null;
    const g = GOALS.find((x) => x.id === a.goal);
    if (![g.ru, g.en].some((t) => norm(t) === norm(m.title))) return null;
    const ms = a.playedMs + (a.sessionStart ? Date.now() - a.sessionStart : 0);
    a.done = { at: new Date().toISOString(), seconds: Math.round(ms / 1000), inTime: ms <= a.limitMin * 60000 };
    a.result = makeResult(a, ms / 1000, nick);
    a.sessionStart = null;
    a.playedMs = ms;
    d.history.push({ ...a });
    await this.save(d);
    return this.view(a);
  }

  /** Для окна: цель словами, правила, сколько сыграно и осталось. */
  view(a) {
    if (!a) return null;
    const g = GOALS.find((x) => x.id === a.goal);
    const played = a.playedMs + (a.sessionStart ? Date.now() - a.sessionStart : 0);
    return {
      code: a.code,
      goal: { id: g.id, text: g.text, title: g.ru },
      limitMin: a.limitMin,
      rules: a.rules.map((r) => RULES.find((x) => x.id === r)?.text).filter(Boolean),
      from: a.from,
      seed: a.seed,
      acceptedAt: a.acceptedAt,
      world: a.folder,
      pid: a.pid,
      playedSec: Math.round(played / 1000),
      running: !!a.sessionStart,
      done: a.done,
      result: a.result || null,
    };
  }

  async status() {
    const d = await this.data();
    return { active: this.view(d.active), history: d.history.filter((h) => h.done).slice(-10).reverse().map((h) => this.view(h)) };
  }
}

module.exports = { Challenges, GOALS, RULES, parseChallenge, parseResult, makeResult };
