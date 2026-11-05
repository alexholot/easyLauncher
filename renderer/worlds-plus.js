'use strict';
// Окно мира с вкладками (летопись, карта, машина времени, обложка и копии), «Вызов другу»,
// карточки главной («Почему тормозило», активный вызов) и «Фильм сессии».
/* global call, esc, icon, toast, $, $$, S, dialog, closeDialog, date, mb, img, bgStyle, worldsOf, worldManage, errorDialog, render, refresh, profile, plural, renderSeq, stale, ask, openAssistant */
/* exported worldDialog, worldTabs, challengeDialog, paintPerf, paintChallenge, filmDialog, sessionClips */

const WORLD_TABS = [
  ['chronicle', 'Летопись'],
  ['map', 'Карта'],
  ['time', 'Машина времени'],
  ['manage', 'Обложка и копии'],
];
const CHRONICLE_KIND = {
  first: 'Начало',
  session: 'Сессия',
  advancement: '★ Достижение',
  challenge: '★ Испытание',
  goal: '★ Цель',
  death: 'Смерть',
  clip: 'Ролик',
  'challenge-done': 'Вызов выполнен',
};
const dur = (sec) => {
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return h ? `${h} ч ${m} мин` : m ? `${m} мин` : `${Math.max(1, Math.round(sec))} с`;
};
const when = (iso) => `${date(iso)}, ${new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`;

/** Окно мира: шапка с вкладками и содержимое вкладки. */
function worldTabs(pid, folder, active, title, html) {
  dialog(title, `<div class="tabs wd-tabs" role="tablist">${WORLD_TABS.map(([k, l]) => `<button role="tab" data-wtab="${k}" aria-selected="${k === active}" class="${k === active ? 'active' : ''}">${l}</button>`).join('')}</div><div class="wd-body">${html}</div>`, true);
  $$('[data-wtab]').forEach((b) => (b.onclick = () => worldDialog(pid, folder, b.dataset.wtab)));
}

async function worldDialog(pid, folder, tab = 'chronicle', focus = null) {
  if (tab === 'manage') return worldManage(pid, folder);
  const w = (await worldsOf(pid)).find((x) => x.folder === folder);
  if (!w) return toast('Мир не найден');
  if (tab === 'map') return mapTab(pid, w, focus);
  if (tab === 'time') return timeTab(pid, w);
  return chronicleTab(pid, w);
}

