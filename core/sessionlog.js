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

// Достижения: английский и русский текст игры (строки chat.type.advancement.* из языковых файлов Mojang)
const ADVANCEMENT = [
  [/ has completed the challenge (.+)$/, 'challenge'],
  [/ завершил испытание (.+)$/, 'challenge'],
  [/ has reached the goal (.+)$/, 'goal'],
  [/ достиг цели (.+)$/, 'goal'],
  [/ has made the advancement (.+)$/, 'advancement'],
  [/ получил достижение (.+)$/, 'advancement'],
];
// служебные сообщения, которые тоже начинаются с ника, но это не смерть
const NOT_DEATH = /^ ?(?:joined the game|left the game|присоединился к игре|покинул игру|lost connection|\(formerly known as|\(ранее известный как|has the following|is now|теперь|moved too quickly|moved wrongly)/;
// глаголы смерти — для строк без пометки чата (журнал сервера старых версий)
const DEATH_WORDS = /\b(?:was (?:slain|shot|killed|blown up|fireballed|pummeled|squashed|impaled|stung|poked|pricked|skewered|struck|frozen|obliterated)|drowned|died|fell|hit the ground|blew up|burned|went up in flames|tried to swim in lava|starved|suffocated|froze to death|withered away|experienced kinetic energy|discovered the floor was lava|walked into)|(?:был убит|был застрелен|был взорван|был заколот|был раздавлен|утонул|разбился|взорвался|умер|сгорел|погиб|решил поплавать в лаве|задохнулся|замёрз|иссох|изжарился|был сражён)/;

/**
 * Момент игрока из строки журнала: достижение, испытание, цель или смерть. null — не момент.
 * Строка может быть обычной («[12:00:00] [Server thread/INFO]: System chat: …»), с «[System] [CHAT]» (клиент 1.19+)
 * или в XML-раскладке log4j (официальная настройка журнала Mojang: текст внутри CDATA).
 */
function parseMoment(line, player) {
  if (!player) return null;
  let text = String(line).replace(/^.*<!\[CDATA\[/, '').replace(/\]\]>.*$/, '');
  text = text.replace(/^\s*\[[^\]]*\]\s*\[[^\]]*\]:\s*/, ''); // [время] [поток/уровень]:
  const chat = /^(?:System chat: |\[System\] \[CHAT\] |\[CHAT\] )/.test(text);
  text = text.replace(/^(?:System chat: |\[System\] \[CHAT\] |\[CHAT\] )/, '').replace(/§./g, '').trim();
  if (!text.startsWith(player + ' ')) return null;
  for (const [re, kind] of ADVANCEMENT) {
    const m = text.match(re);
    if (m) return { kind, title: m[1].replace(/^[«"[]+|[»"\]]+$/g, '').trim().slice(0, 80), text: text.slice(0, 200) };
  }
  const rest = text.slice(player.length);
  if (NOT_DEATH.test(rest)) return null;
  if (chat || DEATH_WORDS.test(rest)) return { kind: 'death', title: rest.trim().slice(0, 80), text: text.slice(0, 200) };
  return null;
}

class SessionTracker extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.current = null;
    this.looseShots = [];
    this.player = opts.player || null;
    this.lastMoment = { text: '', at: 0 };
  }

  feed(line) {
    let m;
    const moment = parseMoment(line, this.player);
    // одно и то же событие пишут и сервер («System chat»), и клиент («[CHAT]») — считаем один раз
    if (moment && !(moment.text === this.lastMoment.text && Date.now() - this.lastMoment.at < 5000)) {
      this.lastMoment = { text: moment.text, at: Date.now() };
      this.emit('moment', moment);
      return;
    }
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
      if (this.current) this.current.shots.push(file); // и на сервере: у хозяина это его мир
      else this.looseShots.push(file);
      this.emit('screenshot', { file, session: this.current?.type || 'menu' });
      return;
    }
    if ((m = line.match(RE.mpConnect))) {
      this.end();
      this.current = { type: 'multiplayer', server: `${m[1]}:${m[2]}`, shots: [] };
      this.emit('multiplayer', { server: this.current.server });
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

module.exports = { SessionTracker, parseMoment };
