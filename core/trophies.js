'use strict';
// Трофеи лаунчера: значки за то, что игрок уже сделал. Считаются только по тому, что лаунчер и так записывает:
// часы и запуски (playlog), летопись миров (достижения, смерти, игровой день), ролики камеры, вызовы, скриншоты.
// Когда трофей получен впервые — дата сохраняется в trophies.json (трофей не пропадает, даже если мир удалили).
const path = require('path');
const { readJson, writeJson } = require('./store');
const { GOALS } = require('./challenges');

const norm = (s) => String(s || '').toLowerCase().replace(/[«»"[\]]/g, '').replace(/\.{3}|…/g, '').replace(/\s+/g, ' ').trim();
const goal = (id) => GOALS.find((g) => g.id === id);

// group — для порядка в окне; need — цель для полоски прогресса
const TROPHIES = [
  { id: 'hour1', group: 'Время', icon: '⏱️', title: 'Первый час', text: 'Провести в игре час', need: 1, of: (s) => s.hours },
  { id: 'hour10', group: 'Время', icon: '🕰️', title: 'Затянуло', text: '10 часов в игре', need: 10, of: (s) => s.hours },
  { id: 'hour100', group: 'Время', icon: '🏛️', title: 'Ветеран', text: '100 часов в игре', need: 100, of: (s) => s.hours },
  { id: 'launch50', group: 'Время', icon: '🚀', title: 'Завсегдатай', text: '50 запусков игры', need: 50, of: (s) => s.launches },
  { id: 'day10', group: 'Выживание', icon: '🌅', title: 'Освоился', text: 'Прожить 10 игровых дней в одном мире', need: 10, of: (s) => s.maxDay },
  { id: 'day50', group: 'Выживание', icon: '🌙', title: 'Пережил 50 ночей', text: '50 игровых дней в одном мире', need: 50, of: (s) => s.maxDay },
  { id: 'day100', group: 'Выживание', icon: '🗓️', title: 'Сотня дней', text: '100 игровых дней в одном мире', need: 100, of: (s) => s.maxDay },
  { id: 'death10', group: 'Выживание', icon: '💀', title: 'Учусь на ошибках', text: 'Умереть 10 раз (бывает)', need: 10, of: (s) => s.deaths },
  { id: 'adv_diamond', group: 'Достижения', icon: '💎', title: goal('diamond').ru, text: 'Найти алмаз', adv: 'diamond' },
  { id: 'adv_nether', group: 'Достижения', icon: '🔥', title: goal('nether').ru, text: 'Попасть в Незер', adv: 'nether' },
  { id: 'adv_fortress', group: 'Достижения', icon: '🏰', title: goal('fortress').ru, text: 'Найти крепость Незера', adv: 'fortress' },
  { id: 'adv_enchant', group: 'Достижения', icon: '✨', title: goal('enchant').ru, text: 'Зачаровать предмет', adv: 'enchant' },
  { id: 'adv_end', group: 'Достижения', icon: '🌌', title: goal('end').ru, text: 'Попасть в Край', adv: 'end' },
  { id: 'adv_dragon', group: 'Достижения', icon: '🐉', title: goal('dragon').ru, text: 'Победить дракона Края', adv: 'dragon' },
  { id: 'adv_tame', group: 'Достижения', icon: '🐺', title: goal('tame').ru, text: 'Приручить животное', adv: 'tame' },
  { id: 'adv_trade', group: 'Достижения', icon: '💰', title: goal('trade').ru, text: 'Поторговать с жителем', adv: 'trade' },
  { id: 'adv25', group: 'Достижения', icon: '🏅', title: 'Охотник за достижениями', text: '25 разных достижений', need: 25, of: (s) => s.advancements },
  { id: 'builds3', group: 'Лаунчер', icon: '📦', title: 'Коллекционер', text: 'Собрать 3 сборки', need: 3, of: (s) => s.builds },
  { id: 'mods50', group: 'Лаунчер', icon: '🧩', title: 'Мастер модов', text: '50 модов в одной сборке', need: 50, of: (s) => s.maxMods },
  { id: 'friends', group: 'Лаунчер', icon: '🤝', title: 'Вместе веселее', text: 'Сыграть с друзьями', need: 1, of: (s) => s.friendSessions },
  { id: 'challenge', group: 'Лаунчер', icon: '⚔️', title: 'Принял вызов', text: 'Выполнить вызов', need: 1, of: (s) => s.challenges },
  { id: 'clips10', group: 'Лаунчер', icon: '🎬', title: 'Режиссёр', text: '10 роликов камеры воспоминаний', need: 10, of: (s) => s.clips },
  { id: 'shots50', group: 'Лаунчер', icon: '📸', title: 'Фотограф', text: '50 скриншотов', need: 50, of: (s) => s.screenshots },
];

/** Выполнен ли трофей и насколько (0..1) по статистике. */
function check(t, s) {
  if (t.adv) {
    const g = goal(t.adv);
    const done = [g.ru, g.en].some((x) => s.advTitles.has(norm(x)));
    return { done, value: done ? 1 : 0, need: 1 };
  }
  const value = Math.max(0, Number(t.of(s)) || 0);
  return { done: value >= t.need, value: Math.min(value, t.need), need: t.need };
}

class Trophies {
  constructor(root) {
    this.file = path.join(root, 'trophies.json');
  }

  /**
   * Пересчитать: { list: [{id, title, text, icon, group, done, at, value, need}], fresh: [только что полученные] }.
   * at — когда трофей получен впервые; полученный однажды остаётся полученным.
   */
  async evaluate(stats) {
    const d = (await readJson(this.file)) || {};
    const earned = d.earned && typeof d.earned === 'object' ? d.earned : {};
    const fresh = [];
    const now = new Date().toISOString();
    const list = TROPHIES.map((t) => {
      const c = check(t, stats);
      if (c.done && !earned[t.id]) {
        earned[t.id] = now;
        fresh.push(t.id);
      }
      return { id: t.id, group: t.group, icon: t.icon, title: t.title, text: t.text, done: !!earned[t.id], at: earned[t.id] || null, value: earned[t.id] ? c.need : c.value, need: c.need };
    });
    if (fresh.length) await writeJson(this.file, { earned });
    return { list, fresh: list.filter((t) => fresh.includes(t.id)), earned: list.filter((t) => t.done).length, total: list.length };
  }
}

module.exports = { Trophies, TROPHIES, check, norm };