// ---------- летопись ----------
async function chronicleTab(pid, w) {
  worldTabs(pid, w.folder, 'chronicle', w.name, '<p class="hint"><span class="spinner"></span>Собираем летопись…</p>');
  let data;
  try {
    data = await call('worlds:chronicle', pid, w.folder);
  } catch (e) {
    return worldTabs(pid, w.folder, 'chronicle', w.name, `<div class="notice error">${esc(e.message)}</div>`);
  }
  const ev = data.events;
  if (!ev.length) {
    return worldTabs(pid, w.folder, 'chronicle', w.name, `<div class="empty chr-empty">${icon('history')}<h3>Летопись пока пуста</h3><p>Она начнётся, когда ты зайдёшь в этот мир из easyLauncher. Лаунчер сам запишет первые шаги, достижения, смерти (с местом на карте), сессии и скриншоты — и ролики камеры, если она включена.</p></div>`);
  }
  const days = ev.map((e) => e.day).filter(Number.isFinite);
  const stats = {
    sessions: ev.filter((e) => e.kind === 'session').length,
    adv: ev.filter((e) => ['advancement', 'challenge', 'goal'].includes(e.kind)).length,
    deaths: ev.filter((e) => e.kind === 'death').length,
    time: ev.filter((e) => e.kind === 'session').reduce((a, e) => a + (e.seconds || 0), 0),
  };
  const items = ev
    .map((e) => {
      const label = CHRONICLE_KIND[e.kind] || 'Событие';
      const title =
        e.kind === 'first' ? 'Мир открыт в easyLauncher — с этого дня ведётся летопись'
        : e.kind === 'session' ? `Играли ${dur(e.seconds || 0)}${e.startDay && e.day && e.day > e.startDay ? ` · дни ${e.startDay}–${e.day}` : ''}${e.moments ? ` · событий: ${e.moments}` : ''}`
        : e.kind === 'challenge-done' ? `«${e.title}» за ${dur(e.seconds || 0)}${e.inTime ? ' — уложился!' : ' — не уложился во время'}`
        : e.kind === 'death' ? e.title || 'Погиб'
        : e.kind === 'clip' ? 'Момент из игры'
        : `«${e.title}»`;
      const meta = [Number.isFinite(e.day) ? `${e.kind === 'session' ? '' : '≈ '}день ${e.day}` : '', when(e.at)].filter(Boolean).join(' · ');
      const shots = (e.shots || []).slice(0, 6).map((f) => `<span class="chr-shot" ${bgStyle(f)}></span>`).join('');
      const clip = e.clipInfo ? `<button class="chr-clip" data-chr-clip="${esc(e.clipInfo.file)}" ${e.clipInfo.thumb ? bgStyle(e.clipInfo.thumb) : ''} aria-label="Посмотреть ролик">${icon('play')}<span>${e.clipInfo.seconds || ''}с</span></button>` : '';
      const where = e.pos ? `<button class="btn btn-ghost btn-small" data-chr-map="${e.pos[0]},${e.pos[2]}">${icon('globe')}${e.approx ? 'Примерно здесь' : 'На карте'}</button>` : '';
      // класс вида — с приставкой k-: «chr-clip» уже занят кнопкой-превью ролика
      return `<li class="chr-item chr-k-${esc(e.kind)}"><span class="chr-dot" aria-hidden="true"></span><div class="chr-body"><div class="chr-head"><span class="mem-moment ${e.kind === 'death' ? 'death' : ''}">${esc(label)}</span><b>${esc(title)}</b></div><small>${esc(meta)}${e.pos ? ` · ${e.pos[0]}, ${e.pos[2]}` : ''}</small>${shots || clip ? `<div class="chr-media">${clip}${shots}</div>` : ''}${where ? `<div class="chr-acts">${where}</div>` : ''}</div></li>`;
    })
    .join('');
  worldTabs(
    pid,
    w.folder,
    'chronicle',
    w.name,
    `<div class="chr-stats"><div><b>${days.length ? Math.max(...days) : '—'}</b><small>игровой день</small></div><div><b>${dur(stats.time)}</b><small>в летописи</small></div><div><b>${stats.adv}</b><small>${plural(stats.adv, 'достижение', 'достижения', 'достижений')}</small></div><div><b>${stats.deaths}</b><small>${plural(stats.deaths, 'смерть', 'смерти', 'смертей')}</small></div></div>
    <ol class="chr-list">${items}</ol><div id="chr-player"></div><p class="hint">Игровой день события примерный (сутки в игре — 20 минут). Место достижения — где ты был при последнем автосохранении, место смерти — точное.</p>`,
  );
  $$('[data-chr-clip]').forEach((b) => (b.onclick = () => ($('#chr-player').innerHTML = `<video class="mem-video" src="${img(b.dataset.chrClip)}" autoplay muted controls playsinline></video>`, $('#chr-player').scrollIntoView({ block: 'nearest' }))));
  $$('[data-chr-map]').forEach((b) => (b.onclick = () => worldDialog(pid, w.folder, 'map', b.dataset.chrMap.split(',').map(Number))));
}

// ---------- карта ----------
const MARK = {
  spawn: ['Точка появления', '#f2f2f2'],
  player: ['Ты здесь (последнее сохранение)', '#5ad1ff'],
  death: ['Смерть', '#ff5a4a'],
  advancement: ['Достижение', '#ffd34d'],
  challenge: ['Испытание', '#ffd34d'],
  goal: ['Цель', '#ffd34d'],
  first: ['Начало летописи', '#9be27c'],
  session: ['Здесь закончил игру', '#c7b8ff'],
};

async function mapTab(pid, w, focus) {
  worldTabs(pid, w.folder, 'map', w.name, '<p class="hint"><span class="spinner"></span>Читаем мир…</p>');
  let info;
  try {
    info = await call('worlds:map', pid, w.folder);
  } catch (e) {
    return worldTabs(pid, w.folder, 'map', w.name, `<div class="notice error">${esc(e.message)}</div>`);
  }
  if (!info.supported) return worldTabs(pid, w.folder, 'map', w.name, `<div class="notice">${esc(info.reason)}</div>`);
  if (!info.regions.length) return worldTabs(pid, w.folder, 'map', w.name, '<div class="notice">В мире ещё нет сохранённой местности. Поиграй в нём — карта появится после сохранения.</div>');
  worldTabs(
    pid,
    w.folder,
    'map',
    w.name,
    `<div class="map-wrap"><canvas id="wmap" aria-label="Карта мира: тяни мышкой, колесо — масштаб"></canvas><div class="map-tip" id="map-tip" hidden></div><div class="map-zoom"><button class="icon-button" id="map-in" aria-label="Приблизить">${icon('plus')}</button><button class="icon-button" id="map-out" aria-label="Отдалить"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M5 12h14"/></svg></button><button class="icon-button" id="map-home" aria-label="К игроку">${icon('home')}</button></div><div class="map-progress" id="map-progress"></div></div>
    <div class="map-legend">${['player', 'spawn', 'death', 'advancement', 'session'].map((k) => `<span><i style="background:${MARK[k][1]}"></i>${MARK[k][0]}</span>`).join('')}</div>
    <p class="hint">Вид сверху по файлам мира, точка — один блок. Тяни мышкой, колесо — масштаб, нажми на значок — что там было. Перерисовываются только изменившиеся места.</p><div id="map-player"></div>`,
  );
  mapView(pid, w, info, focus);
}

