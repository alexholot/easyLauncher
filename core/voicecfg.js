'use strict';
// Настройки голосового чата (как в модах Simple Voice Chat / Plasmo Voice) и индикация говорящего в игре.

// кнопка микрофона во время игры: Windows сообщает лаунчеру только нажатие (не отпускание), поэтому
// «по кнопке» — нажал — микрофон включён, нажал ещё раз — выключен. Только клавиши, которые игра не занимает.
const HOTKEYS = ['F6', 'F7', 'F8', 'F9', 'F10', 'Alt+V', 'Alt+B', 'Alt+M', 'Ctrl+Alt+V', 'Ctrl+Alt+M'];

const DEFAULT = {
  mode: 'voice', // 'voice' — включается голосом; 'toggle' — кнопкой
  hotkey: 'F8',
  threshold: 0.012, // порог громкости (RMS), выше которого считаем, что человек говорит
  micId: '', // '' — микрофон по умолчанию Windows
  outId: '', // '' — наушники/колонки по умолчанию
  micGain: 1, // усиление своего микрофона
  volume: 1, // громкость друзей (общая)
  noise: true, // шумоподавление
  echo: true, // эхоподавление
  agc: true, // автогромкость микрофона
  tab: true, // в игре: значок ♪ у ника в табе и над головой, пока человек говорит (у хозяина сессии)
  actionbar: false, // в игре: надпись над хотбаром «♪ Ник говорит»
  spatial: true, // объёмный звук: друга слышно с той стороны, где стоит его персонаж, и тише с расстоянием
  range: 48, // дальше скольких блоков друга не слышно
  peers: {}, // ник → { volume, muted } — громкость каждого друга отдельно
};

const num = (v, lo, hi, d) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : d);
const id = (v) => (typeof v === 'string' && v.length <= 200 && /^[\w=+/.-]*$/.test(v) ? v : '');

/** Привести настройки к безопасному виду: только известные поля и значения в разумных пределах. */
function normalizeVoice(v) {
  const s = v && typeof v === 'object' ? v : {};
  const peers = {};
  for (const [name, p] of Object.entries(s.peers && typeof s.peers === 'object' ? s.peers : {}).slice(0, 100)) {
    if (!/^[A-Za-z0-9_]{1,16}$/.test(name) || !p || typeof p !== 'object') continue;
    peers[name] = { volume: num(p.volume, 0, 2, 1), muted: p.muted === true };
  }
  return {
    mode: s.mode === 'toggle' ? 'toggle' : 'voice',
    hotkey: HOTKEYS.includes(s.hotkey) ? s.hotkey : DEFAULT.hotkey,
    threshold: num(s.threshold, 0.001, 0.2, DEFAULT.threshold),
    micId: id(s.micId),
    outId: id(s.outId),
    micGain: num(s.micGain, 0, 3, 1),
    volume: num(s.volume, 0, 2, 1),
    noise: s.noise !== false,
    echo: s.echo !== false,
    agc: s.agc !== false,
    tab: s.tab !== false,
    actionbar: s.actionbar === true,
    spatial: s.spatial !== false,
    range: Math.round(num(s.range, 8, 128, DEFAULT.range)),
    peers,
  };
}

/**
 * Команды сервера Minecraft для значка говорящего. Команды игроков с приставкой (team modify … suffix)
 * есть с 1.13: приставка видна в табе и над головой. До 1.13 — только надпись над хотбаром (title … actionbar
 * есть с 1.11) или ничего. Ник — только допустимый в Minecraft (иначе команда не отправляется).
 */
// ♪ — кодом \\u266a: команда целиком из латиницы, консоль сервера (кодировка Windows) не испортит символ
const TEAM = 'el_voice';
const NICK = /^[A-Za-z0-9_]{1,16}$/;
function versionAtLeast(mc, major, minor) {
  const m = /^(\d+)\.(\d+)/.exec(String(mc || ''));
  if (!m) return false; // снапшоты вида 24w14a, альфа и бета — не трогаем
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a > major || (a === major && b >= minor);
}
function indicatorSupport(mc) {
  // объёмный звук: координаты игроков даёт команда data get entity (1.13+)
  return { tab: versionAtLeast(mc, 1, 13), actionbar: versionAtLeast(mc, 1, 11), spatial: versionAtLeast(mc, 1, 13) };
}
const voiceCommands = {
  // team empty — если прошлая сессия оборвалась посреди фразы, значок не остаётся у ника навсегда
  setup: () => [`team add ${TEAM}`, `team modify ${TEAM} suffix {"text":" \\u266a","color":"green","bold":true}`, `team empty ${TEAM}`],
  speak: (name, on) => (NICK.test(name) ? [on ? `team join ${TEAM} ${name}` : `team leave ${name}`] : []),
  actionbar: (names) => (names.every((n) => NICK.test(n)) ? [`title @a actionbar {"text":"\\u266a ${names.join(', ')}","color":"green"}`] : []),
  teardown: () => [`team remove ${TEAM}`],
};

module.exports = { normalizeVoice, HOTKEYS, DEFAULT_VOICE: DEFAULT, voiceCommands, indicatorSupport, versionAtLeast, VOICE_TEAM: TEAM };
