'use strict';
// Голосовой чат в сессии с друзьями: микрофон → Opus (WebCodecs) → по соединению сессии → у друзей
// декодируется и играет с небольшим буфером против рывков сети. Настройки — как в модах голосового чата:
// режим (голосом / по кнопке), порог, устройства, усиление, обработка звука, громкость каждого друга, значок в игре.

// те же клавиши, что разрешает главный процесс (core/voicecfg.js)
const VOICE_KEYS = ['F6', 'F7', 'F8', 'F9', 'F10', 'Alt+V', 'Alt+B', 'Alt+M', 'Ctrl+Alt+V', 'Ctrl+Alt+M'];
const VOICE_HANG_MS = 400; // после конца фразы ещё немного шлём, чтобы не обрезать слова

const VC = {
  status: { available: false, joined: false, roster: [], role: null, me: null },
  cfg: null, // настройки голоса (S.settings.voice)
  muted: false, // микрофон выключен (режим «голосом»)
  open: false, // микрофон включён кнопкой (режим «по кнопке»)
  ctx: null,
  master: null, // общая громкость друзей
  peerGain: new Map(), // id → GainNode друга
  panners: new Map(), // id → PannerNode друга (объёмный звук: с какой стороны)
  distGain: new Map(), // id → GainNode друга (объёмный звук: громкость по расстоянию)
  fresh: new WeakSet(), // только что созданные узлы звука — им место и громкость ставятся сразу, без плавного перехода
  held: {}, // ник → {p, at} — последнее известное место (координаты на миг пропали — без скачка громкости)
  positions: {}, // ник → [x, y, z, поворот, измерение] — от сервера сессии
  micGain: null,
  monitor: false, // «прослушать себя»
  mic: null,
  reader: null,
  enc: null,
  decoders: new Map(),
  next: new Map(),
  heard: new Map(),
  lastLoud: 0,
  level: 0,
  dropped: 0,
};
const cfg = () => VC.cfg || (VC.cfg = { ...(S.settings?.voice || {}) });
const peerCfg = (name) => cfg().peers?.[name] || { volume: 1, muted: false };
const nameOfPeer = (id) => VC.status.roster.find((r) => r.id === id)?.name || '';

// файл грузится раньше app.js (там объявлен bridge) — берём мост напрямую
window.easy.onVoice((ev) => {
  if (ev.type === 'roster') {
    VC.status = { ...VC.status, roster: ev.roster || [], joined: ev.joined ?? VC.status.joined };
    if (!VC.status.joined) voiceGone();
    applyPeerVolumes();
    paintVoice();
  } else if (ev.type === 'audio') playVoice(ev);
  else if (ev.type === 'positions') onPositions(ev.players);
  else if (ev.type === 'hotkey') voiceHotkey();
  else if (ev.type === 'test') refreshVoice().then(() => paintVoiceTest());
});

/** Где стоят игроки (от сервера сессии). Ответ сервера иногда запаздывает — последнее место держим ещё 3 с,
 * а не сразу «по центру в полную громкость» (иначе громкость прыгала бы). */
function onPositions(players) {
  const now = Date.now();
  for (const [n, p] of Object.entries(players || {})) VC.held[n] = { p, at: now };
  for (const n of Object.keys(VC.held)) if (now - VC.held[n].at > 3000) delete VC.held[n];
  VC.positions = Object.fromEntries(Object.entries(VC.held).map(([n, h]) => [n, h.p]));
  applySpatial();
}

/**
 * Объёмный звук: слушатель — свой персонаж (место и поворот головы), каждый друг — там, где стоит его
 * персонаж. Ближе 4 блоков — в полную громкость, дальше — тише, за дальностью слышимости и в другом
 * измерении — не слышно. Кто не в игре (или своя игра не запущена) — звучит как обычно, по центру.
 */