function mapView(pid, w, info, focus) {
  const cv = $('#wmap');
  const g = cv.getContext('2d');
  const tiles = new Map(); // 'x,z' → {img, state}
  const markers = [];
  if (info.spawn) markers.push({ kind: 'spawn', pos: info.spawn, title: 'Точка появления' });
  if (info.lastDeath) markers.push({ kind: 'death', pos: info.lastDeath, title: 'Последняя смерть' });
  for (const m of info.markers) markers.push({ ...m, kind: m.kind });
  if (info.player) markers.push({ kind: 'player', pos: info.player, title: 'Ты здесь' });
  const start = focus || info.player || info.spawn || [info.regions[0].x * 512 + 256, 64, info.regions[0].z * 512 + 256];
  const cam = { x: start[0], z: start.length === 3 ? start[2] : start[1], zoom: focus ? 2 : 1 };
  let queue = 0;
  const loadTile = (x, z) => {
    const k = `${x},${z}`;
    if (tiles.has(k) || queue >= 2) return;
    tiles.set(k, { state: 'loading' });
    queue++;
    progress();
    call('worlds:mapTile', pid, w.folder, x, z)
      .then((file) => {
        if (!file) return tiles.set(k, { state: 'none' });
        const im = new Image();
        im.onload = () => (tiles.set(k, { state: 'ok', img: im }), draw());
        im.onerror = () => tiles.set(k, { state: 'none' });
        im.src = img(file) + '&t=' + Date.now();
      })
      .catch(() => tiles.set(k, { state: 'none' }))
      .finally(() => {
        queue--;
        progress();
        draw();
      });
  };
  const progress = () => {
    const done = [...tiles.values()].filter((t) => t.state !== 'loading').length;
    const el = $('#map-progress');
    if (el) el.textContent = queue ? `Рисую карту… ${done} из ${info.regions.length}` : '';
  };
  const have = new Set(info.regions.map((r) => `${r.x},${r.z}`));
  // в точках окна (CSS), не в пикселях холста: так совпадает с координатами мыши
  const toScreen = (wx, wz) => [(wx - cam.x) * cam.zoom + cv.clientWidth / 2, (wz - cam.z) * cam.zoom + cv.clientHeight / 2];
  function draw() {
    if (!document.body.contains(cv)) return;
    const dpr = window.devicePixelRatio || 1;
    const W = cv.clientWidth;
    const H = cv.clientHeight;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
      cv.width = Math.round(W * dpr);
      cv.height = Math.round(H * dpr);
    }
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = '#0d1014';
    g.fillRect(0, 0, cv.width, cv.height);
    g.imageSmoothingEnabled = cam.zoom < 1;
    const z = cam.zoom * dpr;
    const sx = (wx) => (wx - cam.x) * z + cv.width / 2;
    const sz = (wz) => (wz - cam.z) * z + cv.height / 2;
    const rx0 = Math.floor((cam.x - cv.width / 2 / z) / 512);
    const rx1 = Math.floor((cam.x + cv.width / 2 / z) / 512);
    const rz0 = Math.floor((cam.z - cv.height / 2 / z) / 512);
    const rz1 = Math.floor((cam.z + cv.height / 2 / z) / 512);
    for (let rx = rx0; rx <= rx1; rx++) {
      for (let rz = rz0; rz <= rz1; rz++) {
        if (!have.has(`${rx},${rz}`)) continue;
        const t = tiles.get(`${rx},${rz}`);
        if (t?.state === 'ok') g.drawImage(t.img, Math.floor(sx(rx * 512)), Math.floor(sz(rz * 512)), Math.ceil(512 * z) + 1, Math.ceil(512 * z) + 1);
        else {
          g.fillStyle = 'rgba(255,255,255,.04)';
          g.fillRect(sx(rx * 512), sz(rz * 512), 512 * z, 512 * z);
          if (!t) loadTile(rx, rz);
        }
      }
    }
    // значки
    for (const m of markers) {
      const x = sx(m.pos[0]);
      const y = sz(m.pos[2]);
      if (x < -20 || y < -20 || x > cv.width + 20 || y > cv.height + 20) continue;
      const c = (MARK[m.kind] || MARK.advancement)[1];
      const r = (m.kind === 'player' ? 7 : 5.5) * dpr;
      g.fillStyle = 'rgba(0,0,0,.55)';
      g.fillRect(x - r - dpr, y - r - dpr, (r + dpr) * 2, (r + dpr) * 2);
      g.fillStyle = c;
      g.fillRect(x - r, y - r, r * 2, r * 2);
      if (m.kind === 'death') {
        g.fillStyle = '#1a0606';
        g.fillRect(x - r * 0.6, y - dpr, r * 1.2, dpr * 2);
        g.fillRect(x - dpr, y - r * 0.6, dpr * 2, r * 1.2);
      }
      if (m.approx) {
        g.strokeStyle = c;
        g.setLineDash([3 * dpr, 3 * dpr]);
        g.strokeRect(x - r * 2.2, y - r * 2.2, r * 4.4, r * 4.4);
        g.setLineDash([]);
      }
    }
  }
  // перетаскивание и масштаб
  let drag = null;
  cv.onmousedown = (e) => (drag = { x: e.clientX, y: e.clientY, cx: cam.x, cz: cam.z, moved: false });
  // отпустили кнопку за пределами карты — перетаскивание тоже заканчивается (клик после него не считается)
  cv.onmouseup = () => setTimeout(() => (drag = null), 0);
  cv.onmouseleave = () => (drag = null);
  cv.onmousemove = (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    cam.x = drag.cx - dx / cam.zoom;
    cam.z = drag.cz - dy / cam.zoom;
    draw();
  };
  const zoomBy = (k) => {
    cam.zoom = Math.min(8, Math.max(0.125, cam.zoom * k));
    draw();
  };
  cv.onwheel = (e) => {
    e.preventDefault();
    zoomBy(e.deltaY < 0 ? 1.25 : 0.8);
  };
  $('#map-in').onclick = () => zoomBy(1.5);
  $('#map-out').onclick = () => zoomBy(1 / 1.5);
  $('#map-home').onclick = () => {
    const p = info.player || info.spawn;
    if (p) [cam.x, cam.z] = [p[0], p[2]];
    draw();
  };
  cv.onclick = (e) => {
    if (drag?.moved) return;
    const rect = cv.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    // ближайший значок в радиусе 10 точек; «ты здесь» рисуется последним — он и выбирается первым при наложении
    const hit = markers
      .slice()
      .reverse()
      .find((m) => {
        const [x, y] = toScreen(m.pos[0], m.pos[2]);
        return Math.abs(x - mx) < 10 && Math.abs(y - my) < 10;
      });
    const tip = $('#map-tip');
    if (!hit) return (tip.hidden = true);
    const name = (MARK[hit.kind] || MARK.advancement)[0];
    // у события заголовок — его название, вид события — в подписи; у точки появления и игрока — только вид
    const own = hit.title && !['player', 'spawn'].includes(hit.kind) && !(hit.kind === 'death' && !hit.id);
    tip.hidden = false;
    tip.style.left = Math.min(mx + 12, cv.clientWidth - 230) + 'px';
    tip.style.top = Math.max(my - 10, 0) + 'px';
    tip.innerHTML = `<b>${esc(own ? hit.title : name)}</b><small>${esc([own ? name : '', hit.day ? `≈ день ${hit.day}` : '', hit.at ? when(hit.at) : '', `${hit.pos[0]}, ${hit.pos[1]}, ${hit.pos[2]}`, hit.approx ? 'место примерное' : ''].filter(Boolean).join(' · '))}</small>${hit.clip ? `<button class="btn btn-secondary btn-small" id="map-clip">${icon('play')}Ролик момента</button>` : ''}`;
    if ($('#map-clip'))
      $('#map-clip').onclick = async () => {
        const c = (await call('memories:list').catch(() => [])).find((x) => x.id === hit.clip);
        if (c) $('#map-player').innerHTML = `<video class="mem-video" src="${img(c.file)}" autoplay muted controls playsinline></video>`;
        else toast('Ролик уже удалён ротацией.');
      };
  };
  new ResizeObserver(draw).observe(cv);
  draw();
}

