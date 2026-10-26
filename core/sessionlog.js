'use strict';
// Разбор журнала клиента Minecraft во время запуска из easyLauncher: какой мир был открыт и какие
// скриншоты сделаны в нём. Связь «скриншот → мир» считается достоверной только если скриншот
// сохранён внутри одиночной сессии, имя мира которой известно из журнала. Остальные скриншоты
// относятся только к сборке («последний скриншот сборки»).
const { EventEmitter } = require('events');

const RE = {
  spStart: /Starting integrated minecraft server version/,
  levelPrepare: /Preparing level "(.+?)"/,
  levelSave: /ServerLevel\[(.+?)\]/,
  spStop: /Stopping (?:integrated )?server|Stopping singleplayer server/,
  mpConnect: /Connecting to ([^,\s]+),\s*(\d+)/,
  disconnect: /Disconnected from server|Stopping!/,
  screenshot: /Saved screenshot as (\S+?\.(?:png|jpe?g))/i,
};

class SessionTracker extends EventEmitter {
  constructor() {
    super();
    this.current = null;
    this.looseShots = [];
  }

  feed(line) {
    let m;
    if (RE.spStart.test(line)) {
      this.end();
      this.current = { type: 'singleplayer', level: null, shots: [] };
      return;
    }
    if (this.current?.type === 'singleplayer' && !this.current.level && ((m = line.match(RE.levelPrepare)) || (m = line.match(RE.levelSave)))) {
      this.current.level = m[1];
      this.emit('world', m[1]);
      return;
    }
    if ((m = line.match(RE.screenshot))) {
      const file = m[1];
      if (this.current?.type === 'singleplayer') this.current.shots.push(file);
      else this.looseShots.push(file);
      this.emit('screenshot', { file, session: this.current?.type || 'menu' });
      return;
    }
    if ((m = line.match(RE.mpConnect))) {
      this.end();
      this.current = { type: 'multiplayer', server: `${m[1]}:${m[2]}`, shots: [] };
      return;
    }
    if (this.current?.type === 'singleplayer' && RE.spStop.test(line)) return this.end();
    if (this.current?.type === 'multiplayer' && RE.disconnect.test(line)) return this.end();
  }

  /** Завершение сессии: событие с миром (если известен) и скриншотами из него. */
  end() {
    const c = this.current;
    this.current = null;
    if (!c) return;
    if (c.type === 'singleplayer') this.emit('singleplayer-end', { level: c.level, shots: c.shots });
    else this.emit('multiplayer-end', { server: c.server, shots: c.shots });
  }

  /** Имя открытого сейчас одиночного мира (для защиты от копирования «живой» папки). */
  playingLevel() {
    return this.current?.type === 'singleplayer' ? this.current.level : null;
  }
}

module.exports = { SessionTracker };