function applySpatial() {
  paintDistances();
  const ctx = VC.ctx;
  if (!ctx) return;
  const c = cfg();
  const P = VC.positions || {};
  const me = c.spatial !== false ? P[VC.status.me] : null;
  const t = ctx.currentTime;
  // плавно — пока игроки двигаются; сразу — для только что созданного звука (иначе начало фразы далёкого
  // друга прозвучало бы в полную громкость и по центру, а потом бы затихало)
  const fresh = (node) => VC.fresh.delete(node);
  const set = (param, v, now = false) => param && (now ? param.setValueAtTime(v, t) : param.setTargetAtTime(v, t, 0.08));
  const L = ctx.listener;
  const lnow = fresh(L);
  const at = me ? me.slice(0, 3) : [0, 0, 0];
  // Minecraft: поворот 0 — смотрит на юг (+Z), 90 — на запад (−X); оси те же, что у Web Audio
  const yaw = ((me?.[3] || 0) * Math.PI) / 180;
  set(L.positionX, at[0], lnow);
  set(L.positionY, at[1], lnow);
  set(L.positionZ, at[2], lnow);
  set(L.forwardX, me ? -Math.sin(yaw) : 0, lnow);
  set(L.forwardY, 0, lnow);
  set(L.forwardZ, me ? Math.cos(yaw) : -1, lnow);
  set(L.upX, 0, lnow);
  set(L.upY, 1, lnow);
  set(L.upZ, 0, lnow);
  for (const [id, p] of VC.panners) {
    const q = me ? P[nameOfPeer(id)] : null;
    const otherWorld = q && me[4] && q[4] && q[4] !== me[4];
    const now = fresh(p);
    // сторона — панорама (HRTF); громкость — отдельно, своей кривой
    const to = q && !otherWorld ? q : at;
    set(p.positionX, to[0], now);
    set(p.positionY, to[1], now);
    set(p.positionZ, to[2], now);
    const dg = VC.distGain.get(id);
    const v = !q ? 1 : otherWorld ? 0 : distanceGain(Math.hypot(q[0] - at[0], q[1] - at[1], q[2] - at[2]), c.range || 48);
    if (dg) now ? dg.gain.setValueAtTime(v, t) : dg.gain.setTargetAtTime(v, t, 0.15);
  }
}

/**
 * Громкость по расстоянию «как в жизни»: до 2 блоков — полная, дальше спадает по квадрату и к краю дальности
 * плавно уходит в ноль (на 48 блоках: 10 бл. ≈ 68%, 24 бл. ≈ 27%, 36 бл. ≈ 7%, 48 — тишина).
 * Прямая линия на слух почти не тише — так было до 4.5.1.
 */
function distanceGain(d, range) {
  const t = (d - 2) / Math.max(1, range - 2);
  if (t <= 0) return 1;
  if (t >= 1) return 0;
  return (1 - t) * (1 - t);
}

/** Расстояние до друзей — в панели (и когда микрофон ещё не включён). */
function paintDistances() {
  const c = cfg();
  const P = VC.positions || {};
  const me = c.spatial !== false ? P[VC.status.me] : null;
  $$('[data-voice-peer]').forEach((li) => {
    const s = li.querySelector('.voice-dist');
    if (!s) return;
    const q = me ? P[nameOfPeer(Number(li.dataset.voicePeer))] : null;
    if (!q) return (s.textContent = '');
    if (me[4] && q[4] && q[4] !== me[4]) return (s.textContent = 'другой мир');
    const d = Math.round(Math.hypot(q[0] - me[0], q[1] - me[1], q[2] - me[2]));
    // в узкой панели — коротко; точное расстояние — в подсказке
    s.textContent = d > (c.range || 48) ? 'не слышно' : `${d} бл.`;
    s.title = `${d} блоков`;
  });
}

/** Обновить панель голоса (вызывается при смене состояния сессии). */
async function refreshVoice() {
  VC.status = await call('voice:status').catch(() => ({ available: false, joined: false, roster: [] }));
  if (!VC.status.available || !VC.status.joined) voiceGone();
  paintVoice();
}

/**
 * Сессия закончилась или из голоса вышли не кнопкой (хозяин закрыл комнату, связь оборвалась): микрофон
 * отпускается, клавиша микрофона возвращается другим программам (иначе F8 и т. п. оставалась бы занята
 * лаунчером), координаты прошлой сессии забываются (иначе друг в новой сессии звучал бы «далеко»).
 */
function voiceGone() {
  if (VC.joining) return; // как раз входим — состояние «ещё не в голосе» устарело через миг
  if (VC.mic && !VC.monitorOnly) stopMic();
  if (VC.keyHeld) {
    VC.keyHeld = false;
    call('voice:hotkey', null).catch(() => {});
  }
  if (!VC.status.available) {
    VC.held = {};
    VC.positions = {};
  }
}