// ---------- машина времени ----------
async function timeTab(pid, w) {
  worldTabs(pid, w.folder, 'time', w.name, '<p class="hint"><span class="spinner"></span>Собираем копии…</p>');
  const [backups, chron] = await Promise.all([call('worlds:backups', pid, w.folder).catch(() => []), call('worlds:chronicle', pid, w.folder).catch(() => ({ events: [] }))]);
  const points = backups.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (!points.length) {
    return worldTabs(pid, w.folder, 'time', w.name, `<div class="empty">${icon('history')}<h3>Пока не к чему возвращаться</h3><p>Копии мира делаются сами перед изменением сборки и удалением мира, и вручную. Сделай первую — и здесь появится шкала времени.</p><div class="actions"><button class="btn btn-primary" id="tm-now" ${w.playing ? 'disabled' : ''}>Сделать копию сейчас</button></div></div>`), wireTmNow(pid, w);
  }
  const events = chron.events.filter((e) => e.kind !== 'first' && e.kind !== 'clip');
  const shotsBefore = (iso) => {
    const t = Date.parse(iso);
    const withShots = chron.events.filter((e) => e.shots?.length && Date.parse(e.at) <= t + 60000).sort((a, b) => b.at.localeCompare(a.at));
    return withShots[0]?.shots[withShots[0].shots.length - 1] || null;
  };
  let idx = points.length - 1;
  const paint = () => {
    const b = points[idx];
    const t = Date.parse(b.createdAt);
    const after = events.filter((e) => Date.parse(e.at) > t);
    const lost = after.filter((e) => ['advancement', 'challenge', 'goal', 'challenge-done'].includes(e.kind));
    const sessions = after.filter((e) => e.kind === 'session');
    const pic = shotsBefore(b.createdAt) || w.cover?.file || w.icon;
    $('#tm-point').innerHTML = `<div class="tm-pic" ${bgStyle(pic)}>${pic ? '' : icon('globe')}</div><div class="tm-info"><b>${esc(new Date(b.createdAt).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }))}</b><small>${esc(b.reasonText)} · ${mb(b.size)}</small>
      ${after.length ? `<p>После этой точки ${sessions.length ? `было ${sessions.length} ${plural(sessions.length, 'сессия', 'сессии', 'сессий')} игры` : 'были события'}${lost.length ? `. В мире пропадёт прогресс: ${lost.slice(0, 6).map((e) => '«' + esc(e.title) + '»').join(', ')}${lost.length > 6 ? ' и другие' : ''}` : ''}.</p>` : '<p>Это самая свежая точка — с неё ещё не играли.</p>'}
      <p class="hint">Летопись не пропадёт: в ней останется вся история, а сам мир вернётся к этому дню. Текущее состояние лаунчер сначала тоже сохранит в копию — передумать можно будет.</p>
      <div class="actions"><button class="btn btn-primary" id="tm-go" ${w.hosted || w.playing ? 'disabled' : ''}>${icon('history')}Вернуть мир сюда</button><button class="btn btn-ghost btn-small" id="tm-now2" ${w.playing ? 'disabled' : ''}>Сделать копию сейчас</button></div></div>`;
    $('#tm-go').onclick = () => {
      dialog('Вернуть мир в прошлое?', `<p>Мир «${esc(w.name)}» станет таким, каким был ${esc(new Date(b.createdAt).toLocaleString('ru-RU'))}.</p><p class="hint">Сейчашнее состояние сначала сохранится в копию.</p><div class="actions"><button class="btn btn-primary" id="tm-yes">Вернуть</button><button class="btn btn-ghost" id="tm-no">Отмена</button></div>`);
      $('#tm-no').onclick = () => worldDialog(pid, w.folder, 'time');
      $('#tm-yes').onclick = async () => {
        $('#tm-yes').disabled = true;
        try {
          await call('worlds:restore', pid, w.folder, b.id);
          toast('Мир вернулся в прошлое');
          delete S.worldsCache[pid];
          worldDialog(pid, w.folder, 'time');
        } catch (e) {
          errorDialog(e, 'Не удалось вернуть мир');
        }
      };
    };
    wireTmNow(pid, w, '#tm-now2');
    $$('.tm-tick').forEach((x) => x.classList.toggle('on', Number(x.dataset.i) === idx));
  };
  // отметки стоят там же, где шаги ползунка (по номеру копии), — иначе ползунок и отметка расходились
  const many = points.length > 1;
  worldTabs(
    pid,
    w.folder,
    'time',
    w.name,
    `${many ? `<div class="tm-scale"><input type="range" id="tm-range" min="0" max="${points.length - 1}" step="1" value="${idx}" aria-label="Точка во времени"><div class="tm-ticks">${points.map((p, i) => `<button class="tm-tick" data-i="${i}" style="left:${(i / (points.length - 1)) * 100}%" title="${esc(new Date(p.createdAt).toLocaleString('ru-RU'))} — ${esc(p.reasonText)}" aria-label="${esc(p.reasonText)}"></button>`).join('')}</div><div class="tm-ends"><small>${esc(date(points[0].createdAt))} — самая старая</small><small>самая свежая — ${esc(date(points[points.length - 1].createdAt))}</small></div></div>` : '<p class="hint">Пока одна копия. Каждая новая копия — ещё одна точка на шкале времени.</p>'}<div class="tm-point" id="tm-point"></div>`,
  );
  if ($('#tm-range')) $('#tm-range').oninput = (e) => ((idx = Number(e.target.value)), paint());
  $$('.tm-tick').forEach((x) => (x.onclick = () => ((idx = Number(x.dataset.i)), ($('#tm-range').value = idx), paint())));
  paint();
}
function wireTmNow(pid, w, sel = '#tm-now') {
  const b = $(sel);
  if (!b) return;
  b.onclick = async () => {
    b.disabled = true;
    try {
      await call('worlds:backup', pid, w.folder);
      toast('Копия сохранена');
      worldDialog(pid, w.folder, 'time');
    } catch (e) {
      toast(e.message);
      b.disabled = false;
    }
  };
}

