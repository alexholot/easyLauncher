'use strict';
// Журнал игровых сессий сборки (profiles/<id>/playlog.json): когда играли, сколько, в каком мире, с кем.
// Пишется лаунчером по событиям клиента и сервера; из него считаются «часы в игре» и история на главной.
const path = require('path');
const { readJson, writeJson } = require('./store');

const KEEP = 300;

class PlayLog {
  constructor(store) {
    this.store = store;
    this.queue = Promise.resolve();
  }

  file(pid) {
    return path.join(this.store.profileDir(pid), 'playlog.json');
  }

  async read(pid) {
    const list = await readJson(this.file(pid), []);
    return Array.isArray(list) ? list : [];
  }

  /** entry: {mode: 'play'|'friends'|'guest', seconds, worlds?: [], players?: []} */
  add(pid, entry) {
    // записи идут по очереди: конец игры и конец сессии с друзьями могут прийти одновременно
    this.queue = this.queue.then(async () => {
      const list = await this.read(pid);
      list.push({
        at: new Date().toISOString(),
        mode: entry.mode,
        seconds: Math.max(0, Math.round(entry.seconds || 0)),
        worlds: [...new Set(entry.worlds || [])].slice(0, 5),
        players: [...new Set(entry.players || [])].slice(0, 20),
      });
      await writeJson(this.file(pid), list.slice(-KEEP));
    }).catch(() => {});
    return this.queue;
  }

  /** Итоги: всего секунд, число запусков, последняя сессия и последние записи (новые сверху). */
  async summary(pid, recent = 6) {
    const list = await this.read(pid);
    return {
      seconds: list.reduce((a, e) => a + (e.seconds || 0), 0),
      launches: list.filter((e) => e.mode !== 'friends').length,
      sessions: list.slice(-recent).reverse(),
    };
  }
}

module.exports = { PlayLog };