/** Передаётся ли сейчас голос (для полоски и подсказки). */
function transmitting() {
  if (cfg().mode === 'toggle') return VC.open;
  return !VC.muted && Date.now() - VC.lastLoud < VOICE_HANG_MS;
}

function paintVoice() {
  let dock = $('#voice-dock');
  if (!dock) {
    dock = document.createElement('div');
    dock.id = 'voice-dock';
    dock.className = 'voice-dock';
    $('#account-chip').before(dock);
  }
  const st = VC.status;
  dock.hidden = !st.available;
  if (!st.available) return;
  if (!st.joined) {
    dock.innerHTML = `<div class="voice-acts"><button class="btn btn-secondary btn-small voice-join" id="voice-join" title="Голосовой чат">${icon('mic')}<span>Голосовой чат</span></button><button class="icon-button" id="voice-cfg" title="Настройки голоса">${icon('settings')}</button></div>${st.roster.length ? `<small class="hint">Уже говорят: ${esc(st.roster.map((r) => r.name).join(', '))}</small>` : ''}`;
    $('#voice-join').onclick = voiceJoin;
    $('#voice-cfg').onclick = voiceSettingsDialog;
    return;
  }
  const c = cfg();
  const toggle = c.mode === 'toggle';
  const micOff = toggle ? !VC.open : VC.muted;
  dock.innerHTML = `<div class="voice-head"><b>Голос</b><span class="voice-level" title="Твой микрофон"><i></i><s style="left:${Math.min(100, Math.round(c.threshold * 900))}%"></s></span></div>
    <ul class="voice-list">${st.roster
      .map((r) => {
        const pc = r.name === st.me ? null : peerCfg(r.name);
        return `<li data-voice-peer="${r.id}" class="${pc?.muted ? 'muted' : ''}" title="${esc(r.name)}"><span class="voice-dot"></span><span class="voice-name">${esc(r.name)}</span>${r.name === st.me ? ' <small>(ты)</small>' : `${pc?.muted ? ` ${icon('micOff')}` : ''}<small class="voice-dist"></small>`}</li>`;
      })
      .join('') || '<li class="hint">Пока никого — позови друзей в голос</li>'}</ul>
    <small class="hint voice-mode">${toggle ? `Микрофон: ${VC.open ? 'включён' : 'выключен'} · ${esc(c.hotkey)}` : VC.muted ? 'Микрофон выключен' : 'Включается голосом'}</small>
    <div class="voice-acts"><button class="icon-button ${micOff ? 'on' : ''}" id="voice-mute" title="${micOff ? 'Включить микрофон' : 'Выключить микрофон'}" aria-pressed="${micOff}">${icon(micOff ? 'micOff' : 'mic')}</button><button class="icon-button" id="voice-cfg" title="Настройки голоса">${icon('settings')}</button><span class="spacer"></span><button class="btn btn-ghost btn-small" id="voice-leave" title="Выйти из голосового чата">${icon('close')}<span>Выйти</span></button></div>`;
  $('#voice-mute').onclick = () => {
    if (toggle) VC.open = !VC.open;
    else VC.muted = !VC.muted;
    blip(micOff); // был выключен — теперь включён
    paintVoice();
  };
  $('#voice-cfg').onclick = voiceSettingsDialog;
  $('#voice-leave').onclick = voiceLeave;
  paintLevels(); // подсветка говорящих и полоска — сразу, не дожидаясь следующего кадра микрофона
  applySpatial(); // и расстояния до друзей
}

/** Клавиша во время игры: «по кнопке» — включить/выключить микрофон, «голосом» — выключить/включить. */
function voiceHotkey() {
  if (!VC.status.joined || !VC.mic) return;
  if (cfg().mode === 'toggle') VC.open = !VC.open;
  else VC.muted = !VC.muted;
  const on = cfg().mode === 'toggle' ? VC.open : !VC.muted;
  blip(on);
  paintVoice();
}

/** Короткий сигнал — его слышно прямо в игре: высокий — микрофон включён, низкий — выключен. */
function blip(on) {
  if (!VC.ctx) return;
  const o = VC.ctx.createOscillator();
  const g = VC.ctx.createGain();
  o.frequency.value = on ? 880 : 440;
  g.gain.setValueAtTime(0.12, VC.ctx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, VC.ctx.currentTime + 0.12);
  o.connect(g).connect(VC.ctx.destination);
  o.start();
  o.stop(VC.ctx.currentTime + 0.13);
}