// ---------- «Почему тормозило» ----------
async function paintPerf(p, n) {
  const r = await call('perf:last', p.id).catch(() => null);
  const box = S.view === 'play' && !stale(n) ? $('#home-perf') : null;
  if (!box) return;
  if (!r) return (box.hidden = true);
  box.hidden = false;
  box.innerHTML = `<div class="sec-head"><h2>${icon('warning')}Почему тормозило</h2><button class="icon-button" id="perf-close" aria-label="Скрыть" title="Скрыть">${icon('close')}</button></div>
    <p class="hint" style="margin:0 0 8px">Прошлый запуск, ${esc(when(r.at))} · ${dur(r.seconds)}. FPS лаунчер не видит — судит по журналу игры и памяти.</p>
    <ul class="perf-list">${r.issues.map((x, i) => `<li class="perf-${x.level}"><span>${esc(x.text)}</span>${x.fix ? `<button class="btn btn-secondary btn-small" data-perf="${i}">${esc(x.fix.label)}</button>` : ''}</li>`).join('')}</ul>`;
  $('#perf-close').onclick = async () => {
    await call('perf:dismiss', p.id);
    box.hidden = true;
  };
  $$('[data-perf]').forEach(
    (b) =>
      (b.onclick = async () => {
        const fix = r.issues[Number(b.dataset.perf)].fix;
        try {
          if (fix.type === 'ram') {
            await call('profiles:update', p.id, { ram: fix.value });
            toast(`Сборке «${p.name}» выделено ${fix.value} ГБ`);
          } else if (fix.type === 'simulation' || fix.type === 'render') {
            const o = { ...(S.settings.options || {}) };
            o[fix.type === 'render' ? 'render' : 'simulation'] = fix.value;
            S.settings = await call('settings:set', { options: o });
            toast(fix.type === 'render' ? `Дальность прорисовки: ${fix.value} — со следующего запуска` : `Дальность симуляции: ${fix.value} — со следующего запуска`);
          } else if (fix.type === 'perfmods') {
            openAssistant();
            ask('У меня тормозит игра, подними FPS — добавь моды оптимизации');
            return;
          }
          b.disabled = true;
          b.innerHTML = `${icon('check')}Готово`;
        } catch (e) {
          toast(e.message);
        }
      }),
  );
}