async function voiceJoin() {
  // двойной клик не должен открыть микрофон дважды (второй остался бы включённым навсегда)
  if (VC.joining) return;
  VC.joining = true;
  try {
    await voiceJoinNow();
  } finally {
    VC.joining = false;
  }
}

async function voiceJoinNow() {
  VC.cfg = { ...(S.settings?.voice || {}) };
  VC.monitorOnly = false; // микрофон из проверки «прослушать себя» теперь для голоса
  try {
    await startMic();
  } catch (e) {
    return errorDialog({ message: /Permission|NotAllowed/i.test(e.name + e.message) ? 'Нет доступа к микрофону. Разреши его в «Параметры Windows → Конфиденциальность → Микрофон».' : `Микрофон не включился: ${e.message}` }, 'Голосовой чат');
  }
  try {
    VC.status = await call('voice:join');
  } catch (e) {
    stopMic();
    return errorDialog(e, 'Голосовой чат');
  }
  VC.open = false;
  VC.muted = false;
  await registerVoiceKey();
  toast(cfg().mode === 'toggle' ? `Ты в голосовом чате. Микрофон включается клавишей ${cfg().hotkey} — даже во время игры.` : `Ты в голосовом чате. Микрофон включается, когда ты говоришь; ${cfg().hotkey} — выключить на время.`);
  paintVoice();
}

/** Клавиша микрофона работает и когда окно лаунчера не в фокусе (во время игры). */
async function registerVoiceKey() {
  try {
    const r = await call('voice:hotkey', VC.mic ? cfg().hotkey : null);
    VC.keyHeld = !!r?.key;
  } catch (e) {
    VC.keyHeld = false;
    toast(e.message);
  }
}

async function voiceLeave() {
  stopMic();
  VC.keyHeld = false;
  await call('voice:hotkey', null).catch(() => {});
  VC.status = await call('voice:leave').catch(() => VC.status);
  paintVoice();
}

/** Микрофон: выбранное устройство → усиление → 48 кГц моно → Opus; шлём, когда говорят (или включено кнопкой). */
function startMic() {
  // пока микрофон открывается (разрешение, устройство), второй вызов ждёт этот же, а не открывает ещё один
  if (VC.starting) return VC.starting;
  if (VC.mic) return Promise.resolve();
  VC.starting = startMicNow().finally(() => (VC.starting = null));
  return VC.starting;
}

async function startMicNow() {
  if (typeof AudioEncoder === 'undefined') throw new Error('эта версия окна не умеет кодировать звук');
  const c = cfg();
  VC.mic = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: c.micId ? { exact: c.micId } : undefined, echoCancellation: c.echo !== false, noiseSuppression: c.noise !== false, autoGainControl: c.agc !== false, channelCount: 1 } });
  VC.ctx = new AudioContext({ sampleRate: 48000 });
  if (c.outId && VC.ctx.setSinkId) await VC.ctx.setSinkId(c.outId).catch(() => {});
  VC.fresh.add(VC.ctx.listener);
  VC.master = VC.ctx.createGain();
  VC.master.gain.value = c.volume ?? 1;
  VC.master.connect(VC.ctx.destination);
  const src = VC.ctx.createMediaStreamSource(VC.mic);
  VC.micGain = VC.ctx.createGain();
  VC.micGain.gain.value = c.micGain ?? 1;
  const dst = VC.ctx.createMediaStreamDestination();
  dst.channelCount = 1;
  dst.channelCountMode = 'explicit';
  src.connect(VC.micGain).connect(dst);
  if (VC.monitor) VC.micGain.connect(VC.ctx.destination);
  const track = dst.stream.getAudioTracks()[0];
  VC.reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
  VC.enc = new AudioEncoder({
    output: (chunk) => {
      const b = new Uint8Array(chunk.byteLength);
      chunk.copyTo(b);
      window.easy.voiceSend(b);
    },
    error: () => {},
  });
  let configured = false;
  const reader = VC.reader;
  (async () => {
    let lastPaint = 0;
    for (;;) {
      let r;
      try {
        r = await reader.read();
      } catch {
        break;
      }
      if (r.done || VC.reader !== reader) {
        r.value?.close();
        break;
      }
      const ad = r.value;
      if (!configured) {
        VC.enc.configure({ codec: 'opus', sampleRate: ad.sampleRate, numberOfChannels: ad.numberOfChannels, bitrate: 24000 });
        configured = true;
      }
      const pcm = new Float32Array(ad.numberOfFrames);
      ad.copyTo(pcm, { planeIndex: 0, format: 'f32-planar' });
      let sum = 0;
      for (let i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i];
      VC.level = Math.sqrt(sum / (pcm.length || 1));
      const now = Date.now();
      if (VC.level > (cfg().threshold ?? 0.012)) VC.lastLoud = now;
      if (transmitting() && VC.enc.state === 'configured') VC.enc.encode(ad);
      ad.close();
      if (now - lastPaint > 120) {
        lastPaint = now;
        paintLevels();
      }
    }
  })();
}