// ---------- «Вызов другу» ----------
async function paintChallenge(n) {
  const st = await call('challenge:status').catch(() => null);
  const box = S.view === 'play' && !stale(n) ? $('#home-challenge') : null;
  if (!box) return;
  const a = st?.active;
  if (!a) return (box.hidden = true);
  box.hidden = false;
  const left = a.limitMin * 60 - a.playedSec;
  box.innerHTML = `<div class="sec-head"><h2>${icon('star')}Вызов${a.from ? ' от ' + esc(a.from) : ''}</h2></div>
    <p style="margin:0"><b>${esc(a.goal.text)}</b> <small class="hint">(достижение «${esc(a.goal.title)}»)</small></p>
    <p class="hint" style="margin:4px 0 0">${a.done ? (a.done.inTime ? `Выполнено за ${dur(a.done.seconds)} — уложился!` : `Выполнено за ${dur(a.done.seconds)}, но лимит был ${a.limitMin} мин.`) : a.world ? `Мир «${esc(a.world)}» · сыграно ${dur(a.playedSec)} из ${a.limitMin} мин${left < 0 ? ' — время вышло, но цель ещё засчитается' : ''}` : 'Создай в игре новый мир — вызов начнётся в нём.'}</p>
    <div class="actions"><button class="btn btn-secondary btn-small" id="ch-open">Открыть</button></div>`;
  $('#ch-open').onclick = challengeDialog;
}