/** Полоски громкости (в панели и в окне настроек) и подсветка говорящих. */
function paintLevels() {
  const w = `${Math.min(100, Math.round(VC.level * 900))}%`;
  const live = transmitting();
  for (const bar of $$('.voice-level > i, #vs-meter > i')) {
    bar.style.width = w;
    bar.classList.toggle('live', live);
  }
  const now = Date.now();
  let any = false;
  $$('[data-voice-peer]').forEach((li) => {
    const id = Number(li.dataset.voicePeer);
    const me = nameOfPeer(id) === VC.status.me;
    const on = me ? live : now - (VC.heard.get(id) || 0) < 350;
    li.classList.toggle('talking', on);
    any ||= on;
  });
  $('#voice-dock')?.classList.toggle('someone-talking', any);
}

function stopMic() {
  VC.reader?.cancel().catch(() => {});
  VC.reader = null;
  if (VC.enc && VC.enc.state !== 'closed') VC.enc.close();
  VC.enc = null;
  VC.mic?.getTracks().forEach((t) => t.stop());
  VC.mic = null;
  for (const d of VC.decoders.values()) if (d.state !== 'closed') d.close();
  VC.decoders.clear();
  VC.next.clear();
  VC.peerGain.clear();
  VC.panners.clear();
  VC.distGain.clear();
  VC.ctx?.close().catch(() => {});
  VC.ctx = null;
  VC.master = null;
  VC.micGain = null;
  VC.level = 0;
}

/** Громкость каждого друга — из настроек (по нику). */
function applyPeerVolumes() {
  for (const [id, g] of VC.peerGain) g.gain.value = peerCfg(nameOfPeer(id)).volume ?? 1;
}

/** Кадр от друга: свой декодер на каждого, звук встаёт в очередь сразу за предыдущим кадром. */
function playVoice(ev) {
  if (!VC.ctx || !VC.status.joined) return;
  VC.heard.set(ev.from, Date.now());
  if (peerCfg(nameOfPeer(ev.from)).muted) return; // друг заглушён — не декодируем
  let d = VC.decoders.get(ev.from);
  if (!d) {
    d = new AudioDecoder({ output: (ad) => scheduleVoice(ev.from, ad), error: () => VC.decoders.delete(ev.from) });
    d.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: 1 });
    VC.decoders.set(ev.from, d);
  }
  try {
    d.decode(new EncodedAudioChunk({ type: 'key', timestamp: (ev.seq || 0) * 20000, data: ev.data }));
  } catch {}
}

function scheduleVoice(from, ad) {
  const ctx = VC.ctx;
  if (!ctx) return ad.close();
  const buf = ctx.createBuffer(1, ad.numberOfFrames, ad.sampleRate);
  const pcm = new Float32Array(ad.numberOfFrames);
  ad.copyTo(pcm, { planeIndex: 0, format: 'f32-planar' });
  ad.close();
  buf.copyToChannel(pcm, 0);
  let g = VC.peerGain.get(from);
  if (!g) {
    g = ctx.createGain();
    g.gain.value = peerCfg(nameOfPeer(from)).volume ?? 1;
    // друг → своя громкость → место в мире (объёмный звук) → общая громкость
    const p = ctx.createPanner();
    p.panningModel = 'HRTF';
    // панорама отвечает только за сторону; громкость по расстоянию — своя кривая (distanceGain)
    p.distanceModel = 'linear';
    p.rolloffFactor = 0;
    const dg = ctx.createGain();
    g.connect(p).connect(dg).connect(VC.master);
    VC.peerGain.set(from, g);
    VC.panners.set(from, p);
    VC.distGain.set(from, dg);
    VC.fresh.add(p);
    applySpatial();
  }
  const node = ctx.createBufferSource();
  node.buffer = buf;
  node.connect(g);
  // буфер ~80 мс: кадры встают друг за другом. Кадры кончились (тишина, сеть) — следующий снова через 80 мс;
  // пачка кадров после задержки сети — лишнее отбрасываем, чтобы задержка голоса не росла больше полсекунды
  const now = ctx.currentTime;
  let t = VC.next.get(from) || 0;
  if (t < now + 0.01) t = now + 0.08;
  if (t > now + 0.5) {
    VC.dropped++;
    return;
  }
  node.start(t);
  VC.next.set(from, t + buf.duration);
}

function paintVoiceTest() {
  const b = $('#vs-test');
  if (b && !b.disabled) b.textContent = VC.status.test ? 'Убрать Test_2' : 'Запустить второго игрока (Test_2)';
}

// ---------- окно настроек голоса ----------
async function saveVoice(patch) {
  try {
    S.settings = await call('settings:set', { voice: patch });
    VC.cfg = { ...S.settings.voice };
  } catch (e) {
    toast(e.message);
  }
}