async function challengeDialog() {
  const [st, cat] = await Promise.all([call('challenge:status'), call('challenge:catalog')]);
  const a = st.active;
  const left = a ? a.limitMin * 60 - a.playedSec : 0;
  const activeHtml = a
    ? `<section class="ch-active"><h3>${a.done ? 'Вызов выполнен' : 'Идёт вызов'}${a.from ? ` от ${esc(a.from)}` : ''}</h3><p><b>${esc(a.goal.text)}</b> — засчитается, когда в журнале игры появится достижение «${esc(a.goal.title)}».</p><p class="hint">Лимит: ${a.limitMin} мин игры в мире вызова. ${a.rules.length ? 'Правила на честность: ' + a.rules.map(esc).join('; ') + '.' : ''}</p>
      ${a.done ? `<div class="notice ok"><strong>${a.done.inTime ? 'Уложился!' : 'Готово, но дольше лимита'}</strong>Время: ${dur(a.done.seconds)}. Отправь другу код результата — он сравнит со своим.</div><div class="row"><input class="input" readonly value="${esc(a.result)}" style="flex:1"><button class="btn btn-primary btn-small" data-copy="${esc(a.result)}">Копировать</button></div>` : `<p>${a.world ? `Мир «${esc(a.world)}» · сыграно ${dur(a.playedSec)}${left > 0 ? `, осталось ${dur(left)}` : ' — время вышло, но цель ещё засчитается'}` : '<b>Создай в игре новый мир</b> — вызов начнётся в первом новом мире. Старые миры не считаются.'}</p>`}
      <label class="field" for="ch-cmp">Код результата друга — сравнить</label><div class="row"><input class="input" id="ch-cmp" placeholder="EL1R-…" style="flex:1"><button class="btn btn-secondary btn-small" id="ch-cmp-go">Сравнить</button></div><div id="ch-cmp-out"></div>
      <div class="actions"><button class="btn btn-ghost btn-small" id="ch-abandon">${a.done ? 'Закрыть вызов' : 'Отказаться от вызова'}</button></div></section>`
    : '';
  dialog(
    'Вызов другу',
    `${activeHtml}<section><h3>${a ? 'Новый вызов' : 'Бросить вызов'}</h3><p class="hint">Выбери цель и лимит — лаунчер даст короткий код. Друг вставляет его у себя, оба играете в новом мире, время считается только игрой. Цель засчитывается сама по достижению из журнала игры, правила — на честность.</p>
      <div class="form-grid"><div><label class="field" for="ch-goal">Цель</label><select class="input" id="ch-goal">${cat.goals.map((g) => `<option value="${g.id}">${esc(g.text)}</option>`).join('')}</select></div><div><label class="field" for="ch-lim">Лимит</label><select class="input" id="ch-lim"></select></div></div>
      <div class="ch-rules">${cat.rules.map((r) => `<label class="pill-check"><input type="checkbox" data-ch-rule="${r.id}"><span>${esc(r.text)}</span></label>`).join('')}</div>
      <div class="actions"><button class="btn btn-primary" id="ch-make">${icon('star')}Создать код</button><button class="btn btn-secondary" id="ch-rand">Удиви меня</button></div><div id="ch-code"></div></section>
    <section><h3>Принять вызов друга</h3><div class="row"><input class="input" id="ch-acc" placeholder="EL1-…" style="flex:1"><button class="btn btn-secondary btn-small" id="ch-acc-go">Принять</button></div></section>`,
    true,
  );
  const lim = () => {
    const g = cat.goals.find((x) => x.id === $('#ch-goal').value);
    $('#ch-lim').innerHTML = g.min.map((m, i) => `<option value="${m}" ${i === 1 ? 'selected' : ''}>${m} мин</option>`).join('');
  };
  $('#ch-goal').onchange = lim;
  lim();
  const show = (code) => {
    $('#ch-code').innerHTML = `<p class="hint">Отправь код другу (в Discord, Telegram…) и прими его сам — тогда играете на равных.</p><div class="row"><input class="input" readonly value="${esc(code)}" style="flex:1"><button class="btn btn-secondary btn-small" data-copy="${esc(code)}">Копировать</button><button class="btn btn-primary btn-small" id="ch-self">Принять самому</button></div>`;
    $('#ch-self').onclick = async () => {
      await call('challenge:accept', code);
      toast('Вызов принят — создай в игре новый мир');
      challengeDialog();
      render();
    };
  };
  $('#ch-make').onclick = async () => show(await call('challenge:create', { goal: $('#ch-goal').value, limitMin: Number($('#ch-lim').value), rules: $$('[data-ch-rule]').filter((c) => c.checked).map((c) => c.dataset.chRule) }));
  $('#ch-rand').onclick = async () => show(await call('challenge:create', { random: true }));
  $('#ch-acc-go').onclick = async () => {
    try {
      await call('challenge:accept', $('#ch-acc').value);
      toast('Вызов принят — создай в игре новый мир');
      challengeDialog();
      render();
    } catch (e) {
      toast(e.message);
    }
  };
  if ($('#ch-abandon'))
    $('#ch-abandon').onclick = async () => {
      await call('challenge:abandon');
      challengeDialog();
      render();
    };
  if ($('#ch-cmp-go'))
    $('#ch-cmp-go').onclick = async () => {
      try {
        const f = await call('challenge:compare', $('#ch-cmp').value);
        const mine = a.done?.seconds;
        const same = f.seed === a.seed;
        $('#ch-cmp-out').innerHTML = `<div class="notice ${same ? 'ok' : ''}"><strong>${esc(f.nick)}: ${dur(f.seconds)}${f.limitMin ? (f.seconds <= f.limitMin * 60 ? ' — уложился' : ' — дольше лимита') : ''}</strong>${!same ? 'Это результат другого вызова.' : mine == null ? 'Твоего результата пока нет.' : mine < f.seconds ? `Ты быстрее на ${dur(f.seconds - mine)}!` : mine > f.seconds ? `${esc(f.nick)} быстрее на ${dur(mine - f.seconds)}.` : 'Ничья!'}</div>`;
      } catch (e) {
        $('#ch-cmp-out').innerHTML = `<div class="notice error">${esc(e.message)}</div>`;
      }
    };
}