async function voiceSettingsDialog() {
  const c = cfg();
  let devs = [];
  try {
    devs = await navigator.mediaDevices.enumerateDevices();
  } catch {}
  const opts = (kind, cur) => `<option value="">По умолчанию Windows</option>${devs
    .filter((d) => d.kind === kind && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications')
    .map((d) => `<option value="${esc(d.deviceId)}" ${d.deviceId === cur ? 'selected' : ''}>${esc(d.label || 'Устройство')}</option>`)
    .join('')}`;
  const others = VC.status.roster.filter((r) => r.name !== VC.status.me);
  const range = (id, min, max, step, v, label, hint = '') => `<label class="vs-row"><span>${label}${hint ? `<small>${hint}</small>` : ''}</span><input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${v}"><b id="${id}-v">${Math.round(v * 100)}%</b></label>`;
  const check = (id, v, label, hint = '') => `<label class="vs-check"><input type="checkbox" id="${id}" ${v ? 'checked' : ''}><span>${label}${hint ? `<small>${hint}</small>` : ''}</span></label>`;
  dialog(
    'Настройки голоса',
    `<div class="vs">
      <section><h3>Микрофон</h3>
        <div class="vs-row"><span>Как включается</span><div class="segmented" role="group"><button data-vs-mode="voice" aria-pressed="${c.mode !== 'toggle'}">Голосом</button><button data-vs-mode="toggle" aria-pressed="${c.mode === 'toggle'}">По кнопке</button></div></div>
        <label class="vs-row"><span>Клавиша<small>${c.mode === 'toggle' ? 'нажал — микрофон включён, нажал ещё раз — выключен' : 'выключить микрофон на время'} · работает и в игре, слышен короткий сигнал</small></span><select class="input" id="vs-key">${VOICE_KEYS.map((k) => `<option ${k === c.hotkey ? 'selected' : ''}>${k}</option>`).join('')}</select></label>
        <div class="vs-row vs-thr ${c.mode === 'toggle' ? 'off' : ''}"><span>Порог<small>говори как обычно — полоска должна заходить за метку; тишина и шум — нет</small></span><div class="vs-meter-wrap"><span class="vs-meter" id="vs-meter"><i></i><s id="vs-mark" style="left:${Math.min(100, Math.round(c.threshold * 900))}%"></s></span><input type="range" id="vs-thr" min="0.001" max="0.1" step="0.001" value="${c.threshold}"></div></div>
        <label class="vs-row"><span>Устройство</span><select class="input" id="vs-mic">${opts('audioinput', c.micId)}</select></label>
        ${range('vs-micgain', 0, 3, 0.05, c.micGain, 'Усиление микрофона')}
        <div class="vs-checks">${check('vs-noise', c.noise, 'Шумоподавление')}${check('vs-echo', c.echo, 'Убирать эхо', 'если играешь без наушников')}${check('vs-agc', c.agc, 'Автогромкость')}</div>
        <div class="actions" style="margin-top:6px"><button class="btn btn-secondary btn-small" id="vs-monitor">${VC.monitor ? 'Перестать слушать себя' : 'Прослушать себя'}</button></div>
      </section>
      <section><h3>Звук друзей</h3>
        <label class="vs-row"><span>Наушники / колонки</span><select class="input" id="vs-out">${opts('audiooutput', c.outId)}</select></label>
        ${range('vs-vol', 0, 2, 0.05, c.volume, 'Общая громкость')}
        ${check('vs-spatial', c.spatial !== false, 'Объёмный звук — как в жизни', 'друга слышно с той стороны, где стоит его персонаж, и тише с расстоянием; в другом измерении не слышно. Когда оба в игре на сервере сессии, Minecraft 1.13 и новее')}
        <label class="vs-row ${c.spatial === false ? 'off' : ''}" id="vs-range-row"><span>Дальность слышимости<small>дальше — друга не слышно</small></span><input type="range" id="vs-range" min="8" max="128" step="4" value="${c.range || 48}"><b id="vs-range-v">${c.range || 48} бл.</b></label>
        ${others.length ? others.map((r) => `<div class="vs-row vs-peer"><span>${esc(r.name)}</span><input type="range" data-vs-peer="${esc(r.name)}" min="0" max="2" step="0.05" value="${peerCfg(r.name).volume}"><button class="btn btn-ghost btn-small" data-vs-mute="${esc(r.name)}">${peerCfg(r.name).muted ? 'Включить' : 'Заглушить'}</button></div>`).join('') : '<p class="hint">Когда друзья зайдут в голос, здесь можно будет настроить громкость каждого.</p>'}
      </section>
      <section><h3>В игре</h3>
        ${check('vs-tab', c.tab, 'Значок ♪ у ника в табе и над головой, пока человек говорит', 'Работает в Minecraft 1.13 и новее, когда ты хозяин сессии — лаунчер сам добавляет значок командами сервера')}
        ${check('vs-bar', c.actionbar, 'Надпись над хотбаром «♪ Ник»', 'Minecraft 1.11 и новее, когда ты хозяин сессии')}
      </section>
      ${
        VC.status.role === 'host'
          ? `<section class="vs-test"><h3>Проверка на одном компьютере <small>временно</small></h3>
        <p class="hint">Запустит второй Minecraft под ником <b>Test_2</b> — он зайдёт в твой мир. В голосовом чате Test_2 повторяет тебя через секунду: у его ника в табе загорается ♪, а себя слышно с той стороны, где стоит Test_2 (отойди, повернись). Нужна сессия с галочкой «Разрешить друзьям без Microsoft» и ты в голосовом чате.</p>
        <div class="actions"><button class="btn btn-secondary btn-small" id="vs-test"></button></div></section>`
          : ''
      }
    </div><div class="actions"><button class="btn btn-primary" data-close>Готово</button></div>`,
    true,
  );
  const restart = async () => {
    if (!VC.mic) return;
    stopMic();
    await startMic().catch((e) => toast(`Микрофон: ${e.message}`));
    paintVoice();
  };
  $$('[data-vs-mode]').forEach(
    (b) =>
      (b.onclick = async () => {
        await saveVoice({ mode: b.dataset.vsMode });
        VC.open = false;
        VC.muted = false;
        voiceSettingsDialog();
        paintVoice();
      }),
  );
  $('#vs-key').onchange = async (e) => {
    await saveVoice({ hotkey: e.target.value });
    if (VC.mic) registerVoiceKey();
  };
  $('#vs-thr').oninput = (e) => {
    const v = Number(e.target.value);
    VC.cfg.threshold = v;
    $('#vs-mark').style.left = `${Math.min(100, Math.round(v * 900))}%`;
  };
  $('#vs-thr').onchange = (e) => saveVoice({ threshold: Number(e.target.value) });
  $('#vs-mic').onchange = async (e) => {
    await saveVoice({ micId: e.target.value });
    restart();
  };
  $('#vs-out').onchange = async (e) => {
    await saveVoice({ outId: e.target.value });
    if (VC.ctx?.setSinkId) await VC.ctx.setSinkId(e.target.value || '').catch(() => toast('Это устройство вывода недоступно.'));
  };
  const live = (id, key, apply) => {
    $(`#${id}`).oninput = (e) => {
      const v = Number(e.target.value);
      $(`#${id}-v`).textContent = `${Math.round(v * 100)}%`;
      VC.cfg[key] = v;
      apply(v);
    };
    $(`#${id}`).onchange = (e) => saveVoice({ [key]: Number(e.target.value) });
  };
  live('vs-micgain', 'micGain', (v) => VC.micGain && (VC.micGain.gain.value = v));
  live('vs-vol', 'volume', (v) => VC.master && (VC.master.gain.value = v));
  for (const [id, key] of [['vs-noise', 'noise'], ['vs-echo', 'echo'], ['vs-agc', 'agc']])
    $(`#${id}`).onchange = async (e) => {
      await saveVoice({ [key]: e.target.checked });
      restart();
    };
  $('#vs-spatial').onchange = async (e) => {
    await saveVoice({ spatial: e.target.checked });
    $('#vs-range-row').classList.toggle('off', !e.target.checked);
    applySpatial();
  };
  $('#vs-range').oninput = (e) => {
    VC.cfg.range = Number(e.target.value);
    $('#vs-range-v').textContent = `${e.target.value} бл.`;
    applySpatial();
  };
  $('#vs-range').onchange = (e) => saveVoice({ range: Number(e.target.value) });
  if ($('#vs-test')) {
    paintVoiceTest();
    $('#vs-test').onclick = async () => {
      const b = $('#vs-test');
      const on = !VC.status.test;
      b.disabled = true;
      b.textContent = on ? 'Запускаю Test_2…' : 'Убираю…';
      try {
        VC.status = await call('voice:test', on);
        if (on) toast('Test_2 запускается — второе окно Minecraft откроется через несколько секунд.');
      } catch (e) {
        errorDialog(e, 'Проверка на одном компьютере');
      }
      b.disabled = false;
      paintVoiceTest();
      paintVoice();
    };
  }
  $('#vs-tab').onchange = (e) => saveVoice({ tab: e.target.checked });
  $('#vs-bar').onchange = (e) => saveVoice({ actionbar: e.target.checked });
  $('#vs-monitor').onclick = async () => {
    if (!VC.mic) {
      await startMic().catch((e) => toast(`Микрофон: ${e.message}`));
      VC.monitorOnly = true; // микрофон включён только ради проверки — звук никуда не уходит
    }
    VC.monitor = !VC.monitor;
    if (VC.micGain) {
      if (VC.monitor) VC.micGain.connect(VC.ctx.destination);
      else VC.micGain.disconnect(VC.ctx.destination);
    }
    if (!VC.monitor && VC.monitorOnly && !VC.status.joined) {
      VC.monitorOnly = false;
      stopMic();
    }
    $('#vs-monitor').textContent = VC.monitor ? 'Перестать слушать себя' : 'Прослушать себя';
  };
  const peers = { ...(cfg().peers || {}) };
  $$('[data-vs-peer]').forEach((r) => {
    r.oninput = () => {
      peers[r.dataset.vsPeer] = { ...peerCfg(r.dataset.vsPeer), volume: Number(r.value) };
      VC.cfg.peers = peers;
      applyPeerVolumes();
    };
    r.onchange = () => saveVoice({ peers });
  });
  $$('[data-vs-mute]').forEach(
    (b) =>
      (b.onclick = async () => {
        const n = b.dataset.vsMute;
        peers[n] = { ...peerCfg(n), muted: !peerCfg(n).muted };
        await saveVoice({ peers });
        b.textContent = peers[n].muted ? 'Включить' : 'Заглушить';
        paintVoice();
      }),
  );
  // полоска микрофона в окне настроек живёт, пока окно открыто
  const tick = setInterval(() => {
    // окно закрывается скрытием (содержимое остаётся в разметке) — смотрим, видно ли оно
    if (!$('#vs-meter') || $('#overlay').hidden) {
      clearInterval(tick);
      // окно закрыли во время «прослушать себя» — проверка заканчивается
      if (VC.monitor && VC.micGain) VC.micGain.disconnect(VC.ctx.destination);
      VC.monitor = false;
      if (VC.monitorOnly && !VC.status.joined) stopMic();
      VC.monitorOnly = false;
      return;
    }
    paintLevels();
  }, 120);
}