// ---------- «Фильм сессии» ----------
/** Ролики, снятые за время записи журнала сессий (конец сессии — at, длительность — seconds). */
function sessionClips(pid, s) {
  const end = Date.parse(s.at);
  const start = end - (s.seconds || 0) * 1000;
  return (S.memClips || []).filter((c) => c.profileId === pid && Date.parse(c.at) >= start - 60000 && Date.parse(c.at) <= end + 60000);
}
async function filmDialog(pid, s) {
  const clips = sessionClips(pid, s);
  dialog('Фильм сессии', `<p class="hint">${clips.length} ${plural(clips.length, 'ролик', 'ролика', 'роликов')} этой сессии склеиваются в один фильм 1280×720. Обычно это занимает до минуты.</p><div id="film-out"><p class="hint"><span class="spinner"></span>Склеиваю…</p></div>`, true);
  try {
    const end = new Date(Date.parse(s.at)).toISOString();
    const start = new Date(Date.parse(s.at) - (s.seconds || 0) * 1000).toISOString();
    const r = await call('memories:film', pid, start, end);
    if (!$('#film-out')) return;
    $('#film-out').innerHTML = `<video class="mem-video" src="${img(r.file)}&t=${Date.now()}" autoplay controls playsinline></video><p class="hint">${dur(r.seconds)} из ${r.clips} роликов. Файл лежит в папке роликов камеры — его можно отправить другу.</p><div class="actions"><button class="btn btn-secondary btn-small" id="film-show">${icon('folder')}Показать файл</button></div>`;
    $('#film-show').onclick = () => call('memories:filmFolder', r.file).catch((e) => toast(e.message));
  } catch (e) {
    if ($('#film-out')) $('#film-out').innerHTML = `<div class="notice error">${esc(e.message)}</div>`;
  }
}
