'use strict';
// Интерфейс easyLauncher. Все действия выполняет главный процесс; здесь — только отображение реальных
// состояний: без таймеров-«демо», выдуманных процентов, пинга и участников.
/* global icon */
// window.easy создаёт preload (contextBridge); объявлять его заново нельзя
const bridge = window.easy;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const call = (ch, ...a) =>
  bridge.call(ch, ...a).catch((e) => {
    throw Object.assign(new Error(e?.message || String(e)), e || {});
  });
const mb = (b) => (b < 1024 * 1024 ? Math.max(1, Math.round(b / 1024)) + ' КБ' : b < 1024 ** 3 ? (b / 1024 / 1024).toFixed(b > 100 * 1024 * 1024 ? 0 : 1) + ' МБ' : (b / 1024 ** 3).toFixed(1) + ' ГБ');
const img = (file) => (file ? `easyimg://img/?f=${encodeURIComponent(file).replace(/'/g, '%27')}` : '');
const bgStyle = (file) => (file ? `style="background-image:url('${img(file)}')"` : '');
const date = (iso) => (iso ? new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' }) : '');
const LOADERS = { vanilla: 'Vanilla', fabric: 'Fabric', quilt: 'Quilt', forge: 'Forge', neoforge: 'NeoForge' };
const MODES = { survival: 'Выживание', creative: 'Творчество', adventure: 'Приключение', spectator: 'Наблюдение' };
const SOURCES = { modrinth: 'Modrinth', curseforge: 'CurseForge' };
const ROUTES = { direct: 'напрямую', turn: 'через TURN', relay: 'через relay' };
const GUEST_STAGE = {
  'waiting-host': 'Ждём подтверждения хозяина',
  'try-direct': 'Пробуем прямое соединение',
  'try-relay': 'Подключаемся через relay',
  'route-direct': 'Соединение напрямую',
  'route-turn': 'Соединение через TURN',
  'route-relay': 'Соединение через relay',
  revoked: 'Хозяин отозвал приглашение',
  'host-offline': 'Хозяин вышел из сети',
};

const S = {
  view: 'play',
  sys: {},
  auth: { account: null },
  settings: {},
  profiles: [],
  selected: null,
  background: { kind: 'default' },
  status: { client: false, server: 'stopped', players: [], addresses: [] },
  busy: null, // {kind: 'play'|'coop'|'guest', pid}
  stage: null,
  room: null,
  roomError: null,
  guest: null,
  versions: [],
  worldsCache: {}, // pid → список миров
  builds: { detail: null, tab: 'mods', filter: '' },
  mods: { target: null, source: 'modrinth', query: '', category: '', sort: 'relevance', compatibleOnly: true, hits: null, total: 0, error: null, scroll: 0, project: null, cats: {}, cfAvailable: null, installing: {} },
  worlds: { pid: null },
  friends: { pid: null, folder: '', link: '' },
  assistant: { open: false, feed: [] },
  ai: null,
  aiInstall: null, // идущая загрузка модели {label, done, total}
};
const sel = () => S.profiles.find((p) => p.id === S.selected) || null;
const profile = (pid) => S.profiles.find((p) => p.id === pid) || null;
const me = () => S.auth.account?.name || S.settings.nickname || 'Player';
const sessionOn = () => S.status.server !== 'stopped';
const buildLabel = (p) => (p ? `${LOADERS[p.loader] || p.loader} ${p.minecraft}` : '');

// ---------- общие элементы ----------
let toastTimer;
function toast(text) {
  $('#toast').textContent = text;
  $('#toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($('#toast').hidden = true), 5000);
}
function hydrate(root = document) {
  root.querySelectorAll('[data-icon]').forEach((el) => (el.innerHTML = icon(el.dataset.icon)));
}
let lastFocus;
function dialog(title, body, wide = false) {
  if ($('#overlay').hidden) lastFocus = document.activeElement;
  $('#dialog-title').textContent = title;
  $('#dialog-body').innerHTML = body;
  $('.dialog').classList.toggle('wide', wide);
  $('#overlay').hidden = false;
  hydrate($('#dialog-body'));
  ($('#dialog-body [autofocus]') || $('#dialog-close')).focus();
}
function closeDialog() {
  $('#overlay').hidden = true;
  lastFocus?.focus?.();
}
$('#dialog-close').onclick = closeDialog;
// обработчик не должен возвращать false: это отменило бы клики внутри диалога (чекбоксы, раскрытие блоков)
$('#overlay').addEventListener('mousedown', (e) => {
  if (e.target.id === 'overlay') closeDialog();
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if ($('.popover')) return closePopover();
  if (!$('#overlay').hidden) closeDialog();
});
function closePopover() {
  $$('.popover').forEach((p) => p.remove());
}
document.addEventListener('mousedown', (e) => {
  if (!e.target.closest('.popover') && !e.target.closest('[data-popover]')) closePopover();
});

/** Ошибка с причиной и следующим действием — в одном месте для всех экранов. */
function errorDialog(e, title = 'Не получилось') {
  const acts = [];
  if (e.code === 'AUTH_REQUIRED') acts.push('<button class="btn btn-primary" data-act="login">Войти через Microsoft</button>');
  if (e.code === 'NO_MEMORY') acts.push('<button class="btn btn-secondary" data-act="build-settings">Память сборки</button>');
  if (e.code === 'WORLD_LOCKED' || e.code === 'SESSION_ACTIVE') acts.push('<button class="btn btn-secondary" data-act="friends">Открыть «С друзьями»</button>');
  if (['PORT_BUSY', 'CRASH', 'MODS', 'EXIT', 'WORLD', 'JAVA'].includes(e.code)) acts.push('<button class="btn btn-ghost" data-log="server">Журнал сервера</button>');
  // лаунчер знает, как исправить (например, недостающий обязательный мод): шаги и одна кнопка
  if (e.task) acts.unshift('<button class="btn btn-primary" id="err-fix">Исправить</button>');
  if (e.code === 'MISSING_DEPS' && e.retry) acts.push('<button class="btn btn-ghost" id="err-anyway">Всё равно запустить</button>');
  dialog(title, `<div class="notice error">${esc(e.message)}</div>${e.action ? `<p>${esc(e.action)}</p>` : ''}${e.task ? `<p><b>Что сделаю:</b></p>${taskSteps(e.task)}${e.task.significant ? '<p class="hint">Перед изменением сделаю копии миров этой сборки.</p>' : ''}<div id="err-progress"></div>` : ''}<div class="actions">${acts.join('')}<button class="btn btn-ghost" data-close>Закрыть</button></div>`, !!e.task);
  if ($('#err-anyway')) $('#err-anyway').onclick = () => (closeDialog(), e.retry());
  if (!$('#err-fix')) return;
  $('#err-fix').onclick = async () => {
    $('#err-fix').disabled = true;
    $('#err-progress').innerHTML = '<p class="hint"><span class="spinner"></span>Исправляю…</p>';
    const off = bridge.onModsProgress((x) => {
      if ($('#err-progress')) $('#err-progress').innerHTML = `<p class="hint">${x.phase === 'verify' ? 'Проверка файлов…' : `Скачано ${mb(x.done)} из ${mb(x.total)}${x.name ? ' · ' + esc(x.name) : ''}`}</p>`;
    });
    try {
      const r = await call('ai:run', e.task.id);
      closeDialog();
      toast(`Исправлено${r.linksAdded?.length ? ': добавлено ' + r.linksAdded.join(', ') : ''}. Жми «Играть».`);
      await refresh();
      render();
    } catch (err) {
      if ($('#err-progress')) $('#err-progress').innerHTML = `<div class="notice error">${esc(err.message)}</div>`;
      if ($('#err-fix')) $('#err-fix').disabled = false;
    } finally {
      off();
    }
  };
}

document.addEventListener('click', (e) => {
  const t = e.target;
  const a = t.closest('[data-act]');
  if (a) {
    const act = a.dataset.act;
    if (act === 'login') loginDialog();
    if (act === 'friends') go('friends');
    if (act === 'settings') go('settings');
    if (act === 'build-settings' && S.selected) openBuild(S.selected, 'settings');
    if (act === 'create-fabric') newBuildDialog('fabric');
    if (act === 'create-build') newBuildDialog();
  }
  if (t.closest('[data-close]')) closeDialog();
  const l = t.closest('[data-log]');
  if (l) logDialog(l.dataset.log);
  const c = t.closest('[data-copy]');
  if (c) call('clipboard:write', c.dataset.copy).then(() => toast('Скопировано'));
  const ext = t.closest('[data-external]');
  if (ext) call('open:external', ext.dataset.external).catch((err) => toast(err.message));
  const nav = t.closest('[data-go]');
  if (nav) go(nav.dataset.go);
});

// ---------- данные ----------
async function refresh() {
  const o = await call('profiles:overview');
  S.profiles = o.profiles;
  S.selected = o.selected;
  S.settings = o.settings;
  S.background = o.background;
  S.status = o.status;
  S.room = o.room;
  document.documentElement.style.setProperty('--dim', S.settings.dim);
  applyAppearance(S.settings.appearance);
  paintChrome();
}

/** Внешний вид: тема, акцент, анимации, масштаб — применяется сразу, без перезапуска. */
function applyAppearance(a) {
  if (!a) return;
  const r = document.documentElement;
  for (const k of ['style', 'blur', 'theme', 'motion', 'radius', 'sidebar', 'font']) r.dataset[k] = a[k];
  r.style.setProperty('--accent', a.accent);
  r.style.setProperty('--accent-strong', `color-mix(in srgb, ${a.accent} 72%, white)`);
  const [R, G, B] = [1, 3, 5].map((i) => parseInt(a.accent.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  r.style.setProperty('--accent-ink', 0.2126 * R + 0.7152 * G + 0.0722 * B > 0.35 ? '#1a1f14' : '#ffffff');
  bridge.zoom?.(a.scale / 100);
}
async function worldsOf(pid, force = false) {
  if (!pid) return [];
  if (force || !S.worldsCache[pid]) S.worldsCache[pid] = await call('worlds:list', pid).catch(() => []);
  return S.worldsCache[pid];
}
async function select(pid) {
  if (!pid || pid === S.selected) return;
  S.selected = pid;
  S.background = await call('profiles:select', pid);
  render();
}

let enterTimer;
/** Анимация входа в раздел — только при переходе, а не при каждой перерисовке (иначе мерцало бы). */
function animateEnter() {
  const m = $('#main');
  m.dataset.enter = '1';
  clearTimeout(enterTimer);
  enterTimer = setTimeout(() => delete m.dataset.enter, 900);
}
function go(view) {
  S.view = view;
  if (view === 'builds') S.builds.detail = null;
  closePopover();
  animateEnter();
  render();
  $('#main').scrollTop = 0;
}
// порядковые номера карточек — для поочерёдного появления
new MutationObserver(() => {
  if (!$('#main').dataset.enter) return; // нумерация нужна только для анимации входа
  $$('#main .grid, #main .list, #main .mini-worlds, #main .two-col').forEach((g) => [...g.children].forEach((c, i) => c.style.setProperty('--i', Math.min(i, 12))));
}).observe($('#main'), { childList: true, subtree: true });
const skeletons = (n, h = 66) => `<div class="list">${Array.from({ length: n }, () => `<div class="skeleton" style="height:${h}px"></div>`).join('')}</div>`;
$$('[data-view]').forEach((b) => (b.onclick = () => go(b.dataset.view)));

function paintChrome() {
  $$('[data-view]').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === S.view);
    b.toggleAttribute('aria-current', b.dataset.view === S.view);
  });
  $('#friends-badge').hidden = !sessionOn() && !S.guest?.playing;
  $('#account-name').textContent = me();
  $('#account-kind').textContent = S.auth.account ? 'Аккаунт Microsoft' : S.settings.offlineOk ? 'Без входа (офлайн)' : 'Вход не выполнен';
  paintProgress();
}

/** Ход подготовки: реальные этапы и объёмы из главного процесса. */
function progressHtml() {
  const st = S.stage;
  if (!st) return '';
  const known = st.percent != null;
  let right = known ? st.percent + '%' : '';
  if (st.total && st.unit === 'bytes') right = `${mb(st.done)} из ${mb(st.total)}`;
  else if (st.total && st.unit === 'files') right = `${st.done} из ${st.total} файлов`;
  return `<b>${esc(st.label || 'Подготовка')}</b><div class="sub"><span>${esc(st.detail || '')}</span><span>${esc(right)}</span></div><div class="bar ${known ? '' : 'indeterminate'}"><span style="width:${known ? st.percent : 30}%"></span></div>`;
}
function paintProgress() {
  const side = $('#side-progress');
  const on = !!(S.busy && S.stage);
  side.hidden = !on || S.view === 'play';
  if (on) side.innerHTML = progressHtml();
  const box = $('#launch-state');
  if (box) box.innerHTML = progressHtml();
}

let renderSeq = 0;
/** Номер текущей отрисовки: асинхронная отрисовка, которую обогнала более новая, ничего не рисует. */
const stale = (n) => n !== renderSeq;
function render() {
  renderSeq++;
  paintChrome();
  const v = S.view;
  const main = $('#main');
  if (v === 'play') return renderPlay(main);
  if (v === 'builds') return S.builds.detail ? renderBuild(main) : renderBuilds(main);
  if (v === 'mods') return renderMods(main);
  if (v === 'worlds') return renderWorlds(main);
  if (v === 'friends') return renderFriends(main);
  if (v === 'settings') return renderSettings(main);
}

// ---------- «Играть» ----------
const TIPS = [
  'F3 + H в игре показывает подробности о предметах: прочность и технические названия.',
  'F2 делает скриншот — он появится на главной, и его можно поставить фоном или обложкой мира.',
  'Перед большими изменениями сборки лаунчер сам делает копии миров. Вернуть мир — «Миры» → мир → «Резервные копии».',
  'Мод можно выключить, не удаляя: переключатель в сборке → «Моды». Он останется в составе, но не загрузится.',
  'Закреплённая версия мода (значок булавки) не меняется при «Обновить всё».',
  'В «Настройках» можно выбрать тему: жидкое стекло, аврору, неон, закат, пиксель или минимализм.',
  'В «Настройках» → «Игра» можно задать размер окна Minecraft или полный экран.',
  '«Установить» в каталоге модов само подбирает подходящую версию и нужные зависимости.',
  'Играть с друзьями можно без своего сервера: «С друзьями» → «Начать сессию» → ссылка-приглашение.',
  'Если игра тормозит, спроси помощника «у меня слабый ноутбук» — он предложит моды на FPS.',
  'Сборку можно сохранить в файл .easypack («Сборки» → сборка → «Настройки» → экспорт) и отправить другу.',
  'F3 + G показывает границы чанков — удобно для ферм и строительства.',
  'Чтобы не потеряться ночью, возьми с собой кровать: сон пропускает ночь и сохраняет точку возрождения.',
  'Кнопка «Продолжить …» на главной сразу заходит в последний мир, без главного меню.',
];
const hours = (sec) => {
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return h ? `${h} ч${m ? ' ' + m + ' мин' : ''}` : sec >= 60 ? `${m} мин` : sec > 0 ? 'меньше минуты' : '0 мин';
};
const SESSION_MODE = { play: 'Игра', friends: 'С друзьями', guest: 'В гостях' };

async function renderPlay(main) {
  const p = sel();
  if (!p) {
    main.innerHTML = `<div class="page"><div class="empty"><h3>Нет ни одной сборки</h3><p>Создай сборку — например, обычный Minecraft последней версии.</p><div class="actions"><button class="btn btn-primary" id="first-build">${icon('plus')}Создать сборку</button></div></div></div>`;
    $('#first-build').onclick = () => newBuildDialog();
    return;
  }
  const n = renderSeq;
  const [worlds, info] = await Promise.all([worldsOf(p.id), call('home:info', p.id).catch(() => null)]);
  if (S.view !== 'play' || stale(n)) return;
  const bg = S.background;
  const running = S.status.client && S.status.clientProfile === p.id;
  const otherRunning = S.status.client && !running;
  const preparing = S.busy && S.busy.pid === p.id;
  const lastWorld = worlds.find((w) => w.lastPlayed && !w.damaged);
  const coverThumb = p.cover || p.shot;
  const modded = p.loader !== 'vanilla';
  const st = info?.stats || {};
  const others = S.profiles.filter((x) => x.id !== p.id && x.kind !== 'room');
  const tipIdx = (S.tip ?? Math.floor(Date.now() / 86400000)) % TIPS.length;
  let playBtn;
  if (preparing) playBtn = `<button class="btn btn-secondary play-button" id="cancel-play">${icon('stop')}Отменить</button>`;
  else if (running) playBtn = `<button class="btn btn-secondary play-button" disabled>${icon('check')}Minecraft запущен</button>`;
  else playBtn = `<button class="btn btn-primary play-button" id="play" ${S.busy || otherRunning ? 'disabled' : ''}>${icon('play')}Играть</button>`;
  const canPlay = !(S.busy || S.status.client);

  const worldCards = worlds.length
    ? `<div class="home-world-grid">${worlds
        .slice(0, 6)
        .map((w) => {
          const pic = w.cover?.file || w.icon;
          return `<div class="hworld hcard"><div class="hworld-pic ${pic ? '' : 'none'}" ${bgStyle(pic)}>${pic ? '' : icon('globe')}${w.hosted ? '<span class="tag green corner">открыт для друзей</span>' : w.playing ? '<span class="tag green corner">идёт игра</span>' : ''}</div><div class="hworld-body"><b title="${esc(w.name)}">${esc(w.name)}</b><small>${esc([MODES[w.gamemode], w.hardcore ? 'хардкор' : '', w.lastPlayed ? date(w.lastPlayed) : ''].filter(Boolean).join(' · '))}</small></div><button class="btn btn-secondary btn-small" data-world-play="${esc(w.folder)}" ${!canPlay || w.hosted || w.damaged ? 'disabled' : ''} title="Войти сразу в этот мир">${icon('play')}Играть</button></div>`;
        })
        .join('')}</div>`
    : `<div class="hcard home-empty">${icon('globe')}<span>Миров пока нет. Нажми «Играть» и создай мир в Minecraft — он появится здесь с обложкой из твоих скриншотов.</span></div>`;

  const shots = info?.shots || [];
  const shotStrip = shots.length
    ? `<div class="shot-strip">${shots.map((x, i) => `<button class="shot" data-shot="${i}" ${bgStyle(x.file)} title="${esc(x.name)}" aria-label="Скриншот ${esc(date(new Date(x.t).toISOString()))}"></button>`).join('')}</div>`
    : `<div class="hcard home-empty">${icon('image')}<span>Скриншотов пока нет. В игре нажми <b>F2</b> — снимок появится здесь.</span></div>`;

  const sessions = info?.sessions || [];
  const sessionList = sessions.length
    ? `<ul class="hlist">${sessions
        .map((x) => `<li><span class="hlist-ic">${icon(x.mode === 'friends' ? 'users' : x.mode === 'guest' ? 'link' : 'play')}</span><span class="grow"><b>${esc(SESSION_MODE[x.mode] || 'Игра')}${x.worlds?.length ? ' · ' + esc(x.worlds.join(', ')) : ''}</b><small>${esc(date(x.at))}, ${new Date(x.at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })} · ${esc(hours(x.seconds))}${x.players?.length ? ' · ' + esc(x.players.join(', ')) : ''}</small></span></li>`)
        .join('')}</ul>`
    : '<p class="hint">Здесь будет история: когда играли, сколько, в каком мире и с кем.</p>';

  main.innerHTML = `<div class="home">
    <div class="home-bg ${bg.file ? '' : 'default'} ${!bg.file && S.sys.defaultBg ? 'has-image' : ''}" ${bgStyle(bg.file)}></div>
    <div class="home-content">
      ${sessionOn() ? `<div class="session-banner">${icon('users')}<span>Идёт сессия с друзьями${S.status.server === 'running' ? '' : ' — сервер запускается'}.</span><button class="btn btn-secondary btn-small" data-go="friends">Открыть</button></div>` : ''}
      <div class="home-top">
        <button class="build-picker" id="build-picker" data-popover aria-haspopup="listbox"><span class="build-thumb" ${bgStyle(coverThumb)}>${coverThumb ? '' : icon('cube')}</span><span><b>${esc(p.name)}</b><small>${esc(buildLabel(p))} · сменить сборку</small></span>${icon('chevron')}</button>
        ${bg.kind !== 'default' ? `<span class="bg-label">Фон: ${esc(bg.label)}</span>` : ''}
      </div>
      <div class="home-main">
        <div class="home-hero">
          <h1>${esc(p.name)}</h1>
          <div class="home-meta"><span class="tag">${esc(buildLabel(p))}</span>${modded ? `<span class="tag">${p.mods} ${plural(p.mods, 'мод', 'мода', 'модов')}${p.modsOff ? `, выключено ${p.modsOff}` : ''}</span>` : ''}${p.lastPlayed ? `<span class="tag">Запуск: ${esc(date(p.lastPlayed))}</span>` : ''}</div>
          <div class="play-row">${playBtn}${lastWorld && !preparing && !running ? `<button class="btn btn-secondary play-button" style="min-width:0;font-size:15px" id="continue" ${S.busy || otherRunning ? 'disabled' : ''}>${icon('globe')}<span>Продолжить «${esc(lastWorld.name)}»</span></button>` : ''}</div>
          ${preparing ? `<div class="launch-state" id="launch-state">${progressHtml()}</div>` : ''}
          ${running ? `<div class="launch-state"><b>Игра открыта.</b><div class="sub"><span>Закрой Minecraft как обычно, когда закончишь.</span></div><div class="actions" style="margin-top:6px"><button class="btn btn-ghost btn-small" data-log="client">Журнал игры</button><button class="btn btn-ghost btn-small" id="kill">Закрыть принудительно</button></div></div>` : ''}
          ${otherRunning ? `<p class="first-run">Сейчас запущена другая сборка: «${esc(profile(S.status.clientProfile)?.name || '')}». Закрой её, чтобы играть в этой.</p>` : ''}
          ${!p.lastPlayed && !preparing && !running ? `<p class="first-run">Первый запуск: лаунчер скачает Minecraft ${esc(p.minecraft)}${modded ? `, ${esc(LOADERS[p.loader])}` : ''} и подходящую Java. Это займёт несколько минут; дальше игра будет запускаться сразу.</p>` : ''}
          <div class="quick">
            <button class="quick-btn" data-q="friends">${icon('users')}<span>Позвать друзей</span></button>
            ${modded ? `<button class="quick-btn" data-q="mods">${icon('mods')}<span>Добавить моды</span></button>` : `<button class="quick-btn" data-act="create-fabric">${icon('mods')}<span>Сборка с модами</span></button>`}
            <button class="quick-btn" data-q="game">${icon('folder')}<span>Папка игры</span></button>
            <button class="quick-btn" data-q="screenshots">${icon('image')}<span>Скриншоты</span></button>
            <button class="quick-btn" data-q="settings">${icon('settings')}<span>Настройки сборки</span></button>
          </div>
        </div>
        <aside class="home-side">
          <div class="hcard stats">
            <h2>Статистика</h2>
            <div class="stat-grid">
              <div><b>${esc(hours(st.seconds || 0))}</b><small>в игре</small></div>
              <div><b>${st.launches || 0}</b><small>${plural(st.launches || 0, 'запуск', 'запуска', 'запусков')}</small></div>
              <div><b>${st.worlds ?? worlds.length}</b><small>${plural(st.worlds ?? worlds.length, 'мир', 'мира', 'миров')}</small></div>
              <div><b>${st.screenshots || 0}</b><small>${plural(st.screenshots || 0, 'скриншот', 'скриншота', 'скриншотов')}</small></div>
              ${modded ? `<div><b>${st.mods ?? p.mods}</b><small>${plural(st.mods ?? p.mods, 'мод', 'мода', 'модов')}</small></div>` : ''}
              <div><b>${st.sizeBytes ? mb(st.sizeBytes) : '—'}</b><small>на диске</small></div>
            </div>
            <p class="hint" style="margin:10px 0 0">${st.lastPlayed || sessions[0] ? `Последняя игра: ${esc(date(st.lastPlayed || sessions[0].at))}` : 'Ещё не запускалась.'}</p>
          </div>
          ${modded && S.settings.checkUpdates !== false ? `<div class="hcard" id="home-updates"><h2>Обновления модов</h2><p class="hint" style="margin:0">${p.mods ? 'Проверяем…' : 'Модов пока нет.'}</p></div>` : ''}
          <div class="hcard tip"><div class="tip-head"><h2>${icon('info')}Совет</h2><button class="icon-button" id="tip-next" aria-label="Следующий совет" title="Следующий совет">${icon('refresh')}</button></div><p>${esc(TIPS[tipIdx])}</p></div>
        </aside>
      </div>
      <section class="home-sec"><div class="sec-head"><h2>Миры этой сборки</h2>${worlds.length ? `<button class="btn btn-ghost btn-small" data-go="worlds">Все миры ${icon('arrow')}</button>` : ''}</div>${worldCards}</section>
      <section class="home-sec"><div class="sec-head"><h2>Последние скриншоты</h2>${shots.length ? `<button class="btn btn-ghost btn-small" data-q="screenshots">Открыть папку ${icon('arrow')}</button>` : ''}</div>${shotStrip}</section>
      <div class="home-two">
        <section class="home-sec hcard"><div class="sec-head"><h2>История сессий</h2></div>${sessionList}</section>
        ${S.settings.showNews !== false ? '<section class="home-sec hcard" id="home-news"><div class="sec-head"><h2>Новости Minecraft</h2></div><p class="hint">Загружаем…</p></section>' : ''}
      </div>
      ${others.length ? `<section class="home-sec"><div class="sec-head"><h2>Другие сборки</h2><button class="btn btn-ghost btn-small" data-go="builds">Все сборки ${icon('arrow')}</button></div><div class="other-builds">${others
        .slice(0, 8)
        .map((x) => `<div class="obuild hcard"><button class="obuild-main" data-switch="${esc(x.id)}" title="Сделать сборку выбранной"><span class="build-thumb" ${bgStyle(x.cover || x.shot)}>${x.cover || x.shot ? '' : icon('cube')}</span><span><b>${esc(x.name)}</b><small>${esc(buildLabel(x))}</small></span></button><button class="icon-button" data-play-other="${esc(x.id)}" aria-label="Играть в «${esc(x.name)}»" title="Играть" ${canPlay ? '' : 'disabled'}>${icon('play')}</button></div>`)
        .join('')}</div></section>` : ''}
    </div>
  </div>`;
  if ($('#play')) $('#play').onclick = () => play(p.id);
  if ($('#continue')) $('#continue').onclick = () => play(p.id, lastWorld.folder);
  if ($('#cancel-play')) $('#cancel-play').onclick = () => call('mc:cancel');
  if ($('#kill')) $('#kill').onclick = killDialog;
  $$('[data-world-play]').forEach((b) => (b.onclick = () => play(p.id, b.dataset.worldPlay)));
  $('#build-picker').onclick = (e) => buildPopover(e.currentTarget);
  $$('[data-q]').forEach(
    (b) =>
      (b.onclick = () => {
        const q = b.dataset.q;
        if (q === 'friends') {
          S.friends.pid = p.id;
          go('friends');
        } else if (q === 'mods') {
          S.mods.target = p.id;
          S.mods.project = null;
          go('mods');
        } else if (q === 'settings') openBuild(p.id, 'settings');
        else call('open:folder', q, p.id).catch((e) => toast(e.message));
      }),
  );
  $$('[data-shot]').forEach((b) => (b.onclick = () => shotDialog(p, shots, Number(b.dataset.shot), worlds)));
  $$('[data-switch]').forEach((b) => (b.onclick = () => select(b.dataset.switch)));
  $$('[data-play-other]').forEach(
    (b) =>
      (b.onclick = async () => {
        await select(b.dataset.playOther);
        play(b.dataset.playOther);
      }),
  );
  $('#tip-next').onclick = () => {
    S.tip = tipIdx + 1;
    $('.tip p').textContent = TIPS[S.tip % TIPS.length];
  };
  if (modded && p.mods && S.settings.checkUpdates !== false) paintUpdates(p, n);
  if (S.settings.showNews !== false) paintNews(n);
}

/** Карточка «Обновления модов»: проверка идёт после отрисовки, ответ кэшируется в ядре. */
async function paintUpdates(p, n, force = false) {
  const el = () => (S.view === 'play' && !stale(n) && S.selected === p.id ? $('#home-updates') : null);
  let r;
  try {
    r = await call('home:updates', p.id, force);
  } catch (e) {
    if (el()) el().innerHTML = `<h2>Обновления модов</h2><p class="hint" style="margin:0">Не удалось проверить: ${esc(e.message)}</p><div class="actions"><button class="btn btn-ghost btn-small" id="upd-retry">${icon('refresh')}Повторить</button></div>`;
    if ($('#upd-retry')) $('#upd-retry').onclick = () => paintUpdates(p, n, true);
    return;
  }
  const box = el();
  if (!box) return;
  box.classList.toggle('has-updates', r.count > 0);
  box.innerHTML = r.count
    ? `<h2>Обновления модов <span class="tag green">${r.count}</span></h2><p class="hint" style="margin:0">${esc(r.names.join(', '))}${r.count > r.names.length ? ' и другие' : ''}</p><div class="actions"><button class="btn btn-primary btn-small" id="upd-show">Посмотреть</button></div>`
    : `<h2>Обновления модов</h2><p class="hint" style="margin:0">${icon('check')} Все моды последних версий.</p><div class="actions"><button class="btn btn-ghost btn-small" id="upd-again">${icon('refresh')}Проверить ещё раз</button></div>`;
  if ($('#upd-show')) $('#upd-show').onclick = () => openPlan(p.id, { update: 'all' }, 'Обновления сборки');
  if ($('#upd-again')) $('#upd-again').onclick = () => ((box.querySelector('.hint').textContent = 'Проверяем…'), paintUpdates(p, n, true));
}

/** Новости Minecraft (изменения Java Edition от Mojang). Нет сети и кэша — блок честно об этом пишет. */
async function paintNews(n) {
  // один запрос на все перерисовки, пока он идёт
  if (!S.news) S.news = await (S.newsLoading ||= call('home:news').catch((e) => ({ error: e.message })).finally(() => (S.newsLoading = null)));
  const box = S.view === 'play' && !stale(n) ? $('#home-news') : null;
  if (!box) return;
  const list = Array.isArray(S.news) ? S.news : [];
  if (!list.length) {
    box.innerHTML = `<div class="sec-head"><h2>Новости Minecraft</h2></div><p class="hint">Новости не загрузились${S.news?.error ? ': нет связи с сервером Mojang' : ''}. Они появятся, когда будет интернет.</p>`;
    if (S.news?.error) S.news = null; // попробовать снова при следующем открытии
    return;
  }
  box.innerHTML = `<div class="sec-head"><h2>Новости Minecraft</h2></div><ul class="hlist news">${list
    .slice(0, 4)
    .map((x, i) => `<li><button class="news-item" data-news="${i}">${x.image ? `<span class="news-pic" style="background-image:url('${esc(x.image)}')"></span>` : `<span class="hlist-ic">${icon('info')}</span>`}<span class="grow"><b>${esc(x.title)}</b><small>${x.type === 'snapshot' ? 'Снапшот · ' : ''}${esc(date(x.date))}</small></span></button></li>`)
    .join('')}</ul>`;
  $$('[data-news]').forEach((b) => (b.onclick = () => newsDialog(list[Number(b.dataset.news)])));
}

/** Запись новостей: HTML от Mojang не вставляется как есть — из него берутся только заголовки, абзацы и пункты. */
async function newsDialog(x) {
  dialog(x.title, `<p class="hint">${x.type === 'snapshot' ? 'Снапшот · ' : ''}${esc(date(x.date))} · текст от Mojang на английском</p><div class="news-body">${x.text ? `<p>${esc(x.text)}</p>` : ''}<p class="hint">Загружаем полный текст…</p></div>`, true);
  if (!x.contentPath && !x.body) return ($('.news-body .hint').textContent = '');
  try {
    const { body } = x.body ? x : await call('home:newsBody', x.contentPath);
    const doc = new DOMParser().parseFromString(body, 'text/html');
    doc.querySelectorAll('script, style, noscript, template').forEach((e) => e.remove());
    const first = doc.querySelector('h1');
    if (first && first.textContent.trim() === x.title) first.remove(); // заголовок уже в окне
    const out = [];
    for (const el of doc.body.querySelectorAll('h1, h2, h3, p, li')) {
      const t = el.textContent.trim();
      if (!t || (el.tagName !== 'LI' && el.closest('li'))) continue; // абзац внутри пункта уже попал в текст пункта
      out.push(el.tagName === 'LI' ? `<li>${esc(t)}</li>` : /^H/.test(el.tagName) ? `<h3>${esc(t)}</h3>` : `<p>${esc(t)}</p>`);
      if (out.length > 400) break;
    }
    const nb = $('.news-body');
    if (nb) nb.innerHTML = out.join('').replace(/(<li>.*?<\/li>)+/gs, (m) => `<ul>${m}</ul>`) || `<p>${esc(x.text)}</p>`;
  } catch {
    const h = $('.news-body .hint');
    if (h) h.textContent = 'Полный текст не загрузился.';
  }
}

/** Скриншот крупно: фон лаунчера, обложка сборки или мира, папка. */
function shotDialog(p, shots, i, worlds) {
  const x = shots[i];
  if (!x) return;
  dialog(
    'Скриншот · ' + date(new Date(x.t).toISOString()),
    `<div class="shot-big" ${bgStyle(x.file)}>${i > 0 ? `<button class="icon-button shot-nav prev" id="sh-prev" aria-label="Предыдущий">${icon('back')}</button>` : ''}${i < shots.length - 1 ? `<button class="icon-button shot-nav next" id="sh-next" aria-label="Следующий">${icon('arrow')}</button>` : ''}</div>
    <div class="actions"><button class="btn btn-secondary btn-small" id="sh-bg">${icon('image')}Фон лаунчера</button><button class="btn btn-secondary btn-small" id="sh-cover">Обложка сборки</button>${worlds.length ? `<select class="input" id="sh-world" style="max-width:220px" aria-label="Мир для обложки"><option value="">Обложка мира…</option>${worlds.map((w) => `<option value="${esc(w.folder)}">${esc(w.name)}</option>`).join('')}</select>` : ''}<span class="spacer"></span><button class="btn btn-ghost btn-small" id="sh-folder">${icon('folder')}Папка</button></div>`,
    true,
  );
  if ($('#sh-prev')) $('#sh-prev').onclick = () => shotDialog(p, shots, i - 1, worlds);
  if ($('#sh-next')) $('#sh-next').onclick = () => shotDialog(p, shots, i + 1, worlds);
  const done = async (msg) => {
    toast(msg);
    closeDialog();
    await refresh().catch(() => {});
    S.background = await call('bg:for', S.selected).catch(() => S.background);
    S.worldsCache = {};
    render();
  };
  $('#sh-bg').onclick = async () => {
    try {
      S.settings = await call('bg:shot', p.id, x.file);
      done('Скриншот стал фоном лаунчера.');
    } catch (e) {
      toast(e.message);
    }
  };
  $('#sh-cover').onclick = () => call('profiles:coverShot', p.id, x.file).then(() => done('Обложка сборки обновлена.'), (e) => toast(e.message));
  if ($('#sh-world')) $('#sh-world').onchange = (e) => e.target.value && call('worlds:coverShot', p.id, e.target.value, x.file).then(() => done('Обложка мира обновлена.'), (er) => toast(er.message));
  $('#sh-folder').onclick = () => call('open:folder', 'screenshots', p.id).catch((e) => toast(e.message));
}

/** Поле памяти: любое целое число ГБ; пусто — автоматически. Пресеты — быстрые кнопки. */
function ramField(id, value, { max, auto, presets }) {
  return `<div class="ram-field"><div class="row"><input class="input" id="${id}" type="number" inputmode="numeric" min="1" max="${max}" step="1" placeholder="Авто${auto ? ` (${auto} ГБ)` : ''}" value="${value ?? ''}" style="max-width:150px"><span class="hint" style="margin:0">ГБ</span></div><div class="row" style="margin-top:8px">${presets.filter((n) => n <= max).map((n) => `<button type="button" class="chip" data-ram-for="${id}" data-v="${n}">${n}</button>`).join('')}<button type="button" class="chip" data-ram-for="${id}" data-v="">Авто</button></div><p class="hint" id="${id}-err"></p></div>`;
}
/** Проверка введённой памяти: null — авто; число — 1…max; иначе текст ошибки. */
function readRam(id, max) {
  const raw = $('#' + id).value.trim().replace(',', '.');
  if (!raw) return { value: null };
  const n = Number(raw);
  if (!Number.isInteger(n)) return { error: 'Целое число гигабайт, например 6.' };
  if (n < 1) return { error: 'Минимум 1 ГБ.' };
  if (n > max) return { error: `Не больше ${max} ГБ: остальная память нужна системе.` };
  return { value: n };
}
function wireRam(id, max, save) {
  const apply = async () => {
    const r = readRam(id, max);
    $('#' + id + '-err').textContent = r.error || '';
    $('#' + id).classList.toggle('invalid', !!r.error);
    if (!r.error) await save(r.value);
  };
  $('#' + id).onchange = apply;
  $$(`[data-ram-for="${id}"]`).forEach((b) => (b.onclick = () => (($('#' + id).value = b.dataset.v), apply())));
}

function plural(n, one, few, many) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

function buildPopover(anchor) {
  closePopover();
  const r = anchor.getBoundingClientRect();
  const pop = document.createElement('div');
  pop.className = 'popover';
  pop.setAttribute('role', 'listbox');
  pop.style.left = r.left + 'px';
  pop.style.top = r.bottom + 6 + 'px';
  pop.innerHTML =
    S.profiles.map((p) => `<button role="option" data-pick="${esc(p.id)}" class="${p.id === S.selected ? 'current' : ''}"><span class="build-thumb" ${bgStyle(p.cover || p.shot)}>${p.cover || p.shot ? '' : icon('cube')}</span><span><b>${esc(p.name)}</b><small>${esc(buildLabel(p))}${p.loader !== 'vanilla' ? ` · ${p.mods} ${plural(p.mods, 'мод', 'мода', 'модов')}` : ''}</small></span></button>`).join('') +
    `<button data-pick="__new">${icon('plus')}<span>Новая сборка</span></button>`;
  document.body.appendChild(pop);
  hydrate(pop);
  $$('[data-pick]', pop).forEach(
    (b) =>
      (b.onclick = () => {
        closePopover();
        if (b.dataset.pick === '__new') newBuildDialog();
        else select(b.dataset.pick);
      }),
  );
  $('button.current', pop)?.focus();
}

function killDialog() {
  dialog('Закрыть Minecraft принудительно?', '<p>Несохранённый прогресс в открытом мире может потеряться. Обычно лучше выйти из игры через её меню.</p><div class="actions"><button class="btn btn-danger" id="kill-go">Закрыть игру</button><button class="btn btn-ghost" data-close>Отмена</button></div>');
  $('#kill-go').onclick = () => {
    call('mc:stopClient');
    closeDialog();
  };
}

/** Вход объясняется в момент, когда он нужен — при первом запуске. */
function loginGate(then) {
  dialog(
    'Как войти в игру',
    `<p>Для Minecraft Java Edition нужен аккаунт Microsoft, на котором куплена игра. Пароль вводится только на сайте Microsoft — лаунчер его не видит.</p>
    <div class="actions"><button class="btn btn-primary" id="gate-login" autofocus>${icon('lock')}Войти через Microsoft</button></div><p class="hint" id="gate-status"></p>
    <details class="more" id="gate-more"><summary>Играть без входа</summary><p class="hint">Офлайн-профиль: только одиночная игра и игра по локальной сети. На серверы с проверкой аккаунтов (и в «С друзьями») без входа попасть нельзя.</p><form id="gate-offline"><label class="field" for="gate-nick">Никнейм</label><input class="input" id="gate-nick" maxlength="16" pattern="[A-Za-z0-9_]{3,16}" required value="${esc(S.settings.nickname || '')}"><p class="hint">3–16 символов: латиница, цифры и _.</p><div class="actions"><button class="btn btn-secondary" type="submit">Играть без входа</button></div></form></details>`,
  );
  $('#gate-login').onclick = async () => {
    $('#gate-status').textContent = 'Ждём вход в окне Microsoft…';
    try {
      S.auth = await call('auth:login');
      closeDialog();
      paintChrome();
      then();
    } catch (e) {
      $('#gate-status').textContent = e.message + (e.action ? ' ' + e.action : '');
      // вход недоступен не по вине игрока — сразу показываем игру без входа
      if (e.code === 'APP_NOT_APPROVED' && $('#gate-more')) $('#gate-more').open = true;
    }
  };
  $('#gate-offline').onsubmit = async (e) => {
    e.preventDefault();
    try {
      S.settings = await call('settings:set', { nickname: $('#gate-nick').value.trim(), offlineOk: true });
      closeDialog();
      paintChrome();
      then();
    } catch (err) {
      $('#gate-status').textContent = err.message;
    }
  };
}

async function play(pid, world = null, server = null, skipLinks = false) {
  if (!S.auth.account && !S.settings.offlineOk) return loginGate(() => play(pid, world, server));
  S.busy = { kind: 'play', pid };
  S.stage = { label: 'Проверка' };
  render();
  try {
    const r = await call('mc:play', { profileId: pid, world, server, skipLinks });
    if (world && r.worldJoin === false) toast('Эта версия Minecraft не умеет входить сразу в мир — откроется главное меню.');
  } catch (e) {
    // «Всё равно запустить» — если игрок уверен, что проверка связей ошиблась
    if (e.code === 'MISSING_DEPS') e.retry = () => play(pid, world, server, true);
    if (e.code !== 'CANCELLED') errorDialog(e, e.code === 'MISSING_DEPS' ? 'Сборка не запустится' : 'Игра не запустилась');
  } finally {
    S.busy = null;
    S.stage = null;
    await refresh().catch(() => {});
    render();
  }
}

// ---------- события главного процесса ----------
bridge.onEvent(async (ev) => {
  if (ev.type === 'stage') {
    S.stage = ev;
    paintProgress();
  } else if (ev.type === 'server') {
    S.status = { ...S.status, server: ev.state, players: ev.players || [], port: ev.port, serverProfile: ev.profileId, serverFolder: ev.folder, addresses: ev.addresses || [] };
    if (ev.state === 'stopped') {
      S.worldsCache = {};
      if (ev.failure && !S.busy) errorDialog({ message: ev.failure.message, action: ev.failure.action, code: ev.failure.kind }, 'Сервер остановился');
      else if (ev.expected) toast('Мир сохранён, сессия завершена.');
    }
    if (['friends', 'play', 'worlds'].includes(S.view)) render();
    else paintChrome();
  } else if (ev.type === 'client') {
    S.status.client = ev.state === 'running';
    S.status.clientProfile = ev.state === 'running' ? ev.profileId : null;
    if (ev.state === 'stopped') {
      S.worldsCache = {};
      if (ev.mode === 'guest' && S.guest) S.guest.playing = false;
      await refresh().catch(() => {});
      if (ev.code && ev.code !== 0 && ev.crash && !ev.killed) crashDialog(ev);
      else if (ev.sessionActive) sessionAfterGameDialog();
    }
    render();
  } else if (ev.type === 'worlds-changed' || ev.type === 'world-session') {
    delete S.worldsCache[ev.profileId];
    if (['worlds', 'play'].includes(S.view)) render();
  } else if (ev.type === 'screenshot') {
    delete S.worldsCache[ev.profileId];
  }
});
bridge.onRoom((st) => {
  S.room = st;
  if (S.view === 'friends') render();
});
bridge.onGuestStage((s) => {
  if (!S.guest) return;
  S.guest.stage = s;
  if (s.startsWith('route-')) S.guest.route = s.slice(6);
  if (s === 'revoked' || s === 'host-offline') toast(GUEST_STAGE[s]);
  const el = $('#guest-stage');
  if (el) el.textContent = GUEST_STAGE[s] || '';
});
bridge.onInvite((link) => {
  S.friends.link = link;
  go('friends');
  guestCheck(link);
});

function sessionAfterGameDialog() {
  dialog('Ты вышел из игры', '<p>Сессия с друзьями продолжается: друзья могут играть, пока она запущена и компьютер включён.</p><div class="actions"><button class="btn btn-primary" id="keep">Оставить сессию</button><button class="btn btn-secondary" id="stop">Сохранить мир и завершить</button></div>');
  $('#keep').onclick = () => {
    closeDialog();
    go('friends');
  };
  $('#stop').onclick = () => {
    closeDialog();
    endCoop();
  };
}

/** Разбор вылета — правилами (работает и без модели помощника). */
async function crashDialog(ev) {
  let body = '';
  let task = null;
  try {
    const r = await call('ai:ask', ev.crash, ev.profileId);
    const f = r.findings || [];
    body = f.map((x) => `<div class="notice ${x.level === 'error' ? 'error' : ''}"><strong>${esc(x.title)}</strong>${esc(x.fix)}</div>`).join('') || (r.needMore ? `<p>${esc(r.needMore)}</p>` : '');
    if (r.guess) body += `<div class="notice"><strong>${r.guess.confident ? 'Вероятная причина' : 'Предположение'}</strong>${esc(r.guess.text)}</div>`;
    // помощник знает, как это исправить: показываем, что сделает, — одна кнопка
    if (r.task) {
      task = r.task;
      body += `<p><b>Могу исправить сам:</b></p>${taskSteps(task)}${task.significant ? '<p class="hint">Перед изменением сделаю копии миров этой сборки.</p>' : ''}<div id="fix-progress"></div>`;
    }
  } catch {}
  dialog(`Minecraft закрылся с ошибкой (код ${ev.code})`, `${body || '<p>Причину по журналу определить не удалось.</p>'}<div class="actions">${task ? '<button class="btn btn-primary" id="crash-fix">Исправить</button>' : ''}<button class="btn btn-secondary" data-log="client">Журнал игры</button><button class="btn btn-ghost" data-close>Закрыть</button></div>`, true);
  if (!task) return;
  $('#crash-fix').onclick = async () => {
    $('#crash-fix').disabled = true;
    $('#fix-progress').innerHTML = '<p class="hint"><span class="spinner"></span>Исправляю…</p>';
    const off = bridge.onModsProgress((x) => {
      if ($('#fix-progress')) $('#fix-progress').innerHTML = `<p class="hint">${x.phase === 'verify' ? 'Проверка файлов…' : `Скачано ${mb(x.done)} из ${mb(x.total)}${x.name ? ' · ' + esc(x.name) : ''}`}</p>`;
    });
    try {
      await call('ai:run', task.id);
      closeDialog();
      toast('Исправлено. Запусти игру ещё раз.');
      await refresh();
      render();
    } catch (e) {
      if ($('#fix-progress')) $('#fix-progress').innerHTML = `<div class="notice error">${esc(e.message)}</div>`;
      if ($('#crash-fix')) $('#crash-fix').disabled = false;
    } finally {
      off();
    }
  };
}

// ---------- «Сборки» ----------
function coverOf(p) {
  return p.cover || p.shot || null;
}
function renderBuilds(main) {
  main.innerHTML = `<div class="page">
    <div class="page-head"><div class="grow"><h1>Сборки</h1><p class="lead">Каждая сборка — своя версия игры, свои моды и свои миры.</p></div><button class="btn btn-ghost" id="import">${icon('upload')}Импорт</button><button class="btn btn-primary" id="new">${icon('plus')}Новая сборка</button></div>
    <div class="grid">${S.profiles
      .map((p) => {
        const c = coverOf(p);
        return `<article class="card ${p.id === S.selected ? 'selected' : ''}"><button class="card-cover ${c ? 'has-image' : ''}" ${bgStyle(c)} data-open="${esc(p.id)}" aria-label="Открыть сборку ${esc(p.name)}">${icon('cube')}${p.id === S.selected ? '<span class="corner tag green">Выбрана</span>' : ''}</button><div class="card-body"><div class="card-title">${esc(p.name)}</div><div class="card-meta">${esc(buildLabel(p))}${p.loader !== 'vanilla' ? ` · ${p.mods} ${plural(p.mods, 'мод', 'мода', 'модов')}` : ''}</div><div class="card-actions"><button class="btn btn-primary btn-small" data-play="${esc(p.id)}" ${S.busy || S.status.client ? 'disabled' : ''}>${icon('play')}Играть</button><span class="spacer"></span><button class="btn btn-ghost btn-small" data-open="${esc(p.id)}">Открыть</button></div></div></article>`;
      })
      .join('')}<button class="new-card" id="new2">${icon('plus')}<span>Новая сборка<br><small>Vanilla, Fabric, Quilt, Forge или NeoForge</small></span></button></div></div>`;
  $('#new').onclick = $('#new2').onclick = () => newBuildDialog();
  $('#import').onclick = importBuild;
  $$('[data-open]').forEach((b) => (b.onclick = () => openBuild(b.dataset.open)));
  $$('[data-play]').forEach(
    (b) =>
      (b.onclick = async () => {
        await select(b.dataset.play);
        S.view = 'play';
        play(b.dataset.play);
      }),
  );
}

function openBuild(pid, tab = 'mods') {
  S.view = 'builds';
  animateEnter();
  S.builds = { detail: pid, tab, filter: '' };
  render();
  $('#main').scrollTop = 0;
}

const VTYPES = { release: 'Релизы', snapshot: 'Снапшоты (тестовые)', old_beta: 'Бета (2010–2011)', old_alpha: 'Альфа (2010)' };
const LOADER_HINT = {
  vanilla: 'Обычный Minecraft без модов',
  fabric: 'Лёгкий и быстрый, много модов на оптимизацию',
  quilt: 'Ответвление Fabric, запускает и моды Fabric',
  forge: 'Классика: большие моды и старые сборки',
  neoforge: 'Современная ветка Forge (1.20.1+)',
};
async function loadVersions() {
  if (!S.versions.length) S.versions = await call('mc:versions').catch(() => []);
  return S.versions;
}
/** Список версий для выбора: по типам, с учётом загрузчика (только версии, где он есть). */
function versionOptionsHtml(list, current, { snapshots = false, old = false, supported = null } = {}) {
  const groups = {};
  for (const v of list) {
    if (v.type === 'snapshot' && !snapshots && v.id !== current) continue;
    if ((v.type === 'old_beta' || v.type === 'old_alpha') && !old && v.id !== current) continue;
    if (supported && !supported.has(v.id) && v.id !== current) continue;
    (groups[v.type] = groups[v.type] || []).push(v.id);
  }
  if (current && !list.some((v) => v.id === current)) (groups.release = groups.release || []).unshift(current);
  return Object.keys(VTYPES)
    .filter((t) => groups[t]?.length)
    .map((t) => `<optgroup label="${VTYPES[t]}">${groups[t].map((id) => `<option value="${esc(id)}" ${id === current ? 'selected' : ''}>${esc(id)}</option>`).join('')}</optgroup>`)
    .join('');
}
async function versionOptions(current) {
  return versionOptionsHtml(await loadVersions(), current);
}

async function newBuildDialog(loader = 'vanilla') {
  const list = await loadVersions();
  const st = { loader, snapshots: false, old: false, supported: null, lv: null, mc: list.find((v) => v.type === 'release')?.id || '1.21.1' };
  dialog(
    'Новая сборка',
    `<form id="nb"><label class="field" for="nb-name">Название</label><input class="input" id="nb-name" maxlength="60" placeholder="Например, Выживание с друзьями" autofocus>
    <label class="field">Загрузчик</label><div class="loader-grid" role="group">${Object.keys(LOADER_HINT).map((l) => `<button type="button" class="loader-card" data-loader="${l}" aria-pressed="${l === loader}"><b>${LOADERS[l]}</b><small>${LOADER_HINT[l]}</small></button>`).join('')}</div>
    <label class="field" for="nb-ver">Версия Minecraft</label><select class="input" id="nb-ver"></select>
    <div class="row" style="margin-top:8px"><label class="check" style="margin:0"><input type="checkbox" id="nb-snap"><span>Снапшоты</span></label><label class="check" style="margin:0"><input type="checkbox" id="nb-old"><span>Бета и альфа (2010–2011)</span></label></div>
    <p class="hint" id="nb-vhint">${list.length ? '' : 'Нет связи с Mojang — список версий недоступен.'}</p>
    <div id="nb-lv-box" hidden><label class="field" for="nb-lv">Версия загрузчика</label><select class="input" id="nb-lv"></select><p class="hint" id="nb-lv-hint"></p></div>
    <details class="more"><summary>Дополнительно</summary><p class="hint">Можно импортировать сборку easyLauncher из файла .easypack.</p><div class="actions"><button type="button" class="btn btn-secondary btn-small" id="nb-import">${icon('upload')}Импорт из файла</button></div></details>
    <div class="actions"><button class="btn btn-primary" type="submit" id="nb-go">Создать</button><button class="btn btn-ghost" type="button" data-close>Отмена</button></div></form>`,
    true,
  );
  let seq = 0;
  const paintVersions = () => {
    $('#nb-ver').innerHTML = versionOptionsHtml(list, st.mc, st);
    if (!$('#nb-ver').value && $('#nb-ver').options.length) $('#nb-ver').selectedIndex = 0;
    st.mc = $('#nb-ver').value;
  };
  // версии загрузчика для выбранной версии игры: рекомендуемая выбрана сразу
  const loadLoader = async () => {
    const my = ++seq;
    const box = $('#nb-lv-box');
    $('#nb-go').disabled = false;
    if (st.loader === 'vanilla') return (box.hidden = true);
    box.hidden = false;
    $('#nb-lv').innerHTML = '<option>Загрузка…</option>';
    $('#nb-lv').disabled = true;
    $('#nb-go').disabled = true;
    $('#nb-lv-hint').textContent = '';
    try {
      const r = await call('loaders:versions', st.loader, st.mc);
      if (my !== seq) return;
      if (!r.list.length) {
        $('#nb-lv').innerHTML = '<option>—</option>';
        $('#nb-lv-hint').textContent = `${LOADERS[st.loader]} не выпускался для Minecraft ${st.mc}. Выбери другую версию игры.`;
        return;
      }
      // стабильные сверху, тестовые — отдельной группой ниже
      const opt = (x) => `<option value="${esc(x.version)}" ${x.version === r.recommended ? 'selected' : ''}>${esc(x.version)}${x.version === r.recommended ? ' — рекомендуется' : ''}</option>`;
      const stable = r.list.filter((x) => x.stable);
      const test = r.list.filter((x) => !x.stable);
      $('#nb-lv').innerHTML = (stable.length ? `<optgroup label="Стабильные">${stable.map(opt).join('')}</optgroup>` : '') + (test.length ? `<optgroup label="Тестовые — могут работать нестабильно">${test.map(opt).join('')}</optgroup>` : '');
      $('#nb-lv').disabled = false;
      $('#nb-go').disabled = false;
      $('#nb-lv-hint').textContent = st.loader === 'forge' || st.loader === 'neoforge' ? `При первом запуске лаунчер скачает официальный установщик ${LOADERS[st.loader]} и запустит его без окна.` : '';
    } catch (e) {
      if (my !== seq) return;
      $('#nb-lv').innerHTML = '<option>—</option>';
      $('#nb-lv-hint').textContent = `Не удалось получить версии ${LOADERS[st.loader]}: ${e.message}`;
    }
  };
  const onLoader = async () => {
    $$('[data-loader]').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.loader === st.loader)));
    st.supported = null;
    if (st.loader !== 'vanilla') {
      const sup = await call('loaders:support', st.loader).catch(() => null);
      st.supported = sup ? new Set(sup) : null;
    }
    paintVersions();
    $('#nb-vhint').textContent = st.supported ? `Показаны версии, для которых есть ${LOADERS[st.loader]}.` : '';
    loadLoader();
  };
  $$('[data-loader]').forEach((b) => (b.onclick = () => ((st.loader = b.dataset.loader), onLoader())));
  $('#nb-ver').onchange = (e) => ((st.mc = e.target.value), loadLoader());
  $('#nb-snap').onchange = (e) => ((st.snapshots = e.target.checked), paintVersions(), loadLoader());
  $('#nb-old').onchange = (e) => ((st.old = e.target.checked), paintVersions(), loadLoader());
  $('#nb-import').onclick = () => {
    closeDialog();
    importBuild();
  };
  onLoader();
  $('#nb').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const lv = st.loader === 'vanilla' ? null : $('#nb-lv').value;
      const p = await call('profiles:create', { name: $('#nb-name').value.trim(), minecraft: $('#nb-ver').value, loader: st.loader, loaderVersion: lv });
      closeDialog();
      await refresh();
      S.background = await call('bg:for', p.id);
      if (st.loader !== 'vanilla') {
        S.mods.target = p.id;
        S.mods.hits = null;
        go('mods');
        toast(`Сборка «${p.name}» (${LOADERS[st.loader]} ${lv}) создана. Добавь моды — они будут ставиться в неё.`);
      } else {
        go('play');
        toast(`Сборка «${p.name}» создана и выбрана.`);
      }
    } catch (err) {
      toast(err.message);
    }
  };
}

async function importBuild() {
  try {
    const r = await call('profiles:import');
    if (!r) return;
    await refresh();
    if (r.plan) planDialog(r.plan, `Импорт «${r.profile.name}»: моды`, { pid: r.profile.id });
    else toast(`Сборка «${r.profile.name}» импортирована`);
    openBuild(r.profile.id);
  } catch (e) {
    errorDialog(e, 'Импорт не удался');
  }
}

async function renderBuild(main) {
  const pid = S.builds.detail;
  const n = renderSeq;
  let d;
  try {
    d = await call('profiles:details', pid);
  } catch (e) {
    S.builds.detail = null;
    return renderBuilds(main);
  }
  if (S.view !== 'builds' || S.builds.detail !== pid || stale(n)) return;
  const p = d.profile;
  const c = coverOf(p);
  const tab = S.builds.tab;
  const busy = d.busy;
  main.innerHTML = `<div class="page">
    <button class="btn btn-ghost" id="back" style="margin:-8px 0 12px -10px">${icon('back')}Все сборки</button>
    <div class="detail-head"><div class="detail-cover" ${bgStyle(c)}>${c ? '' : icon('cube')}</div><div style="flex:1;min-width:0"><h1>${esc(p.name)}</h1><div class="row" style="margin-top:6px"><span class="tag">${esc(buildLabel(p))}</span>${p.loader !== 'vanilla' ? `<span class="tag">${d.lock.mods.length} ${plural(d.lock.mods.length, 'мод', 'мода', 'модов')}</span>` : ''}<span class="tag">${d.worlds.length} ${plural(d.worlds.length, 'мир', 'мира', 'миров')}</span>${busy ? '<span class="tag warn">Используется</span>' : ''}</div></div><button class="btn btn-primary" id="play-build" ${S.busy || S.status.client ? 'disabled' : ''}>${icon('play')}Играть</button></div>
    <div class="tabs" role="tablist">${[['mods', 'Моды'], ['worlds', 'Миры'], ['settings', 'Настройки']].map(([k, t]) => `<button role="tab" data-tab="${k}" aria-selected="${tab === k}">${t}</button>`).join('')}</div>
    <div id="tab-body"></div></div>`;
  $('#back').onclick = () => go('builds');
  $('#play-build').onclick = async () => {
    await select(pid);
    S.view = 'play';
    play(pid);
  };
  $$('[data-tab]').forEach(
    (b) =>
      (b.onclick = () => {
        S.builds.tab = b.dataset.tab;
        render();
      }),
  );
  const body = $('#tab-body');
  if (tab === 'mods') buildModsTab(body, d);
  else if (tab === 'worlds') worldsGrid(body, pid, d.worlds);
  else buildSettingsTab(body, d);
}

function sideText(side) {
  const c = side?.client;
  const s = side?.server;
  if (c !== 'unsupported' && s === 'unsupported') return 'только у игрока';
  if (c === 'unsupported') return 'только на сервере';
  if (c === 'unknown' || s === 'unknown') return 'сторона не указана';
  return 'игрок и сервер';
}

function buildModsTab(body, d) {
  const p = d.profile;
  const busy = d.busy;
  if (p.loader === 'vanilla') {
    body.innerHTML = `<div class="empty"><h3>Это сборка Vanilla</h3><p>Моды работают через загрузчик: Fabric, Quilt, Forge или NeoForge. Можно перевести эту сборку на загрузчик (во вкладке «Настройки») или создать отдельную сборку с модами.</p><div class="actions"><button class="btn btn-primary" id="to-fabric" ${busy ? 'disabled' : ''}>Перевести на Fabric</button><button class="btn btn-secondary" data-act="create-fabric">Новая сборка с модами</button></div></div>`;
    $('#to-fabric').onclick = () => openPlan(p.id, { retarget: { loader: 'fabric' } }, 'Перевести на Fabric', { retarget: true });
    return;
  }
  const f = S.builds.filter.toLowerCase();
  const mods = d.lock.mods.filter((m) => !f || m.name.toLowerCase().includes(f));
  body.innerHTML = `${busy ? '<div class="notice">Сборка сейчас используется (игра или сессия с друзьями) — менять её состав можно после выхода.</div>' : ''}
    <div class="toolbar"><label class="search"><span class="sr-only">Поиск среди установленных</span>${icon('search')}<input class="input" id="inst-filter" placeholder="Поиск среди установленных" value="${esc(S.builds.filter)}"></label>
    <button class="btn btn-primary" id="add-mods">${icon('plus')}Добавить моды</button><button class="btn btn-secondary" id="check-upd" ${busy || !d.lock.mods.length ? 'disabled' : ''}>${icon('refresh')}Проверить обновления</button>${d.canRollback ? `<button class="btn btn-ghost" id="rollback" ${busy ? 'disabled' : ''}>${icon('history')}Вернуть прежний состав</button>` : ''}</div>
    ${
      d.lock.mods.length
        ? `<div class="list">${mods
            .map((m) => {
              const on = m.enabled !== false;
              return `<div class="mod-row ${on ? '' : 'off'}"><span class="mod-icon">${esc(m.name.slice(0, 1).toUpperCase())}</span><div class="mod-main"><div class="mod-name">${esc(m.name)}${m.addedBy === 'dependency' ? '<span class="tag">зависимость</span>' : ''}${m.pinned ? '<span class="tag">версия закреплена</span>' : ''}${on ? '' : '<span class="tag warn">выключен</span>'}</div><div class="mod-sub">${esc(m.version)} · ${esc(SOURCES[m.source] || m.source)} · ${sideText(m.side)}</div></div>
          <div class="mod-actions"><button class="switch" role="switch" aria-checked="${on}" aria-label="${on ? 'Выключить' : 'Включить'} ${esc(m.name)}" data-toggle="${esc(m.key)}" ${busy ? 'disabled' : ''}></button><button class="icon-button" title="${m.pinned ? 'Открепить версию' : 'Закрепить версию: не обновлять'}" aria-pressed="${!!m.pinned}" data-pin="${esc(m.key)}" ${busy ? 'disabled' : ''} style="${m.pinned ? 'color:var(--accent)' : ''}">${icon('pin')}</button><button class="icon-button" title="Обновить" data-upd="${esc(m.key)}" ${busy || m.pinned ? 'disabled' : ''}>${icon('refresh')}</button><button class="icon-button" title="Удалить" data-remove="${esc(m.key)}" ${busy ? 'disabled' : ''}>${icon('trash')}</button></div></div>`;
            })
            .join('') || '<p class="hint">Ничего не найдено.</p>'}</div>`
        : `<div class="empty"><h3>Модов пока нет</h3><p>Открой каталог — моды подбираются под ${esc(buildLabel(p))}, зависимости ставятся сами.</p><div class="actions"><button class="btn btn-primary" id="add-mods2">Открыть каталог модов</button></div></div>`
    }`;
  const toCatalog = () => {
    S.mods.target = p.id;
    S.mods.hits = null;
    S.mods.project = null;
    go('mods');
  };
  $('#add-mods').onclick = toCatalog;
  if ($('#add-mods2')) $('#add-mods2').onclick = toCatalog;
  const fi = $('#inst-filter');
  fi.oninput = () => {
    S.builds.filter = fi.value;
    buildModsTab(body, d);
    const n = $('#inst-filter');
    n.focus();
    n.setSelectionRange(n.value.length, n.value.length);
  };
  if ($('#check-upd')) $('#check-upd').onclick = () => openPlan(p.id, { update: 'all' }, 'Обновления сборки');
  if ($('#rollback'))
    $('#rollback').onclick = () => {
      dialog('Вернуть прежний состав?', '<p>Сборка вернётся к составу модов до последнего изменения. Перед этим лаунчер сделает копии миров этой сборки.</p><div class="actions"><button class="btn btn-primary" id="rb-go">Вернуть</button><button class="btn btn-ghost" data-close>Отмена</button></div>');
      $('#rb-go').onclick = async () => {
        try {
          await call('mods:rollback', p.id);
          closeDialog();
          toast('Прежний состав возвращён');
          await refresh();
          render();
        } catch (e) {
          errorDialog(e, 'Откат не удался');
        }
      };
    };
  $$('[data-toggle]').forEach(
    (b) =>
      (b.onclick = async () => {
        const on = b.getAttribute('aria-checked') !== 'true';
        try {
          const r = await call('mods:enable', p.id, b.dataset.toggle, on);
          if (r.warnings.length) dialog('Обрати внимание', r.warnings.map((w) => `<div class="notice">${esc(w)}</div>`).join('') + '<div class="actions"><button class="btn btn-primary" data-close>Понятно</button></div>');
          await refresh();
          render();
        } catch (e) {
          errorDialog(e);
        }
      }),
  );
  $$('[data-pin]').forEach(
    (b) =>
      (b.onclick = async () => {
        await call('mods:pin', p.id, b.dataset.pin, b.getAttribute('aria-pressed') !== 'true').catch(errorDialog);
        render();
      }),
  );
  $$('[data-upd]').forEach(
    (b) =>
      (b.onclick = async () => {
        const plan = await call('mods:plan', p.id, { update: [b.dataset.upd] }).catch((e) => (errorDialog(e), null));
        if (!plan) return;
        if (!plan.changes.length && plan.ok) return toast('Это последняя совместимая версия.');
        planDialog(plan, 'Обновить мод', { pid: p.id, request: { update: [b.dataset.upd] } });
      }),
  );
  $$('[data-remove]').forEach((b) => (b.onclick = () => openPlan(p.id, { remove: [b.dataset.remove] }, 'Удалить мод')));
}

async function buildSettingsTab(body, d) {
  const p = d.profile;
  const busy = d.busy;
  const total = S.sys.totalRamGiB || 8;
  const ramMax = Math.max(2, total - 2);
  body.innerHTML = `<div class="two-col"><div class="panel">
    <h2>Основное</h2>
    <form id="bs"><label class="field" for="bs-name">Название</label><input class="input" id="bs-name" maxlength="60" value="${esc(p.name)}">
    <label class="field" for="bs-ram">Память для игры</label>${ramField('bs-ram', p.ram, { max: ramMax, auto: d.budget.client, presets: [2, 4, 6, 8, 12, 16] })}<p class="hint">ОЗУ компьютера: ${total} ГБ. Сборкам с большим числом модов нужно больше памяти.</p>
    <div class="actions"><button class="btn btn-primary" type="submit">Сохранить</button></div></form>
    <details class="more"><summary>Версия игры и загрузчик</summary><p class="hint">Сейчас: ${esc(buildLabel(p))}. При смене версии лаунчер подберёт совместимые релизы модов, покажет, что изменится, и сделает копии миров.</p><label class="field" for="bs-ver">Версия Minecraft</label><select class="input" id="bs-ver" ${busy || p.kind === 'room' ? 'disabled' : ''}>${await versionOptions(p.minecraft)}</select><label class="field" for="bs-loader">Загрузчик</label><select class="input" id="bs-loader" ${busy || p.kind === 'room' ? 'disabled' : ''}>${Object.keys(LOADER_HINT).map((l) => `<option value="${l}" ${l === p.loader ? 'selected' : ''}>${LOADERS[l]} — ${LOADER_HINT[l]}</option>`).join('')}</select><p class="hint">Моды одного загрузчика обычно не работают в другом: при смене лаунчер подберёт версии модов под новый загрузчик, а несовместимые покажет.</p><div class="notice">Открывать мир в более старой версии игры, чем та, в которой он сохранён, опасно — он может повредиться.</div></details>
    </div><div class="panel"><h2>Обложка сборки</h2><p class="hint">По умолчанию — последний скриншот из этой сборки. Своя обложка закрепляется и сама не меняется.</p><div class="detail-cover" style="width:100%;height:150px;margin-top:12px" ${bgStyle(coverOf(p))}>${coverOf(p) ? '' : icon('image')}</div><p class="hint">${p.cover ? 'Своя обложка (закреплена)' : p.shot ? 'Последний скриншот сборки' : 'Скриншотов пока нет'}</p>
    <div class="actions"><button class="btn btn-secondary btn-small" id="pc-pick">${icon('image')}Своя картинка</button><button class="btn btn-secondary btn-small" id="pc-shot">Из скриншотов</button>${p.cover ? '<button class="btn btn-ghost btn-small" id="pc-clear">Убрать</button>' : ''}</div>
    <h2 style="margin-top:22px">Файлы</h2><div class="actions"><button class="btn btn-ghost btn-small" data-folder="game">${icon('folder')}Папка игры</button><button class="btn btn-ghost btn-small" data-folder="mods">Моды</button><button class="btn btn-ghost btn-small" data-folder="screenshots">Скриншоты</button><button class="btn btn-ghost btn-small" id="export">${icon('download')}Экспорт сборки</button></div>
    <details class="more"><summary>Удалить сборку</summary><p class="hint">Перед удалением лаунчер сохранит копии всех её миров (${d.worlds.length}) в папку резервных копий.</p><label class="field" for="bs-del">Для подтверждения введи название сборки</label><input class="input" id="bs-del" placeholder="${esc(p.name)}"><div class="actions"><button class="btn btn-danger btn-small" id="bs-delete" ${busy ? 'disabled' : ''}>Удалить сборку</button></div></details></div></div>`;
  hydrate(body);
  $$('[data-ram-for="bs-ram"]').forEach((b) => (b.onclick = () => ($('#bs-ram').value = b.dataset.v)));
  $('#bs').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const ram = readRam('bs-ram', ramMax);
      if (ram.error) return ($('#bs-ram-err').textContent = ram.error);
      await call('profiles:update', p.id, { name: $('#bs-name').value, ram: ram.value });
      await refresh();
      toast('Сохранено');
      render();
    } catch (err) {
      toast(err.message);
    }
  };
  $('#bs-loader').onchange = async (e) => {
    const l = e.target.value;
    if (l === p.loader) return;
    // список возвращается к текущему значению: сборка меняется только после «Применить»
    e.target.value = p.loader;
    const plan = await call('mods:plan', p.id, { retarget: { loader: l } }).catch((err) => (errorDialog(err), null));
    if (plan) planDialog(plan, `Перейти на ${LOADERS[l]}`, { pid: p.id, retarget: true, request: { retarget: { loader: l } } });
  };
  $('#bs-ver').onchange = async (e) => {
    const v = e.target.value;
    if (v === p.minecraft) return;
    e.target.value = p.minecraft;
    const plan = await call('mods:plan', p.id, { retarget: { minecraft: v } }).catch((err) => (errorDialog(err), null));
    if (plan) planDialog(plan, `Перейти на Minecraft ${v}`, { pid: p.id, retarget: true, request: { retarget: { minecraft: v } } });
  };
  $('#pc-pick').onclick = async () => {
    if (await call('profiles:coverPick', p.id).catch(errorDialog)) await afterCover();
  };
  $('#pc-shot').onclick = () => shotPicker(p.id, async (file) => {
    await call('profiles:coverShot', p.id, file);
    await afterCover();
  });
  if ($('#pc-clear')) $('#pc-clear').onclick = async () => (await call('profiles:coverClear', p.id), afterCover());
  async function afterCover() {
    await refresh();
    S.background = await call('bg:for', S.selected);
    render();
  }
  $$('[data-folder]').forEach((b) => (b.onclick = () => call('open:folder', b.dataset.folder, p.id)));
  $('#export').onclick = async () => {
    const r = await call('profiles:export', p.id).catch(errorDialog);
    if (r) toast(`Сборка сохранена в файл: ${r.mods} ${plural(r.mods, 'мод', 'мода', 'модов')} (файлы модов скачаются при импорте)`);
  };
  $('#bs-delete').onclick = async () => {
    try {
      const r = await call('profiles:delete', p.id, $('#bs-del').value);
      toast(r.backedUp.length ? `Сборка удалена. Копии миров сохранены: ${r.backedUp.join(', ')}` : 'Сборка удалена');
      if (!(await call('profiles:overview')).profiles.length) await call('profiles:first');
      await refresh();
      go('builds');
    } catch (err) {
      toast(err.message);
    }
  };
}

async function shotPicker(pid, onPick) {
  const shots = await call('profiles:screenshots', pid).catch(() => []);
  dialog(
    'Скриншоты сборки',
    shots.length
      ? `<p class="hint">Скриншоты из папки этой сборки (F2 в игре). Лаунчер не знает наверняка, в каком мире сделан каждый снимок, — выбери сам.</p><div class="shots" style="margin-top:12px">${shots.map((s) => `<button data-shot="${esc(s.file)}" ${bgStyle(s.file)} aria-label="${esc(s.name)}" title="${esc(s.name)}"></button>`).join('')}</div>`
      : '<div class="empty"><h3>Скриншотов пока нет</h3><p>В игре нажми F2 — снимок появится здесь.</p></div>',
    true,
  );
  $$('[data-shot]').forEach(
    (b) =>
      (b.onclick = async () => {
        try {
          await onPick(b.dataset.shot);
          closeDialog();
        } catch (e) {
          toast(e.message);
        }
      }),
  );
}

// ---------- план изменений сборки (каталог, обновления, помощник) ----------
function planHtml(plan) {
  const ch = plan.changes
    .map((c) => `<li>${icon(c.type === 'remove' ? 'trash' : c.type === 'update' ? 'refresh' : 'plus')}<span>${c.type === 'add' ? 'Добавить' : c.type === 'update' ? 'Обновить' : 'Удалить'} <b>${esc(c.name)}</b> ${c.type === 'update' ? `${esc(c.from)} → ${esc(c.to)}` : esc(c.to || c.from || '')}${c.dependencyOf ? ` <small>— нужен для ${esc(c.dependencyOf)}</small>` : ''}${c.manual ? ' <small>— файл вручную</small>' : ''}</span></li>`)
    .join('');
  const adds = plan.changes.filter((c) => c.type !== 'remove');
  const deps = plan.changes.filter((c) => c.dependencyOf).length;
  // что проверено до установки — чтобы было видно, что лаунчер не ставит моды «вслепую»
  const checked = adds.length
    ? `<details class="more checked"><summary>${icon('check')} Совместимость проверена</summary><ul class="plan-steps"><li>${icon('check')}<span>Версии подобраны под Minecraft ${esc(plan.nextMinecraft || '')} и ${esc(LOADERS[plan.nextLoader] || plan.nextLoader || '')}: несовместимые релизы не ставятся</span></li><li>${icon('check')}<span>Обязательные зависимости найдены и добавлены${deps ? ` (${deps})` : ''}, в том числе зависимости зависимостей</span></li><li>${icon('check')}<span>Конфликты, которые указал автор мода, и дубликаты с другой площадки — проверены</span></li><li>${icon('check')}<span>После скачивания: хеш файла и что внутри мод именно для ${esc(LOADERS[plan.nextLoader] || '')} — иначе установка отменяется и сборка остаётся прежней</span></li></ul></details>`
    : '';
  const blocked = !plan.ok && plan.errors.length;
  return `${plan.changes.length ? `<ul class="plan-steps">${ch}</ul>${checked}` : blocked ? '<p>Установить пока нельзя — нужно твоё решение:</p>' : '<p>Изменений нет.</p>'}${plan.errors.map((e) => `<div class="notice error">${esc(e.message)}${e.code === 'PRERELEASE_ONLY' ? `<div class="actions"><button class="btn btn-secondary btn-small" data-prerelease>Разрешить тестовую версию</button></div>` : ''}</div>`).join('')}${plan.warnings.map((w) => `<div class="notice">${esc(w.message)}</div>`).join('')}${plan.questions.map((q) => `<div class="notice">${esc(q.message)}<div class="actions"><button class="btn btn-secondary btn-small" data-choice="${esc(q.key)}" data-val="skip">Не ставить</button><button class="btn btn-ghost btn-small" data-choice="${esc(q.key)}" data-val="keep-both">Это другой мод — поставить</button></div></div>`).join('')}${plan.manual.length ? `<div class="notice"><strong>Автор разрешил скачивание только со своей страницы:</strong>${plan.manual.map((m) => `<div class="addr"><div><b>${esc(m.name)}</b><small>${esc(m.file.filename)}</small></div><button class="btn btn-ghost btn-small" data-external="${esc(m.pageUrl || '')}">Страница</button><button class="btn btn-secondary btn-small" data-import="${esc(m.key)}">Выбрать файл</button></div>`).join('')}</div>` : ''}${plan.significant ? '<div class="notice"><strong>Значительное изменение</strong>Перед применением лаунчер сделает резервные копии миров этой сборки. Прежний состав модов можно будет вернуть.</div>' : ''}${plan.sizeBytes ? `<p class="hint">Загрузка: ${mb(plan.sizeBytes)}. Хеши файлов проверяются — это подтверждает целостность, но не безопасность кода мода.</p>` : ''}`;
}

/** Построить план и показать его; ошибка построения — понятным окном, а не тихим сбоем. */
async function openPlan(pid, request, title, extra = {}) {
  try {
    planDialog(await call('mods:plan', pid, request), title, { pid, request, ...extra });
  } catch (e) {
    errorDialog(e, 'Не удалось построить план');
  }
}

function planDialog(plan, title, ctx = {}) {
  const imports = {};
  const pid = ctx.pid || S.selected;
  const render_ = () => {
    if (plan.ok && !plan.changes.length && !ctx.retarget) {
      dialog(title, `<p>${ctx.request?.update ? 'Всё актуально: новых совместимых версий нет.' : 'Изменений нет.'}</p>${plan.warnings.map((x) => `<div class="notice">${esc(x.message)}</div>`).join('')}<div class="actions"><button class="btn btn-primary" data-close>Закрыть</button></div>`);
      return;
    }
    dialog(title, `${ctx.explanation ? `<p>${esc(ctx.explanation)}</p>` : ''}${planHtml(plan)}<div id="apply-progress"></div><div class="actions"><button class="btn btn-primary" id="plan-apply" ${plan.ok && (plan.changes.length || ctx.retarget) ? '' : 'disabled'}>Применить</button><button class="btn btn-ghost" id="plan-cancel">Отмена</button></div>`, true);
    $('#plan-cancel').onclick = closeDialog;
    $$('[data-prerelease]').forEach(
      (b) =>
        (b.onclick = async () => {
          b.disabled = true;
          ctx.request = { ...(ctx.request || {}), allowPrerelease: true };
          try {
            plan = await call('mods:plan', pid, { ...ctx.request, choices: ctx.choices });
            render_();
          } catch (e) {
            toast(e.message);
            b.disabled = false;
          }
        }),
    );
    $$('[data-choice]').forEach(
      (b) =>
        (b.onclick = async () => {
          ctx.choices = { ...(ctx.choices || {}), [b.dataset.choice]: b.dataset.val };
          try {
            plan = await call('mods:plan', pid, { ...(ctx.request || {}), choices: ctx.choices });
            render_();
          } catch (e) {
            toast(e.message);
          }
        }),
    );
    $$('[data-import]').forEach(
      (b) =>
        (b.onclick = async () => {
          const f = await call('mods:pickFile');
          if (f) {
            imports[b.dataset.import] = f;
            b.textContent = 'Файл выбран';
          }
        }),
    );
    $('#plan-apply').onclick = async () => {
      $('#plan-apply').disabled = true;
      $('#plan-cancel').textContent = 'Отменить загрузку';
      $('#plan-cancel').onclick = () => call('mods:cancel');
      const off = bridge.onModsProgress((p) => {
        const el = $('#apply-progress');
        if (el) el.innerHTML = `<p class="hint">${p.phase === 'verify' ? 'Проверка файлов…' : p.phase === 'done' ? 'Готово' : `Скачано ${mb(p.done)} из ${mb(p.total)}${p.name ? ' · ' + esc(p.name) : ''}`}</p><div class="bar"><span style="width:${p.total ? Math.floor((p.done / p.total) * 100) : 100}%"></span></div>`;
      });
      try {
        const r = await call('mods:apply', plan.planId, imports);
        closeDialog();
        toast(r.backups?.length ? `Сборка обновлена. Копии миров: ${r.backups.length}` : 'Сборка обновлена');
        missingWarning(r.missing);
        S.worldsCache = {};
        markInstalled(plan);
        await refresh();
        render();
      } catch (e) {
        $('#apply-progress').innerHTML = `<div class="notice error">${esc(e.message)}</div>`;
        $('#plan-cancel').textContent = 'Закрыть';
        $('#plan-cancel').onclick = closeDialog;
        $('#plan-apply').disabled = false;
      } finally {
        off();
      }
    };
  };
  render_();
}

/** Проверка файлов после установки нашла обязательный мод, о котором каталог не знает. */
function missingWarning(missing) {
  if (!missing?.length) return;
  const list = missing.map((m) => `«${m.by.map((b) => b.name).join('», «')}» требует «${m.id}»`).join('; ');
  dialog('Не хватает обязательного мода', `<div class="notice">${esc(list)}. Каталог об этом не сообщил — это видно только по файлу мода.</div><p>При нажатии «Играть» лаунчер предложит исправить: найдёт недостающий мод в каталоге или уберёт тот, которому он нужен.</p><div class="actions"><button class="btn btn-primary" data-close>Понятно</button></div>`);
}

// ---------- «Моды»: каталог ----------
function markInstalled(plan) {
  if (!S.mods.hits) return;
  for (const c of plan.changes) {
    const h = S.mods.hits.find((x) => x.key === c.key);
    if (h) h.installed = c.type === 'remove' ? null : { version: c.to, enabled: true };
  }
}

async function renderMods(main) {
  // моды ставятся только в сборки с загрузчиком: Vanilla в списке «Устанавливать в» не нужна
  const modded = S.profiles.filter((p) => p.loader !== 'vanilla');
  if (!modded.some((p) => p.id === S.mods.target)) S.mods.target = modded.find((p) => p.id === S.selected)?.id || modded[0]?.id || null;
  const target = profile(S.mods.target);
  if (!target) {
    S.mods.project = null;
    main.innerHTML = `<div class="page"><div class="page-head"><div class="grow"><h1>Моды</h1><p class="lead">Каталоги Modrinth и CurseForge. Подходящий релиз и зависимости подбираются сами.</p></div></div>
    <div class="empty"><h3>Нет сборки для модов</h3><p>Моды работают в сборке с загрузчиком — Fabric, Quilt, Forge или NeoForge. ${S.profiles.length ? 'Сейчас все твои сборки — Vanilla.' : ''}</p><div class="actions"><button class="btn btn-primary" data-act="create-fabric">${icon('plus')}Новая сборка с модами</button></div></div></div>`;
    return;
  }
  if (S.mods.cfAvailable === null) {
    const st = await call('catalog:status').catch(() => null);
    S.mods.cfAvailable = !!st?.curseforge?.available;
    S.mods.cfReason = st?.curseforge?.reason || '';
  }
  if (S.view !== 'mods') return;
  const targetBar = `<div class="target-bar"><span>Устанавливать в</span><select class="input" id="mod-target" aria-label="Сборка для установки">${modded.map((p) => `<option value="${esc(p.id)}" ${p.id === S.mods.target ? 'selected' : ''}>${esc(p.name)} — ${esc(buildLabel(p))}</option>`).join('')}</select><span class="hint" style="margin:0">Показываем моды для ${esc(buildLabel(target))}</span></div>`;
  if (S.mods.project) return renderProject(main, targetBar);
  main.innerHTML = `<div class="page"><div class="page-head"><div class="grow"><h1>Моды</h1><p class="lead">Каталоги Modrinth и CurseForge. Подходящий релиз и зависимости подбираются сами.</p></div></div>${targetBar}
    <form class="toolbar" id="mod-search"><label class="search"><span class="sr-only">Поиск модов</span>${icon('search')}<input class="input" id="mod-q" placeholder="Поиск: название или задача" value="${esc(S.mods.query)}" autocomplete="off"></label>
    <select class="input" id="mod-src" aria-label="Источник"><option value="modrinth">Modrinth</option><option value="curseforge" ${S.mods.cfAvailable ? '' : 'disabled'}>CurseForge${S.mods.cfAvailable ? '' : ' — недоступен'}</option></select>
    <select class="input" id="mod-cat" aria-label="Категория"><option value="">Все категории</option></select>
    <select class="input" id="mod-sort" aria-label="Сортировка"><option value="relevance">По релевантности</option><option value="downloads">Популярные</option><option value="updated">Недавно обновлённые</option><option value="newest">Новые</option></select></form>
    <label class="check"><input type="checkbox" id="mod-compat" ${S.mods.compatibleOnly ? 'checked' : ''}><span>Только совместимые с выбранной сборкой</span></label>
    <div id="mod-results"></div></div>`;
  $('#mod-src').value = S.mods.source;
  $('#mod-sort').value = S.mods.sort;
  $('#mod-target').onchange = async (e) => {
    S.mods.target = e.target.value;
    S.mods.hits = null;
    await select(e.target.value);
    render();
  };
  loadCategories();
  const run = () => {
    S.mods.query = $('#mod-q').value.trim();
    S.mods.hits = null;
    searchMods();
  };
  let deb;
  $('#mod-q').oninput = () => {
    clearTimeout(deb);
    deb = setTimeout(run, 450);
  };
  $('#mod-search').onsubmit = (e) => {
    e.preventDefault();
    clearTimeout(deb);
    run();
  };
  $('#mod-src').onchange = () => {
    S.mods.source = $('#mod-src').value;
    S.mods.category = '';
    loadCategories();
    run();
  };
  $('#mod-cat').onchange = () => {
    S.mods.category = $('#mod-cat').value;
    run();
  };
  $('#mod-sort').onchange = () => {
    S.mods.sort = $('#mod-sort').value;
    run();
  };
  $('#mod-compat').onchange = () => {
    S.mods.compatibleOnly = $('#mod-compat').checked;
    run();
  };
  if (S.mods.hits) {
    paintResults();
    $('#main').scrollTop = S.mods.scroll;
  } else searchMods();
}

async function loadCategories() {
  const src = S.mods.source;
  if (!S.mods.cats[src]) S.mods.cats[src] = await call('catalog:categories', src).catch(() => []);
  const el = $('#mod-cat');
  if (!el) return;
  el.innerHTML = '<option value="">Все категории</option>' + S.mods.cats[src].map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
  el.value = S.mods.category;
}

let searchSeq = 0;
async function searchMods(more = false) {
  const target = profile(S.mods.target);
  const out = $('#mod-results');
  if (!target || !out) return;
  const seq = ++searchSeq;
  if (!more) out.innerHTML = skeletons(5);
  try {
    const r = await call('catalog:search', S.mods.source, { query: S.mods.query, minecraft: target.minecraft, loader: target.loader, category: S.mods.category || undefined, sort: S.mods.sort, anyVersion: !S.mods.compatibleOnly, offset: more ? S.mods.hits.length : 0, limit: 20 }, target.id);
    if (seq !== searchSeq) return;
    S.mods.hits = more ? [...S.mods.hits, ...r.hits] : r.hits;
    S.mods.total = r.total;
    S.mods.error = null;
  } catch (e) {
    if (seq !== searchSeq) return;
    S.mods.error = e;
    if (!more) S.mods.hits = [];
  }
  paintResults();
}

function paintResults() {
  const out = $('#mod-results');
  if (!out) return;
  const m = S.mods;
  const target = profile(m.target);
  if (m.error) {
    out.innerHTML = `<div class="notice error"><strong>Каталог не ответил</strong>${esc(m.error.message)}</div><div class="actions"><button class="btn btn-secondary" id="retry">Повторить</button></div>`;
    $('#retry').onclick = () => searchMods();
    return;
  }
  if (!m.hits.length) {
    out.innerHTML = `<div class="empty"><h3>Ничего не нашлось</h3><p>${m.compatibleOnly ? `Возможно, у мода нет версии для ${esc(buildLabel(target))}. Сними галочку «Только совместимые», чтобы увидеть все.` : 'Попробуй другое название или категорию.'}</p></div>`;
    return;
  }
  const vanilla = target?.loader === 'vanilla';
  out.innerHTML = `<p class="hint" style="margin-bottom:10px">Найдено: ${m.total}</p><div class="list">${m.hits
    .map((h) => {
      const busy = m.installing[h.key];
      const action = h.installed
        ? `<span class="tag green">${icon('check')}Установлен</span>`
        : busy
          ? `<span class="tag">${esc(busy)}</span>`
          : `<button class="btn btn-secondary btn-small" data-install="${esc(h.id)}" ${vanilla || !m.compatibleOnly ? 'title="Открой карточку, чтобы проверить совместимость"' : ''} ${vanilla ? 'disabled' : ''}>Установить</button>`;
      return `<div class="mod-row clickable" data-proj="${esc(h.id)}" tabindex="0" role="button" aria-label="${esc(h.name)} — подробнее"><span class="mod-icon">${h.iconUrl ? `<img src="${esc(h.iconUrl)}" alt="" loading="lazy">` : icon('mods')}</span><div class="mod-main"><div class="mod-name">${esc(h.name)}<span class="tag">${esc(SOURCES[h.source])}</span></div><div class="mod-sub">${esc(h.author || '')}${h.downloads ? ` · ${Number(h.downloads).toLocaleString('ru-RU')} загрузок` : ''}</div><div class="mod-desc">${esc(h.summary || '')}</div></div><div class="mod-actions">${action}</div></div>`;
    })
    .join('')}</div>${m.hits.length < m.total ? '<div class="actions" style="justify-content:center"><button class="btn btn-secondary" id="more">Показать ещё</button></div>' : ''}`;
  hydrate(out);
  if ($('#more')) $('#more').onclick = () => searchMods(true);
  $$('[data-proj]', out).forEach((row) => {
    const open = (e) => {
      if (e.target.closest('button')) return;
      S.mods.scroll = $('#main').scrollTop;
      S.mods.project = { source: S.mods.source, id: row.dataset.proj, all: false };
      animateEnter();
      render();
      $('#main').scrollTop = 0;
    };
    row.onclick = open;
    row.onkeydown = (e) => e.key === 'Enter' && open(e);
  });
  $$('[data-install]', out).forEach((b) => (b.onclick = () => installMod(S.mods.source, b.dataset.install)));
}

/** «Установить»: без диалога, если план простой; иначе — показать, что изменится. */
let installChain = Promise.resolve();
/** Установки идут по одной: прогресс загрузки всегда относится к той строке, что сейчас ставится. */
function installMod(source, id) {
  const key = `${source}:${id}`;
  if (S.mods.installing[key]) return;
  S.mods.installing[key] = 'В очереди…';
  paintResults();
  const pid = S.mods.target;
  installChain = installChain.then(() => installOne(source, id, pid));
  return installChain;
}
async function installOne(source, id, pid) {
  const key = `${source}:${id}`;
  if (!profile(pid)) return void delete S.mods.installing[key];
  S.mods.installing[key] = 'Устанавливается…';
  const row = document.querySelector(`.mod-row[data-proj="${CSS.escape(id)}"] .mod-actions .tag`);
  if (row) row.textContent = S.mods.installing[key];
  // прогресс меняет только надпись в строке этого мода — список целиком не перерисовывается (иначе мерцал бы)
  const off = bridge.onModsProgress((p) => {
    const text = p.phase === 'verify' ? 'Проверка…' : p.phase === 'download' && p.total ? `Скачано ${Math.floor((p.done / p.total) * 100)}%` : S.mods.installing[key];
    if (text === S.mods.installing[key]) return;
    S.mods.installing[key] = text;
    const tag = document.querySelector(`.mod-row[data-proj="${CSS.escape(id)}"] .mod-actions .tag`);
    if (tag) tag.textContent = text;
  });
  try {
    const r = await call('mods:install', pid, { source, projectId: id });
    if (r.applied) {
      markInstalled(r.plan);
      const deps = r.plan.changes.filter((c) => c.dependencyOf).map((c) => c.name);
      toast(`Установлено в «${profile(pid).name}»${deps.length ? `. Зависимости: ${deps.join(', ')}` : ''}`);
      missingWarning(r.missing);
      await refresh();
    } else planDialog(r.plan, 'Установка: нужно решение', { pid, request: { add: [{ source, projectId: id }] } });
  } catch (e) {
    errorDialog(e, 'Не удалось установить');
  } finally {
    off();
    delete S.mods.installing[key];
    if (S.view === 'mods') S.mods.project ? render() : paintResults();
  }
}

async function renderProject(main, targetBar) {
  const { source, id, all } = S.mods.project;
  const backLabel = S.mods.query ? `К результатам «${esc(S.mods.query)}»` : 'К каталогу';
  main.innerHTML = `<div class="page"><button class="btn btn-ghost" id="back" style="margin:-8px 0 12px -10px">${icon('back')}${backLabel}</button>${targetBar}<div id="proj">${skeletons(1, 90)}${skeletons(3, 40)}</div></div>`;
  const back = () => {
    S.mods.project = null;
    render();
  };
  // при возврате к списку анимации входа нет: список должен оказаться ровно там, где был
  $('#back').onclick = back;
  $('#mod-target').onchange = async (e) => {
    S.mods.target = e.target.value;
    S.mods.hits = null;
    await select(e.target.value);
    render();
  };
  let r;
  try {
    r = await call('catalog:project', source, id, S.mods.target, { allVersions: all });
  } catch (e) {
    $('#proj').innerHTML = `<div class="notice error">${esc(e.message)}</div>`;
    return;
  }
  if (!S.mods.project || S.mods.project.id !== id) return;
  const { project: p, versions, state } = r;
  const target = profile(S.mods.target);
  const busy = S.status.client && S.status.clientProfile === target.id;
  const stateTag = { install: '<span class="tag">Можно установить</span>', installed: '<span class="tag green">Установлен</span>', update: '<span class="tag warn">Есть обновление</span>', incompatible: '<span class="tag red">Несовместим</span>', manual: '<span class="tag warn">Файл вручную</span>' }[state.state];
  $('#proj').innerHTML = `<div class="project-head">${p.iconUrl ? `<img src="${esc(p.iconUrl)}" alt="">` : `<span class="mod-icon">${icon('mods')}</span>`}<div style="flex:1"><h1>${esc(p.name)}</h1><div class="row" style="margin-top:6px">${stateTag}<span class="tag">${esc(SOURCES[source])}</span><span class="tag">${esc(sideText(p.side))}</span>${p.author ? `<span class="hint" style="margin:0">${esc(p.author)}</span>` : ''}</div></div></div>
    <p style="font-size:15px">${esc(p.summary)}</p>${state.reason ? `<div class="notice">${esc(state.reason)}</div>` : ''}
    <div class="actions">${state.state === 'install' || state.state === 'manual' ? `<button class="btn btn-primary" id="p-install" ${busy ? 'disabled' : ''}>Установить в «${esc(target.name)}»</button>` : ''}${state.state === 'update' ? `<button class="btn btn-primary" id="p-update" ${busy ? 'disabled' : ''}>Обновить до ${esc(state.best.number)}</button>` : ''}<button class="btn btn-ghost" data-external="${esc(p.url)}">${icon('external')}Страница на ${esc(SOURCES[source])}</button></div>
    ${p.body ? `<h2 style="font-size:16px;margin:22px 0 8px">Описание</h2><div class="project-body">${esc(p.body)}</div>` : ''}
    <details class="more"><summary>Версии (${versions.length})</summary><label class="check"><input type="checkbox" id="all-v" ${all ? 'checked' : ''}><span>Показать все версии, включая несовместимые</span></label><div class="list">${versions.map((v) => `<div class="mod-row"><div class="mod-main"><div class="mod-name">${esc(v.number)}${v.type !== 'release' ? `<span class="tag warn">${esc(v.type === 'beta' ? 'бета' : v.type)}</span>` : ''}</div><div class="mod-sub">${esc((v.loaders || []).join(', '))} · Minecraft ${esc((v.minecraft || []).slice(0, 5).join(', '))}${v.deps.filter((x) => x.kind === 'required').length ? ` · зависимостей: ${v.deps.filter((x) => x.kind === 'required').length}` : ''}</div></div></div>`).join('') || '<p class="hint">Нет версий.</p>'}</div></details>`;
  hydrate($('#proj'));
  $('#all-v').onchange = (e) => {
    S.mods.project.all = e.target.checked;
    render();
  };
  if ($('#p-install')) $('#p-install').onclick = () => installMod(source, id);
  if ($('#p-update')) $('#p-update').onclick = () => openPlan(S.mods.target, { update: [p.key] }, 'Обновить ' + p.name);
}

// ---------- «Миры» ----------
async function renderWorlds(main) {
  if (!S.worlds.pid || !profile(S.worlds.pid)) S.worlds.pid = S.selected;
  const pid = S.worlds.pid;
  main.innerHTML = `<div class="page"><div class="page-head"><div class="grow"><h1>Миры</h1><p class="lead">Миры хранятся внутри своей сборки, поэтому их нельзя случайно открыть несовместимой версией игры.</p></div></div>
    <div class="target-bar"><span>Сборка</span><select class="input" id="w-build" aria-label="Сборка">${S.profiles.map((p) => `<option value="${esc(p.id)}" ${p.id === pid ? 'selected' : ''}>${esc(p.name)} — ${esc(buildLabel(p))}</option>`).join('')}</select></div><div id="w-grid">${skeletons(2, 120)}</div></div>`;
  $('#w-build').onchange = (e) => {
    S.worlds.pid = e.target.value;
    render();
  };
  const n = renderSeq;
  const list = await worldsOf(pid, true);
  if (S.view !== 'worlds' || S.worlds.pid !== pid || stale(n)) return;
  worldsGrid($('#w-grid'), pid, list);
}

function worldCover(w) {
  return w.cover?.file || w.icon || null;
}
function worldsGrid(el, pid, list) {
  const p = profile(pid);
  if (!list.length) {
    el.innerHTML = `<div class="empty"><h3>В этой сборке пока нет миров</h3><p>Миры создаются в самой игре: нажми «Играть» и выбери «Одиночная игра → Создать мир».<br>Мир для игры с друзьями можно создать в «С друзьями».</p><div class="actions"><button class="btn btn-primary" id="w-play">${icon('play')}Играть</button><button class="btn btn-secondary" data-go="friends">С друзьями</button></div></div>`;
    hydrate(el);
    $('#w-play').onclick = async () => {
      await select(pid);
      S.view = 'play';
      play(pid);
    };
    return;
  }
  el.innerHTML = `<div class="grid">${list
    .map((w) => {
      const c = worldCover(w);
      const flag = w.hosted ? '<span class="corner tag green">Открыт для друзей</span>' : w.playing ? '<span class="corner tag green">Сейчас в игре</span>' : w.damaged ? '<span class="corner tag red">level.dat не читается</span>' : '';
      return `<article class="card"><button class="card-cover ${c ? 'has-image' : ''}" ${bgStyle(c)} data-world="${esc(w.folder)}" aria-label="Мир ${esc(w.name)}: обложка и копии">${icon('globe')}${flag}</button><div class="card-body"><div class="card-title" title="${esc(w.name)}">${esc(w.name)}</div><div class="card-meta">${esc([MODES[w.gamemode], w.hardcore ? 'хардкор' : '', w.version ? 'версия ' + w.version : ''].filter(Boolean).join(' · '))}</div><div class="card-meta">${w.lastPlayed ? 'Играли ' + esc(date(w.lastPlayed)) : ''}</div><div class="card-actions"><button class="btn btn-primary btn-small" data-wplay="${esc(w.folder)}" ${S.busy || S.status.client || w.hosted || w.damaged ? 'disabled' : ''}>${icon('play')}Играть</button><span class="spacer"></span><button class="icon-button" data-world="${esc(w.folder)}" aria-label="Настройки мира ${esc(w.name)}">${icon('more')}</button></div></div></article>`;
    })
    .join('')}</div><p class="hint" style="margin-top:14px">«Играть» в мире откроет ${esc(p ? p.name : 'сборку')} и сразу войдёт в мир. Новые миры создаются в игре.</p>`;
  hydrate(el);
  $$('[data-wplay]', el).forEach(
    (b) =>
      (b.onclick = async () => {
        await select(pid);
        S.view = 'play';
        play(pid, b.dataset.wplay);
      }),
  );
  $$('[data-world]', el).forEach((b) => (b.onclick = () => worldDialog(pid, b.dataset.world)));
}

async function worldDialog(pid, folder) {
  const w = (await worldsOf(pid, true)).find((x) => x.folder === folder);
  if (!w) return toast('Мир не найден');
  const backups = await call('worlds:backups', pid, folder).catch(() => []);
  const c = worldCover(w);
  const coverText = w.cover ? (w.cover.source === 'manual' ? 'Выбрана вручную' : 'Последний скриншот, сделанный в этом мире') + (w.cover.pinned ? ' · закреплена' : ' · обновляется сама после игры') : w.icon ? 'Значок мира из игры' : 'Нет обложки';
  dialog(
    w.name,
    `<div class="detail-cover" style="width:100%;height:190px" ${bgStyle(c)}>${c ? '' : icon('globe')}</div><p class="hint">${esc(coverText)}</p>
    <div class="actions"><button class="btn btn-secondary btn-small" id="wc-pick">${icon('image')}Своя картинка</button><button class="btn btn-secondary btn-small" id="wc-shot">Из скриншотов сборки</button>${w.cover ? `<button class="btn btn-ghost btn-small" id="wc-pin">${w.cover.pinned ? 'Открепить' : 'Закрепить'}</button><button class="btn btn-ghost btn-small" id="wc-clear">Убрать</button>` : ''}</div>
    <p class="hint">Обложка из скриншота ставится сама, только если лаунчер точно знает, что снимок сделан в этом мире (по журналу игры, запущенной из easyLauncher).</p>
    <h3 style="margin-top:20px">Резервные копии</h3><div class="actions" style="margin-top:8px"><button class="btn btn-secondary btn-small" id="wb-now" ${w.playing ? 'disabled' : ''}>Сделать копию сейчас</button><button class="btn btn-ghost btn-small" id="wb-folder">${icon('folder')}Папка копий</button><button class="btn btn-ghost btn-small" id="w-folder">Папка мира</button></div>
    <div class="list" style="margin-top:10px">${backups.map((b) => `<div class="mod-row"><div class="mod-main"><div class="mod-name">${esc(b.reasonText)}</div><div class="mod-sub">${new Date(b.createdAt).toLocaleString('ru-RU')} · ${mb(b.size)}</div></div><button class="btn btn-ghost btn-small" data-restore="${esc(b.id)}" ${w.hosted || w.playing ? 'disabled' : ''}>Восстановить</button></div>`).join('') || '<p class="hint">Копий пока нет. Они делаются сами перед изменением сборки и удалением.</p>'}</div>
    <details class="more"><summary>Удалить мир</summary><p class="hint">Перед удалением лаунчер сохранит копию.</p><label class="field" for="wd-name">Для подтверждения введи название мира</label><input class="input" id="wd-name" placeholder="${esc(w.name)}"><div class="actions"><button class="btn btn-danger btn-small" id="wd-go" ${w.hosted || w.playing ? 'disabled' : ''}>Удалить мир</button></div></details>`,
    true,
  );
  const again = async () => {
    delete S.worldsCache[pid];
    await worldDialog(pid, folder);
    if (['worlds', 'builds', 'play'].includes(S.view)) render();
  };
  $('#wc-pick').onclick = async () => {
    if (await call('worlds:coverPick', pid, folder).catch(errorDialog)) again();
  };
  $('#wc-shot').onclick = () => shotPicker(pid, async (file) => {
    await call('worlds:coverShot', pid, folder, file);
    again();
  });
  if ($('#wc-pin')) $('#wc-pin').onclick = async () => (await call('worlds:coverPin', pid, folder, !w.cover.pinned), again());
  if ($('#wc-clear')) $('#wc-clear').onclick = async () => (await call('worlds:coverClear', pid, folder), again());
  $('#wb-now').onclick = async () => {
    try {
      await call('worlds:backup', pid, folder);
      toast('Копия сохранена');
      again();
    } catch (e) {
      toast(e.message);
    }
  };
  $('#wb-folder').onclick = () => call('open:folder', 'backups', pid, folder);
  $('#w-folder').onclick = () => call('open:folder', 'world', pid, folder);
  $$('[data-restore]').forEach(
    (b) =>
      (b.onclick = () => {
        dialog('Восстановить мир из копии?', '<p>Текущее состояние мира сначала тоже сохранится в копию — его можно будет вернуть.</p><div class="actions"><button class="btn btn-primary" id="rs-go">Восстановить</button><button class="btn btn-ghost" id="rs-no">Отмена</button></div>');
        $('#rs-no').onclick = () => worldDialog(pid, folder);
        $('#rs-go').onclick = async () => {
          try {
            await call('worlds:restore', pid, folder, b.dataset.restore);
            toast('Мир восстановлен');
            again();
          } catch (e) {
            errorDialog(e, 'Не удалось восстановить');
          }
        };
      }),
  );
  $('#wd-go').onclick = async () => {
    try {
      await call('worlds:delete', pid, folder, $('#wd-name').value);
      closeDialog();
      toast('Мир удалён, копия сохранена');
      delete S.worldsCache[pid];
      render();
    } catch (e) {
      toast(e.message);
    }
  };
}

// ---------- «С друзьями» ----------
// До 1.7.2 у Mojang нет сервера, который проверяет аккаунты Microsoft; окончательно решает ядро
function coopOk(mc) {
  if (/^(rd-|c0\.|in-|inf-|a\d|b\d)/.test(mc)) return false;
  const r = /^1\.(\d+)(?:\.(\d+))?/.exec(mc);
  if (r) return +r[1] > 7 || (+r[1] === 7 && +(r[2] || 0) >= 2);
  const w = /^(\d\d)w(\d\d)/.exec(mc);
  if (w) return +w[1] > 13 || (+w[1] === 13 && +w[2] >= 43);
  return true;
}

async function renderFriends(main) {
  if (sessionOn()) return renderSession(main);
  if (!S.friends.pid || !profile(S.friends.pid)) S.friends.pid = S.selected;
  const pid = S.friends.pid;
  const n = renderSeq;
  const worlds = (await worldsOf(pid)).filter((w) => !w.damaged);
  if (S.view !== 'friends' || sessionOn() || stale(n)) return;
  const p = profile(pid);
  const backend = !!S.settings.backend;
  const preparing = S.busy?.kind === 'coop';
  const oldMc = p && !coopOk(p.minecraft);
  if (S.friends.folder && S.friends.folder !== '__new' && !worlds.some((w) => w.folder === S.friends.folder)) S.friends.folder = '';
  const folder = S.friends.folder || (worlds[0]?.folder ?? '__new');
  main.innerHTML = `<div class="page"><div class="page-head"><div class="grow"><h1>С друзьями</h1><p class="lead">Ты открываешь мир на своём компьютере — друзья заходят по ссылке-приглашению.</p></div></div>
  <div class="two-col"><section class="panel"><h2>Позвать друзей</h2>
    <form id="host-form"><label class="field" for="h-build">Сборка</label><select class="input" id="h-build">${S.profiles.map((x) => `<option value="${esc(x.id)}" ${x.id === pid ? 'selected' : ''}>${esc(x.name)} — ${esc(buildLabel(x))}</option>`).join('')}</select>
    <label class="field" for="h-world">Мир</label><select class="input" id="h-world">${worlds.map((w) => `<option value="${esc(w.folder)}" ${w.folder === folder ? 'selected' : ''}>${esc(w.name)}${w.lastPlayed ? ' · ' + esc(date(w.lastPlayed)) : ''}</option>`).join('')}<option value="__new" ${folder === '__new' ? 'selected' : ''}>Новый мир…</option></select>
    <div id="new-world-fields" ${folder === '__new' ? '' : 'hidden'}><label class="field" for="h-name">Название нового мира</label><input class="input" id="h-name" maxlength="60" value="Мир с друзьями"><details class="more"><summary>Дополнительно</summary><div class="form-grid"><div><label class="field" for="h-mode">Режим</label><select class="input" id="h-mode"><option value="survival">Выживание</option><option value="creative">Творчество</option><option value="adventure">Приключение</option></select></div><div><label class="field" for="h-diff">Сложность</label><select class="input" id="h-diff"><option value="normal">Нормальная</option><option value="easy">Лёгкая</option><option value="hard">Сложная</option><option value="peaceful">Мирная</option></select></div></div><label class="field" for="h-seed">Seed (необязательно)</label><input class="input" id="h-seed" maxlength="64"><label class="check"><input type="checkbox" id="h-hc"><span>Хардкор</span></label></details></div>
    ${oldMc ? `<div class="notice"><strong>Minecraft ${esc(p.minecraft)} не подходит для игры с друзьями</strong>Сервер с проверкой аккаунтов Microsoft есть у Mojang только с версии 1.7.2. В одиночку эта сборка запускается как обычно. Для игры с друзьями выбери сборку новее или создай новую.<div class="actions"><button type="button" class="btn btn-secondary btn-small" data-act="create-build">Новая сборка</button></div></div>` : ''}
    ${S.settings.eula ? '' : `<label class="check"><input type="checkbox" id="h-eula"><span>Я принимаю <a href="#" data-external="https://aka.ms/MinecraftEULA">Minecraft EULA</a> — без этого сервер Minecraft не запускается</span></label>`}
    ${S.auth.account ? '' : '<div class="notice"><strong>Нужен вход через Microsoft</strong>Сервер проверяет аккаунты всех игроков и пускает только приглашённых.<div class="actions"><button type="button" class="btn btn-secondary btn-small" data-act="login">Войти</button></div></div>'}
    <div class="notice ${backend ? 'ok' : ''}">${backend ? 'Приглашение по ссылке: друзья подключатся напрямую или, если прямой путь закрыт роутером, через relay-сервер easyLauncher.' : '<strong>Сервер приглашений не настроен в этой сборке лаунчера</strong>Друзья смогут подключиться только из твоей локальной сети (дом, один Wi-Fi).'}</div>
    <div class="actions"><button class="btn btn-primary" type="submit" ${preparing || !S.auth.account || S.busy || oldMc ? 'disabled' : ''}>${icon('play')}Начать сессию</button>${preparing ? '<button type="button" class="btn btn-ghost" id="h-cancel">Отменить</button>' : ''}</div>
    ${preparing ? `<div class="launch-state" id="launch-state" style="background:var(--panel-2)">${progressHtml()}</div>` : ''}
    <p class="hint">Мир открывается сервером на этом компьютере: друзья могут играть, пока он включён и сессия идёт.${p?.loader !== 'vanilla' ? ' Друзьям не нужно собирать моды вручную — лаунчер поставит им ту же сборку.' : ''}</p></form></section>
  <section class="panel"><h2>Присоединиться</h2><p class="hint">Вставь ссылку-приглашение от друга. Обычно она открывается в easyLauncher сама.</p>
    <form id="join-form"><label class="field" for="join-link">Ссылка</label><input class="input" id="join-link" value="${esc(S.friends.link)}" placeholder="easylauncher://join?..." required><div class="actions"><button class="btn btn-secondary" type="submit">Проверить приглашение</button></div></form><div id="guest-flow"></div></section></div></div>`;
  $('#h-build').onchange = (e) => {
    S.friends.pid = e.target.value;
    S.friends.folder = '';
    render();
  };
  $('#h-world').onchange = (e) => {
    S.friends.folder = e.target.value;
    $('#new-world-fields').hidden = e.target.value !== '__new';
  };
  if ($('#h-cancel')) $('#h-cancel').onclick = () => call('mc:cancel');
  $('#host-form').onsubmit = (e) => {
    e.preventDefault();
    if (!S.settings.eula && !$('#h-eula').checked) return toast('Чтобы запустить сервер, отметь согласие с Minecraft EULA.');
    const f = $('#h-world').value;
    startCoop({ profileId: pid, folder: f === '__new' ? null : f, create: f === '__new' ? { name: $('#h-name').value.trim() || 'Мир с друзьями', seed: $('#h-seed').value.trim(), gamemode: $('#h-mode').value, difficulty: $('#h-diff').value, hardcore: $('#h-hc').checked } : null, eula: S.settings.eula || $('#h-eula').checked });
  };
  $('#join-form').onsubmit = (e) => {
    e.preventDefault();
    S.friends.link = $('#join-link').value.trim();
    guestCheck(S.friends.link);
  };
  if (S.guest?.info) paintGuest();
}

async function startCoop(req) {
  S.busy = { kind: 'coop', pid: req.profileId };
  S.stage = { label: 'Проверка' };
  render();
  try {
    const r = await call('coop:start', req);
    S.roomError = r.roomError || null;
    S.friends.folder = r.folder;
    S.worldsCache = {};
  } catch (e) {
    if (e.code !== 'CANCELLED') errorDialog(e, 'Сессия не запустилась');
  } finally {
    S.busy = null;
    S.stage = null;
    await refresh().catch(() => {});
    render();
  }
}

async function endCoop() {
  S.lastInvite = null;
  try {
    await call('coop:end');
  } catch (e) {
    toast(e.message);
  }
  await refresh().catch(() => {});
  render();
}

async function renderSession(main) {
  const st = S.status;
  const p = profile(st.serverProfile);
  const n = renderSeq;
  const worlds = st.serverProfile ? await worldsOf(st.serverProfile) : [];
  if (S.view !== 'friends' || stale(n)) return;
  // перерисовка (друг вошёл, состояние сервера) не должна стирать ссылку и недописанную команду
  const keepCmd = $('#console-in')?.value || '';
  const keepFocus = document.activeElement?.id === 'console-in';
  const w = worlds.find((x) => x.folder === st.serverFolder);
  const ready = st.server === 'running';
  const addr = '127.0.0.1:' + st.port;
  const guests = S.room?.guests || [];
  const guestStatus = (g) => ({ pending: 'ждёт подтверждения', accepted: g.routes?.length ? 'подключён ' + g.routes.map((r) => ROUTES[r] || r).join(', ') : 'принят, подключается', left: 'вышел', rejected: 'не принят', revoked: 'приглашение отозвано' })[g.status] || g.status;
  main.innerHTML = `<div class="page"><div class="page-head"><div class="grow"><h1>С друзьями</h1><p class="lead">Сессия: ${esc(w?.name || st.serverFolder || '')} · сборка «${esc(p?.name || '')}» (${esc(buildLabel(p))})</p></div><span class="tag ${ready ? 'green' : 'warn'}">${ready ? 'Сервер работает' : st.server === 'stopping' ? 'Сохраняем мир…' : 'Сервер запускается…'}</span></div>
  <div class="two-col"><section class="panel"><h2>Игроки</h2>
    <ul class="people">${st.players.length ? st.players.map((n) => `<li>${icon('avatar')}<span class="grow">${esc(n)}</span>${n === me() ? '<span class="tag">это ты</span>' : ''}</li>`).join('') : '<li><span class="grow">В мире пока никого нет</span></li>'}</ul>
    <p class="hint">Список — по журналу сервера: кто вошёл и вышел.</p>
    <div class="actions"><button class="btn btn-primary" id="s-play" ${!ready || S.status.client || S.busy ? 'disabled' : ''}>${icon('play')}${S.status.client ? 'Игра открыта' : 'Играть'}</button><button class="btn btn-secondary" id="s-end" ${st.server === 'stopping' ? 'disabled' : ''}>${icon('stop')}Сохранить мир и завершить</button></div>
    ${S.busy?.kind === 'play' ? `<div class="launch-state" id="launch-state" style="background:var(--panel-2)">${progressHtml()}</div>` : ''}
    <details class="more"><summary>Подробнее: адреса в локальной сети, консоль, журнал</summary><p class="hint">В той же сети друг может подключиться в Minecraft через «Сетевая игра → Прямое подключение», если ты добавишь его ник командой <code>whitelist add Ник</code>.</p>${st.addresses.map((a) => `<div class="addr"><div><code>${esc(a.address)}:${st.port}</code><small>${esc(a.name)}</small></div><button class="btn btn-ghost btn-small" data-copy="${esc(a.address + ':' + st.port)}">Копировать</button></div>`).join('') || '<p class="hint">Нет локальной сети.</p>'}<form class="toolbar" id="console" style="margin-top:10px"><input class="input" id="console-in" maxlength="200" placeholder="Команда сервера, например: op ${esc(me())}" style="flex:1"><button class="btn btn-secondary" type="submit">Отправить</button></form><button class="btn btn-ghost btn-small" data-log="server">Журнал сервера</button></details></section>
  <section class="panel"><h2>Приглашения</h2>${
    S.room
      ? `<p class="hint">Ссылка — это ключ: делись ею только с друзьями. Её можно отозвать.</p><div class="actions"><button class="btn btn-primary" id="inv-new" ${ready ? '' : 'disabled'}>${icon('link')}Создать ссылку</button></div><details class="more"><summary>Срок и ограничения</summary><div class="form-grid"><div><label class="field" for="inv-ttl">Срок действия</label><select class="input" id="inv-ttl"><option value="60">1 час</option><option value="1440" selected>1 день</option><option value="10080">7 дней</option></select></div><div><label class="field" for="inv-uses">Сколько человек</label><input class="input" id="inv-uses" type="number" min="1" max="20" value="4"></div></div><label class="field" for="inv-names">Только для ников (через запятую)</label><input class="input" id="inv-names" placeholder="Friend1, Friend2"></details><div id="inv-out"></div><div id="inv-list"></div>
        <h3 style="margin-top:18px;font-size:14.5px">Подключения</h3><ul class="people">${guests.length ? guests.map((g) => `<li><span class="grow"><b>${esc(g.name)}</b> — ${esc(guestStatus(g))}</span></li>`).join('') : '<li><span class="grow">Пока никто не подключался</span></li>'}</ul><p class="hint">Маршрут показывается по факту соединения. Прямой путь работает не во всех сетях — тогда используется relay.</p>`
      : `<div class="notice ${S.settings.backend ? 'error' : ''}">${S.settings.backend ? `<strong>Комната не открылась</strong>${esc(S.roomError || 'Сервер easyLauncher недоступен.')}<div class="actions"><button class="btn btn-secondary btn-small" id="room-retry">Повторить</button></div>` : '<strong>Приглашения через интернет недоступны</strong>Сервер приглашений не настроен в этой сборке лаунчера. Друзья из твоей локальной сети могут подключиться по адресу из «Подробнее».'}</div>`
  }</section></div></div>`;
  hydrate(main);
  if (S.lastInvite) $('#inv-out') && ($('#inv-out').innerHTML = inviteHtml(S.lastInvite));
  if (keepCmd) $('#console-in').value = keepCmd;
  if (keepFocus) $('#console-in').focus();
  $('#s-play').onclick = () => play(st.serverProfile, null, addr);
  $('#s-end').onclick = () => {
    dialog('Завершить сессию?', '<p>Сервер сохранит мир и остановится. Друзья отключатся, приглашения перестанут работать.</p><div class="actions"><button class="btn btn-primary" id="end-go">Сохранить и завершить</button><button class="btn btn-ghost" data-close>Отмена</button></div>');
    $('#end-go').onclick = () => {
      closeDialog();
      endCoop();
    };
  };
  $('#console').onsubmit = async (e) => {
    e.preventDefault();
    const v = $('#console-in').value.trim();
    if (!v) return;
    await call('server:command', v).then(() => toast('Команда отправлена'), (err) => toast(err.message));
    $('#console-in').value = '';
  };
  if ($('#room-retry'))
    $('#room-retry').onclick = async () => {
      try {
        S.room = await call('room:open');
        S.roomError = null;
      } catch (e) {
        S.roomError = e.message;
      }
      render();
    };
  if ($('#inv-new'))
    $('#inv-new').onclick = async () => {
      try {
        const names = $('#inv-names').value.split(',').map((s) => s.trim()).filter(Boolean);
        const inv = await call('room:invite', { ttlMinutes: Number($('#inv-ttl').value), maxUses: Number($('#inv-uses').value), allowedNames: names });
        S.lastInvite = inv;
        $('#inv-out').innerHTML = inviteHtml(inv);
        listInvites();
      } catch (e) {
        $('#inv-out').innerHTML = `<div class="notice error">${esc(e.message)}</div>`;
      }
    };
  if (S.room) listInvites();
}

const inviteHtml = (inv) => `<div class="addr"><div><code>${esc(inv.link)}</code><small>до ${new Date(inv.expiresAt).toLocaleString('ru-RU')} · до ${inv.maxUses} чел.</small></div><button class="btn btn-secondary btn-small" data-copy="${esc(inv.link)}">Копировать</button></div>`;

async function listInvites() {
  const list = await call('room:invites').catch(() => []);
  const el = $('#inv-list');
  if (!el) return;
  el.innerHTML = list.length
    ? `<div class="list" style="margin-top:10px">${list.map((i) => `<div class="mod-row"><div class="mod-main"><div class="mod-name">${i.revoked ? 'Отозвано' : i.expired ? 'Истекло' : 'Действует'}</div><div class="mod-sub">вошло ${i.uses} из ${i.maxUses} · до ${new Date(i.expiresAt).toLocaleString('ru-RU')}${i.allowedNames.length ? ' · ' + i.allowedNames.map(esc).join(', ') : ''}</div></div>${!i.revoked && !i.expired ? `<button class="btn btn-ghost btn-small" data-revoke="${esc(i.id)}">Отозвать</button>` : ''}</div>`).join('')}</div>`
    : '';
  $$('[data-revoke]', el).forEach(
    (b) =>
      (b.onclick = async () => {
        const names = await call('room:revoke', b.dataset.revoke).catch((e) => (toast(e.message), null));
        if (names) toast(names.length ? 'Отозвано, отключены: ' + names.join(', ') : 'Приглашение отозвано');
        listInvites();
      }),
  );
}

// гость
async function guestCheck(link) {
  const out = $('#guest-flow');
  if (out) out.innerHTML = '<p class="hint">Проверяем приглашение…</p>';
  try {
    if (!S.auth.account) throw Object.assign(new Error('Для подключения к другу нужен вход через Microsoft: сервер друга проверяет аккаунты.'), { code: 'AUTH_REQUIRED' });
    const info = await call('guest:open', link);
    S.guest = { info, stage: null };
  } catch (e) {
    S.guest = { error: e };
  }
  paintGuest();
}
function paintGuest() {
  const out = $('#guest-flow');
  if (!out || !S.guest) return;
  if (S.guest.error) {
    const e = S.guest.error;
    out.innerHTML = `<div class="notice error">${esc(e.message)}</div>${e.code === 'AUTH_REQUIRED' ? '<div class="actions"><button class="btn btn-secondary btn-small" data-act="login">Войти через Microsoft</button></div>' : ''}`;
    return;
  }
  const info = S.guest.info;
  if (S.guest.playing || S.guest.route) {
    out.innerHTML = `<div class="notice ok"><strong>Подключение к «${esc(info.room.name)}»</strong>${esc(GUEST_STAGE['route-' + S.guest.route] || '')}. Minecraft откроется и сразу зайдёт на сервер хозяина.</div><div class="actions"><button class="btn btn-secondary btn-small" id="g-leave">Отключиться</button><button class="btn btn-ghost btn-small" data-log="client">Журнал игры</button></div>`;
    $('#g-leave').onclick = async () => {
      await call('guest:leave');
      S.guest = null;
      $('#guest-flow').innerHTML = '';
      paintChrome();
    };
    return;
  }
  const total = info.required.reduce((a, m) => a + (m.size || 0), 0);
  out.innerHTML = `<div class="panel" style="background:var(--panel-2);margin-top:14px"><b>${esc(info.room.name)}</b><p class="hint" style="margin-top:2px">Хозяин ${esc(info.room.hostName)} · ${esc(LOADERS[info.loader])} ${esc(info.minecraft)}</p>${info.loader === 'vanilla' ? '<p style="margin-top:8px">Моды не нужны.</p>' : `<p style="margin-top:8px">Нужные моды: ${info.required.length} (${mb(total)})</p><ul class="plan-steps">${info.required.map((m) => `<li>${icon('mods')}<span>${esc(m.name)} <small>${esc(m.version)}${m.manual ? ' · файл вручную' : ''}</small></span></li>`).join('')}</ul>`}${info.optional.length ? `<details class="more"><summary>Необязательные моды хозяина (${info.optional.length})</summary>${info.optional.map((m) => `<label class="check"><input type="checkbox" data-opt="${esc(m.key)}"><span>${esc(m.name)} ${esc(m.version)}</span></label>`).join('')}</details>` : ''}<p class="hint">Сборка друга ставится отдельно — твои сборки не меняются. Файлы скачиваются с Modrinth/CurseForge с проверкой хешей, а не с компьютера хозяина.</p><div class="actions"><button class="btn btn-primary" id="g-go">Подготовить и присоединиться</button></div><p class="hint" id="guest-stage"></p></div>`;
  hydrate(out);
  $('#g-go').onclick = guestJoin;
}
async function guestJoin() {
  $('#g-go').disabled = true;
  const line = (t) => ($('#guest-stage') ? ($('#guest-stage').textContent = t) : 0);
  try {
    line('Сверяем сборку…');
    await call('guest:prepare', $$('[data-opt]').filter((c) => c.checked).map((c) => c.dataset.opt));
    line('Подготовка и подключение…');
    S.busy = { kind: 'guest' };
    paintChrome();
    const r = await call('guest:connect');
    S.guest.playing = true;
    S.guest.route = r.route;
  } catch (e) {
    line('');
    $('#guest-flow').insertAdjacentHTML('beforeend', `<div class="notice error">${esc(e.message)}</div>`);
    if ($('#g-go')) $('#g-go').disabled = false;
  } finally {
    S.busy = null;
    S.stage = null;
    paintChrome();
    paintGuest();
  }
}

// ---------- «Настройки» ----------
const ACCENTS = [['Лес', '#b9d38e'], ['Мята', '#7ee0c3'], ['Небо', '#8ec5ff'], ['Аметист', '#c4a5ff'], ['Розовый', '#ff9ecf'], ['Редстоун', '#ff7b72'], ['Закат', '#ffb27a'], ['Золото', '#f2d06b']];
/** Готовые темы: стиль оформления + подходящий цвет акцента (его можно поменять ниже). */
const STYLES = [
  ['glass', 'Жидкое стекло', 'Живой цветной фон, стеклянные панели', '#8ec5ff'],
  ['aurora', 'Аврора', 'Северное сияние и звёзды', '#7ee0c3'],
  ['neon', 'Неон', 'Светящиеся рамки и ретро-сетка', '#ff4fd8'],
  ['sunset', 'Закат', 'Тёплые переливы', '#ffb27a'],
  ['pixel', 'Пиксель', 'Камень и земля, как в Minecraft', '#7bc96f'],
  ['minimal', 'Минимализм', 'Строго и однотонно, без эффектов', '#b9d38e'],
];
const APPEAR_OPTS = [
  ['theme', 'Цветовая схема', '', [['dark', 'Тёмная'], ['slate', 'Графит'], ['oled', 'Чёрная'], ['light', 'Светлая']]],
  ['blur', 'Стекло', 'Прозрачное — фон виден насквозь; матовое — плотное и размытое, текст читается лучше', [['soft', 'Прозрачное'], ['normal', 'Обычное'], ['strong', 'Матовое']]],
  ['motion', 'Анимации', 'Полные — фон и сияние двигаются; сдержанные — фон стоит, остаются мягкие переходы; выкл. — всё неподвижно', [['full', 'Полные'], ['reduced', 'Сдержанные'], ['off', 'Выкл.']]],
  ['scale', 'Размер интерфейса', '', [[90, '90%'], [100, '100%'], [110, '110%'], [125, '125%']]],
  ['radius', 'Скругления', '', [['sharp', 'Острые'], ['normal', 'Обычные'], ['round', 'Круглые']]],
  ['font', 'Шрифт', '', [['system', 'Обычный'], ['rounded', 'Округлый'], ['minecraft', 'Пиксельный']]],
  ['sidebar', 'Боковая панель', '', [['full', 'С подписями'], ['compact', 'Только значки']]],
];
async function setAppearance(patch) {
  S.settings = await call('settings:set', { appearance: patch });
  applyAppearance(S.settings.appearance);
  const y = $('#main').scrollTop;
  await renderSettings($('#main'));
  $('#main').scrollTop = y;
}

async function renderSettings(main) {
  const s = S.settings;
  const ap = s.appearance || {};
  const acc = S.auth.account;
  const bgMode = s.background?.mode || 'default';
  main.innerHTML = `<div class="page"><div class="page-head"><div class="grow"><h1>Настройки</h1><p class="lead">Настройки конкретной сборки (память, версия, обложка) — в «Сборки» → сборка → «Настройки».</p></div></div>
  <div class="settings-cols"><div>
  <section class="panel"><h2>Аккаунт</h2>${
    acc
      ? `<p style="margin-top:8px"><b>${esc(acc.name)}</b> · аккаунт Microsoft</p><div class="actions"><button class="btn btn-secondary btn-small" id="logout">Выйти</button></div>`
      : `<p class="hint">Вход нужен для игры с лицензией Minecraft и для игры с друзьями.</p><div class="actions"><button class="btn btn-primary btn-small" data-act="login">${icon('lock')}Войти через Microsoft</button></div><form id="nick-form"><label class="field" for="nick">Ник для игры без входа</label><div class="row"><input class="input" id="nick" maxlength="16" pattern="[A-Za-z0-9_]{3,16}" required value="${esc(s.nickname)}" style="max-width:240px"><button class="btn btn-secondary btn-small" type="submit">Сохранить</button></div></form>`
  }</section>
  <section class="panel" id="appearance"><h2>Внешний вид</h2>
    <p class="hint">Тема — общий стиль оформления. Ниже можно подстроить цвет, схему и эффекты.</p>
    <div class="theme-gallery">${STYLES.map(([k, t, d]) => `<button class="theme-card" data-style="${k}" aria-pressed="${ap.style === k}"><div class="pv pv-${k}"></div><b>${t}</b><small>${d}</small></button>`).join('')}</div>
    <div class="option-row" style="margin-top:8px"><span>Цвет акцента<small>Кнопки, выделение, индикаторы</small></span></div>
    <div class="swatches">${ACCENTS.map(([n, c]) => `<button class="swatch" style="background:${c}" data-accent="${c}" aria-pressed="${ap.accent === c}" title="${n}" aria-label="${n}"></button>`).join('')}<label class="swatch swatch-custom" title="Свой цвет" aria-pressed="${!ACCENTS.some(([, c]) => c === ap.accent)}"><input type="color" id="accent-custom" value="${ap.accent}" aria-label="Свой цвет"></label></div>
    ${APPEAR_OPTS.map(([key, title, hint, opts]) => `<div class="option-row"><span>${title}${hint ? `<small>${hint}</small>` : ''}</span><div class="segmented" role="group" aria-label="${title}">${opts.map(([v, l]) => `<button data-ap="${key}" data-val="${v}" aria-pressed="${String(ap[key]) === String(v)}">${l}</button>`).join('')}</div></div>`).join('')}
    <div class="actions"><button class="btn btn-ghost btn-small" id="ap-reset">${icon('refresh')}Вернуть стандартный вид</button></div></section>
  <section class="panel"><h2>Фон главного экрана</h2><div class="segmented" role="group" style="margin-top:10px"><button data-bg="default" aria-pressed="${bgMode === 'default'}">Стандартный</button><button data-bg="custom" aria-pressed="${bgMode === 'custom'}">Своя картинка</button><button data-bg="profile" aria-pressed="${bgMode === 'profile'}">Обложка или скриншот сборки</button></div>
    <p class="hint">${bgMode === 'profile' ? 'Обложка выбранной сборки, а если её нет — последний скриншот из этой сборки. Без скриншотов — стандартный фон.' : bgMode === 'custom' ? 'Картинка копируется в папку лаунчера.' : 'Нейтральный фон. Лаунчер не подставляет случайные картинки.'}</p>
    ${bgMode === 'custom' ? '<div class="actions"><button class="btn btn-secondary btn-small" id="bg-pick">Выбрать другую картинку</button></div>' : ''}</section>
  <section class="panel"><h2>Память по умолчанию</h2><div class="form-grid"><div><label class="field" for="st-ram">Для игры</label>${ramField('st-ram', s.ram, { max: Math.max(2, (S.sys.totalRamGiB || 8) - 2), presets: [2, 4, 6, 8, 12] })}</div><div><label class="field" for="st-sram">Для сервера (с друзьями)</label>${ramField('st-sram', s.serverRam, { max: Math.max(1, (S.sys.totalRamGiB || 8) - 4), presets: [2, 3, 4, 6] })}</div></div><p class="hint">ОЗУ компьютера: ${S.sys.totalRamGiB || '?'} ГБ. Обычно хватает 4–6 ГБ; большим сборкам — 8–12. Слишком много памяти не ускоряет игру. У сборки может быть своё значение.</p></section>
</div>
  <div>${gameSettingsHtml(s)}
  ${launcherSettingsHtml(s)}
  ${javaSettingsHtml(s)}
  <section class="panel"><h2>Помощник</h2><p class="hint">Необязателен: игра, моды, миры и игра с друзьями работают без него.</p><div id="ai-box"><p class="hint">Проверяем…</p></div></section>
  <section class="panel"><h2>Хранилище</h2><p class="hint" id="st-storage">Считаем место…</p><div class="actions"><button class="btn btn-secondary btn-small" id="st-clean">${icon('trash')}Очистить неиспользуемые моды</button><button class="btn btn-ghost btn-small" id="root">${icon('folder')}Папка easyLauncher</button></div><p class="hint">Очистка удаляет из общего кэша файлы модов, которых нет ни в одной сборке и ни в одном прежнем составе (для отката). Миры и сборки не трогаются.</p></section>
  <section class="panel"><h2>О программе</h2><p class="hint">easyLauncher ${esc(S.sys.version || '')} · не связан с Mojang и Microsoft. Minecraft EULA: ${s.eula ? 'принята' : 'ещё не принята (спросим при первом запуске сервера)'}.</p><div class="actions"><button class="btn btn-ghost btn-small" id="st-logs">${icon('folder')}Журнал лаунчера</button></div><p class="hint">Если что-то не работает — пришли файл launcher.log из этой папки: в нём записаны ошибки.</p></section></div></div></div>`;
  hydrate(main);
  $$('.theme-card[data-style]').forEach((b) => (b.onclick = () => setAppearance({ style: b.dataset.style, accent: STYLES.find((x) => x[0] === b.dataset.style)[3], ...(b.dataset.style === 'pixel' ? { radius: 'sharp', font: 'minecraft' } : { radius: 'normal', font: 'system' }) })));
  $$('[data-accent]').forEach((b) => (b.onclick = () => setAppearance({ accent: b.dataset.accent })));
  $('#accent-custom').oninput = (e) => applyAppearance({ ...S.settings.appearance, accent: e.target.value });
  $('#accent-custom').onchange = (e) => setAppearance({ accent: e.target.value });
  $$('[data-ap]').forEach((b) => (b.onclick = () => setAppearance({ [b.dataset.ap]: b.dataset.ap === 'scale' ? Number(b.dataset.val) : b.dataset.val })));
  $('#ap-reset').onclick = () => setAppearance({ style: 'glass', blur: 'normal', theme: 'dark', motion: 'full', radius: 'normal', sidebar: 'full', font: 'system', accent: '#8ec5ff', scale: 100 });
  if ($('#logout'))
    $('#logout').onclick = async () => {
      S.auth = await call('auth:logout');
      render();
    };
  if ($('#nick-form'))
    $('#nick-form').onsubmit = async (e) => {
      e.preventDefault();
      try {
        S.settings = await call('settings:set', { nickname: $('#nick').value.trim() });
        toast('Ник сохранён');
        paintChrome();
      } catch (err) {
        toast(err.message);
      }
    };
  $$('[data-bg]').forEach(
    (b) =>
      (b.onclick = async () => {
        try {
          const r = await call('bg:set', b.dataset.bg);
          if (r) S.settings = r;
          S.background = await call('bg:for', S.selected);
          render();
        } catch (e) {
          toast(e.message);
        }
      }),
  );
  if ($('#bg-pick'))
    $('#bg-pick').onclick = async () => {
      const r = await call('bg:set', 'custom').catch((e) => toast(e.message));
      if (r) S.settings = r;
      S.background = await call('bg:for', S.selected);
    };
  wireExtraSettings();
  wireRam('st-ram', Math.max(2, (S.sys.totalRamGiB || 8) - 2), async (v) => ((S.settings = await call('settings:set', { ram: v })), toast(v ? `Память для игры: ${v} ГБ` : 'Память для игры: автоматически')));
  wireRam('st-sram', Math.max(1, (S.sys.totalRamGiB || 8) - 4), async (v) => ((S.settings = await call('settings:set', { serverRam: v })), toast(v ? `Память для сервера: ${v} ГБ` : 'Память для сервера: автоматически')));
  $('#root').onclick = () => call('open:folder', 'root');
  $('#st-logs').onclick = () => call('open:folder', 'logs');
  S.ai = await call('ai:status').catch(() => null);
  if ($('#ai-box')) {
    $('#ai-box').innerHTML = aiBox(S.ai);
    wireAiBox();
  }
}

// ---------- расширенные настройки: игра, лаунчер, Java, хранилище ----------
const segm = (name, cur, opts) => `<div class="segmented" role="group">${opts.map(([v, l]) => `<button type="button" data-set="${name}" data-val="${esc(v)}" aria-pressed="${String(cur) === String(v)}">${l}</button>`).join('')}</div>`;
const selectOpts = (id, cur, opts) => `<select class="input" id="${id}">${opts.map(([v, l]) => `<option value="${esc(v)}" ${String(cur ?? '') === String(v) ? 'selected' : ''}>${l}</option>`).join('')}</select>`;

function gameSettingsHtml(s) {
  const w = s.window || {};
  const mode = !s.window ? 'auto' : w.fullscreen ? 'full' : 'window';
  const o = s.options || {};
  const dist = [['', 'Как в игре'], ...[4, 6, 8, 10, 12, 16, 20, 24, 32].map((n) => [n, `${n} чанков`])];
  return `<section class="panel"><h2>Игра</h2>
    <div class="option-row"><span>Окно игры<small>Размер окна Minecraft при запуске</small></span>${segm('winmode', mode, [['auto', 'Как в игре'], ['full', 'Полный экран'], ['window', 'Своё окно']])}</div>
    ${mode === 'window' ? `<div class="row" style="margin:8px 0 0"><input class="input" id="st-w" type="number" min="640" max="7680" value="${w.width || 1280}" style="max-width:110px" aria-label="Ширина"><span class="hint" style="margin:0">×</span><input class="input" id="st-h" type="number" min="480" max="4320" value="${w.height || 720}" style="max-width:110px" aria-label="Высота"><button class="btn btn-secondary btn-small" id="st-wsave">Сохранить размер</button></div>` : ''}
    <h3 style="margin:18px 0 4px;font-size:14px">Графика по умолчанию</h3><p class="hint" style="margin-top:0">Применяется при запуске игры; то, что ты поменяешь в самой игре, тоже сохранится. «Как в игре» — не трогать.</p>
    <div class="form-grid"><div><label class="field" for="st-render">Дальность прорисовки</label>${selectOpts('st-render', o.render, dist)}</div><div><label class="field" for="st-sim">Дальность симуляции</label>${selectOpts('st-sim', o.simulation, dist.filter(([v]) => v === '' || v <= 16))}</div>
    <div><label class="field" for="st-fps">Ограничение FPS</label>${selectOpts('st-fps', o.fps, [['', 'Как в игре'], [30, '30'], [60, '60'], [120, '120'], [144, '144'], [240, '240'], [260, 'Без ограничения']])}</div><div><label class="field" for="st-gfx">Качество графики</label>${selectOpts('st-gfx', o.graphics, [['', 'Как в игре'], [0, 'Быстрая'], [1, 'Детальная'], [2, 'Великолепная']])}</div></div></section>`;
}

function launcherSettingsHtml(s) {
  return `<section class="panel"><h2>Лаунчер</h2>
    <div class="option-row"><span>Когда игра запущена<small>Что делать с окном лаунчера</small></span>${segm('afterLaunch', s.afterLaunch, [['keep', 'Оставить'], ['minimize', 'Свернуть'], ['hide', 'Спрятать до выхода']])}</div>
    <div class="option-row"><span>Новости Minecraft на главной</span>${segm('showNews', s.showNews, [[true, 'Показывать'], [false, 'Скрыть']])}</div>
    <div class="option-row"><span>Проверять обновления модов<small>На главной — сколько модов сборки можно обновить</small></span>${segm('checkUpdates', s.checkUpdates, [[true, 'Да'], [false, 'Нет']])}</div></section>`;
}

function javaSettingsHtml(s) {
  return `<section class="panel"><h2>Java</h2><p class="hint">Обычно ничего менять не нужно: лаунчер сам скачивает подходящую Java от Mojang для каждой версии игры.</p>
    <details class="more" ${s.javaPath || s.jvmArgs ? 'open' : ''}><summary>Для опытных игроков</summary>
    <label class="field">Своя Java</label><div class="row"><span class="hint" style="margin:0;flex:1;word-break:break-all">${s.javaPath ? esc(s.javaPath) : 'Автоматически (рекомендуется)'}</span><button class="btn btn-secondary btn-small" id="st-java">Выбрать файл…</button>${s.javaPath ? '<button class="btn btn-ghost btn-small" id="st-java-auto">Автоматически</button>' : ''}</div><p class="hint">Версия Java должна подходить игре: 1.20.5+ — Java 21, 1.17–1.20.4 — Java 17, старее — Java 8.</p>
    <label class="field" for="st-jvm">Аргументы Java</label><div class="row"><input class="input" id="st-jvm" value="${esc(s.jvmArgs)}" placeholder="например -XX:+UseZGC" style="flex:1"><button class="btn btn-secondary btn-small" id="st-jvm-save">Сохранить</button></div><p class="hint">Добавляются к стандартным. Память задаётся выше, не через -Xmx.</p></details></section>`;
}

/** Обработчики расширенных настроек (вызываются из renderSettings). */
function wireExtraSettings() {
  const save = async (patch, msg = 'Сохранено') => {
    try {
      S.settings = await call('settings:set', patch);
      toast(msg);
      const y = $('#main').scrollTop;
      await renderSettings($('#main'));
      $('#main').scrollTop = y;
    } catch (e) {
      toast(e.message);
    }
  };
  $$('[data-set]').forEach(
    (b) =>
      (b.onclick = () => {
        const k = b.dataset.set;
        const v = b.dataset.val;
        if (k === 'winmode') return save({ window: v === 'auto' ? null : v === 'full' ? { fullscreen: true } : { width: 1280, height: 720, fullscreen: false } });
        save({ [k]: v === 'true' ? true : v === 'false' ? false : v });
      }),
  );
  if ($('#st-wsave')) $('#st-wsave').onclick = () => save({ window: { width: Number($('#st-w').value), height: Number($('#st-h').value), fullscreen: false } }, 'Размер окна сохранён');
  const gfx = () => {
    const n = (id) => ($('#' + id).value === '' ? undefined : Number($('#' + id).value));
    const o = { render: n('st-render'), simulation: n('st-sim'), fps: n('st-fps'), graphics: n('st-gfx') };
    save({ options: Object.values(o).some((x) => x !== undefined) ? o : null }, 'Графика сохранена — применится при запуске игры');
  };
  ['st-render', 'st-sim', 'st-fps', 'st-gfx'].forEach((id) => ($('#' + id).onchange = gfx));
  $('#st-java').onclick = async () => {
    try {
      const r = await call('java:pick');
      if (r) save({}, 'Своя Java выбрана');
    } catch (e) {
      toast(e.message);
    }
  };
  if ($('#st-java-auto')) $('#st-java-auto').onclick = () => save({ javaPath: '' }, 'Java подбирается автоматически');
  $('#st-jvm-save').onclick = () => save({ jvmArgs: $('#st-jvm').value }, 'Аргументы Java сохранены');
  call('storage:info')
    .then((x) => $('#st-storage') && ($('#st-storage').textContent = `Файлы игры (версии, библиотеки, ресурсы, Java): ${mb(x.game)}. Кэш модов: ${mb(x.modCache)}.`))
    .catch(() => $('#st-storage') && ($('#st-storage').textContent = 'Не удалось посчитать место.'));
  $('#st-clean').onclick = async () => {
    $('#st-clean').disabled = true;
    try {
      const r = await call('storage:clean');
      toast(r.freed ? `Освобождено ${mb(r.freed)}` : 'Лишних файлов нет');
      save({}, r.freed ? `Освобождено ${mb(r.freed)}` : 'Лишних файлов нет');
    } catch (e) {
      toast(e.message);
      $('#st-clean').disabled = false;
    }
  };
}

/** Прогресс загрузки модели — для блока в «Настройках», где бы ни был игрок, пока она идёт. */
function aiProgressHtml(x) {
  const pct = x.total ? Math.floor((x.done / x.total) * 100) : 0;
  return `<p><b>Скачивается ${esc(x.label)}</b></p><p class="hint" id="ai-prog">${mb(x.done)} из ${mb(x.total)} (${pct}%)</p><div class="bar"><span id="ai-bar" style="width:${pct}%"></span></div><p class="hint">Можно переходить в другие разделы — загрузка продолжится. Файлы проверяются по SHA-256.</p>`;
}
// загрузка модели идёт в главном процессе; окно только показывает её ход
bridge.onAiProgress((x) => {
  S.aiInstall = x;
  const pct = x.total ? Math.floor((x.done / x.total) * 100) : 0;
  if ($('#ai-prog')) $('#ai-prog').textContent = `${mb(x.done)} из ${mb(x.total)} (${pct}%)`;
  if ($('#ai-bar')) $('#ai-bar').style.width = pct + '%';
});

function aiBox(ai) {
  if (!ai) return '<p class="hint">Состояние помощника недоступно.</p>';
  if (!ai.supported) return '<p>Для этой системы нет готового движка. Помощник работает по правилам: каталог, зависимости и известные ошибки.</p>';
  const inst = ai.installing || S.aiInstall;
  if (inst) return aiProgressHtml(inst);
  if (!ai.installed)
    return `<p>Сейчас помощник работает по правилам. Локальная модель лучше понимает свободные запросы. Её скачивают один раз; дальше она работает без интернета и без ключей.</p><label class="field" for="ai-model">Модель</label><select class="input" id="ai-model">${ai.models.map((m) => `<option value="${esc(m.id)}" ${m.id === aiPick(ai) ? 'selected' : ''}>${esc(m.label)}${m.note ? ' — ' + esc(m.note) : ''} · от ${m.ramGb} ГБ ОЗУ${ai.totalRamGb && ai.totalRamGb < m.ramGb ? ' (мало памяти)' : ''}${m.id === aiPick(ai) ? ' — рекомендуется' : ''}</option>`).join('')}</select><p class="hint">Модели на 4B (Qwen3 4B, Gemma 3 4B) отвечают заметно лучше, но весят около 2,5 ГБ и думают дольше. Модели меньше 1B быстрые, но хуже понимают русский.</p><div class="actions"><button class="btn btn-secondary btn-small" id="ai-size">Узнать размер и установить</button></div><div id="ai-out"></div><p class="hint">Модель загружается в память, только когда ты обращаешься к помощнику, и выгружается перед запуском игры.</p>`;
  return `${/0\.5B|0\.8B/.test(ai.model?.label || '') ? '<div class="notice">Установлена маленькая модель: она быстрая, но часто ошибается в русском. Для лучших ответов удали её и поставь Qwen2.5 1.5B.</div>' : ''}<p>Установлено: ${esc(ai.model?.label || '')} (${mb(ai.model?.size || 0)}), движок llama.cpp ${esc(ai.runtime?.tag || '')}.</p><p class="hint">${ai.running ? `Модель загружена: ${ai.rssMb} МБ ОЗУ.` : 'Модель сейчас не загружена и память не занимает.'}</p><div class="actions">${ai.running ? '<button class="btn btn-secondary btn-small" id="ai-unload">Выгрузить</button>' : ''}<button class="btn btn-ghost btn-small" id="ai-remove">Удалить модель</button></div>`;
}
function wireAiBox() {
  const reload = async () => {
    S.ai = await call('ai:status').catch(() => null);
    if ($('#ai-box')) {
      $('#ai-box').innerHTML = aiBox(S.ai);
      wireAiBox();
    }
  };
  if ($('#ai-size'))
    $('#ai-size').onclick = async () => {
      const out = $('#ai-out');
      $('#ai-size').disabled = true;
      out.innerHTML = '<p class="hint">Узнаём размер…</p>';
      try {
        const plan = await call('ai:plan', $('#ai-model').value);
        if (!$('#ai-out')) return;
        $('#ai-out').innerHTML = `<p>Будет скачано ${mb(plan.totalBytes)}: движок (${mb(plan.runtime.size)}) и модель ${esc(plan.model.file)} (${mb(plan.model.size)}). Файлы проверяются по SHA-256.</p>${plan.model.terms ? `<div class="notice">Модели Gemma распространяются по <a href="#" data-external="${esc(plan.model.terms)}">условиям использования Gemma</a> от Google (не Apache-2.0). Устанавливая модель, ты соглашаешься с ними.</div>` : ''}<div class="actions"><button class="btn btn-primary btn-small" id="ai-go">Скачать и установить</button></div>`;
        $('#ai-go').onclick = () => installAi(plan, reload);
      } catch (e) {
        if ($('#ai-out')) $('#ai-out').innerHTML = `<div class="notice error">${esc(e.message)}</div>`;
      } finally {
        if ($('#ai-size')) $('#ai-size').disabled = false;
      }
    };
  if ($('#ai-unload')) $('#ai-unload').onclick = async () => (await call('ai:unload'), reload());
  if ($('#ai-remove')) $('#ai-remove').onclick = async () => (await call('ai:uninstall'), reload());
}

/**
 * Загрузка модели: вызов живёт отдельно от отрисовки, поэтому переход в другой раздел её не сбивает.
 * Блок сразу переходит в «скачивается» — второй раз нажать «Скачать» нельзя (и ядро второй загрузки не начнёт).
 */
async function installAi(plan, reload) {
  if (S.aiInstall) return;
  S.aiInstall = { label: plan.model.label, done: 0, total: plan.totalBytes };
  if ($('#ai-box')) $('#ai-box').innerHTML = aiProgressHtml(S.aiInstall);
  try {
    await call('ai:install', plan);
    toast(`Модель ${plan.model.label} установлена — помощник стал умнее.`);
  } catch (e) {
    toast('Модель не установилась: ' + e.message);
  } finally {
    S.aiInstall = null;
    reload();
  }
}

/** Рекомендуемая модель: на компьютерах от 8 ГБ ОЗУ — Qwen3 4B (заметно лучше понимает русский), иначе лёгкая. */
function aiPick(ai) {
  if (ai.totalRamGb >= 8 && ai.models.some((m) => m.id === 'qwen3-4b')) return 'qwen3-4b';
  return ai.models.find((m) => m.default)?.id;
}

// ---------- вход ----------
function loginDialog() {
  if (S.auth.account) return go('settings');
  loginGate(() => render());
}
$('#account-chip').onclick = () => (S.auth.account ? go('settings') : loginDialog());

// ---------- журналы ----------
async function logDialog(source) {
  const text = source === 'server' ? await call('server:log') : await call('mc:clientLog');
  dialog(source === 'server' ? 'Журнал сервера' : 'Журнал игры', `<pre class="log-view" id="log-view">${esc(text || 'Пока пусто.')}</pre><div class="actions"><button class="btn btn-secondary btn-small" id="log-diag">Разобрать ошибки</button></div>`, true);
  const pre = $('#log-view');
  pre.scrollTop = pre.scrollHeight;
  $('#log-diag').onclick = () => {
    closeDialog();
    openAssistant();
    ask(pre.textContent);
  };
}

// ---------- помощник (отдельная панель; основные функции от него не зависят) ----------
function openAssistant() {
  S.assistant.open = true;
  $('#assistant-panel').hidden = false;
  $('#assistant-toggle').setAttribute('aria-expanded', 'true');
  assistantNote();
  paintFeed();
  $('#assistant-input').focus();
}
/** Подпись панели: чем понимает запросы и для какой сборки (после создания новой — уже для неё). */
function assistantNote() {
  call('ai:status')
    .then((ai) => {
      S.ai = ai;
      const p = sel();
      $('#assistant-note').textContent = `${ai?.installed ? 'Локальная модель установлена.' : 'Работает по правилам, без нейросети: модель можно установить в «Настройках».'} Без ключей; моды подбирает по каталогу Modrinth.${p ? ` Выбрана сборка «${p.name}»${p.loader === 'vanilla' ? ' без модов — для модов помощник соберёт новую' : ': моды поставит в неё или в новую сборку — спросит, куда'}.` : ''}`;
    })
    .catch(() => {});
}
function closeAssistant() {
  S.assistant.open = false;
  $('#assistant-panel').hidden = true;
  $('#assistant-toggle').setAttribute('aria-expanded', 'false');
}
$('#assistant-toggle').onclick = () => (S.assistant.open ? closeAssistant() : openAssistant());
$('#assistant-close').onclick = closeAssistant;

function paintFeed() {
  const feed = $('#assistant-feed');
  feed.innerHTML = S.assistant.feed.length ? S.assistant.feed.map((m, i) => (m.user ? `<div class="bubble user">${esc(m.text.length > 600 ? m.text.slice(0, 600) + '…' : m.text)}</div>` : `<div class="bubble" data-i="${i}">${m.html}</div>`)).join('') : '<p class="hint">Попроси собрать новую сборку («сделай сборку с зомби и оружием»), добавить моды, поднять FPS или вставь текст ошибки. Помощник покажет, что сделает, и сделает всё сам по одной кнопке.</p>';
  hydrate(feed);
  S.assistant.feed.forEach((m, i) => m.wire && m.wire($(`[data-i="${i}"]`, feed)));
  feed.scrollTop = feed.scrollHeight;
}
function pushAnswer(html, wire) {
  S.assistant.feed.push({ html, wire });
  paintFeed();
}

/** Запрос к помощнику. answers — ответы на уточняющие вопросы (тогда в ленте показывается их краткий итог). */
async function ask(text, answers = null, summary = '') {
  if (!text.trim()) return;
  const p = sel();
  if (!p) return toast('Сначала создай сборку.');
  S.assistant.feed.push({ user: true, text: answers ? summary : text });
  pushAnswer(`<p class="hint"><span class="spinner"></span>${answers ? 'Подбираю моды и проверяю совместимость… Обычно до минуты, у большой сборки — дольше.' : 'Думаю…'}</p>`);
  const pending = S.assistant.feed.length - 1;
  try {
    const r = await call('ai:ask', text, p.id, answers);
    S.assistant.feed.splice(pending, 1);
    renderAnswer(r, p);
  } catch (e) {
    S.assistant.feed.splice(pending, 1);
    pushAnswer(`<div class="notice error">${esc(e.message)}</div>`);
  }
}
/** Что сделает помощник: шаги задания (длинный список — свёрнут). */
function taskSteps(task) {
  const li = (s) => `<li>${icon('check')}<span>${esc(s)}</span></li>`;
  const head = task.steps.slice(0, 8);
  const rest = task.steps.slice(8);
  return `<ul class="plan-steps">${head.map(li).join('')}</ul>${rest.length ? `<details class="more"><summary>И ещё ${rest.length}</summary><ul class="plan-steps">${rest.map(li).join('')}</ul></details>` : ''}`;
}

/**
 * Кнопка задания помощника: выполняет всё одним вызовом ai:run (создание сборки, моды, память, графика)
 * и показывает прогресс загрузки. Состояние хранится в ответе r — лента перерисовывается целиком.
 */
function wireTask(el, r, label, done) {
  const box = $('[data-task]', el);
  if (!box) return;
  if (r.taskState === 'done') return (box.innerHTML = `<p class="hint">${icon('check')} Сделано</p>`);
  const btn = $('[data-a="run"]', box);
  if (r.taskState === 'running') btn.disabled = true;
  btn.onclick = async () => {
    r.taskState = 'running';
    btn.disabled = true;
    btn.textContent = 'Делаю…';
    const prog = () => {
      const bubble = $(`[data-i="${S.assistant.feed.findIndex((m) => m.r === r)}"]`);
      return bubble && $('[data-task] [data-progress]', bubble);
    };
    const off = bridge.onModsProgress((x) => {
      const pe = prog();
      if (pe) pe.innerHTML = `<p class="hint">${x.phase === 'verify' ? 'Проверка файлов…' : x.phase === 'done' ? 'Готово' : `Скачано ${mb(x.done)} из ${mb(x.total)}${x.name ? ' · ' + esc(x.name) : ''}`}</p><div class="bar"><span style="width:${x.total ? Math.floor((x.done / x.total) * 100) : 100}%"></span></div>`;
    });
    try {
      const res = await call('ai:run', r.task.id);
      r.taskState = 'done';
      S.worldsCache = {};
      await refresh();
      render();
      assistantNote();
      pushAnswer(`<p>${esc(done(res))}</p>`);
    } catch (e) {
      r.taskState = null;
      btn.disabled = false;
      btn.textContent = label;
      const pe = prog();
      if (pe) pe.innerHTML = `<div class="notice error">${esc(e.message)}${e.action ? ' ' + esc(e.action) : ''}</div>`;
    } finally {
      off();
    }
  };
}
const taskBox = (label, extra = '') => `<div data-task><div class="actions"><button class="btn btn-primary btn-small" data-a="run">${esc(label)}</button>${extra}</div><div data-progress></div></div>`;
const linksText = (res) => `${res.linksAdded?.length ? ` Проверил файлы модов и добавил нужное, о чём каталог не знал: ${res.linksAdded.join(', ')}.` : ''}${res.linksRemoved?.length ? ` Убрал моды, которым не нашлось обязательной библиотеки: ${res.linksRemoved.join(', ')}.` : ''}`;
const doneText = (res) => (res.created ? 'Готово! Сборка создана и выбрана — жми «Играть». Первый запуск скачает игру и загрузчик, это займёт несколько минут.' : `Готово, сборка обновлена.${res.backups?.length ? ` Перед изменением сделал копии миров: ${res.backups.length}.` : ''}`) + linksText(res);

function renderAnswer(r, p) {
  const by = `<p class="by">${r.understoodBy === 'model' ? 'Понял с помощью локальной модели' : 'Понял по правилам (без нейросети)'}${r.rejected ? ' · ответ модели отклонён проверкой' : ''}</p>`;
  const push = (html, wire) => {
    S.assistant.feed.push({ html, wire, r });
    paintFeed();
  };
  const dropped = r.dropped?.length ? `<p class="hint">Не прошли проверку совместимости и не будут поставлены: ${r.dropped.map(esc).join(', ')}.</p>` : '';
  const notFound = r.notFound?.length ? `<div class="notice">В каталоге нет: ${r.notFound.map(esc).join(', ')} — их нет в плане.</div>` : '';
  if (r.kind === 'clarify') {
    // ответы хранятся в самом ответе r: лента перерисовывается целиком, выбор не теряется
    r.answers ||= Object.fromEntries(r.questions.map((q) => [q.id, (q.options.find((o) => o.selected) || q.options[0]).value]));
    // «в текущую сборку» — вопросы про версию, загрузчик и размер новой сборки не нужны (и наоборот)
    const shown = () => r.questions.filter((q) => !q.only || q.only === r.answers.where);
    const html = () =>
      `<h3>Уточню пару вещей, чтобы сделать как надо</h3>${shown()
        .map((q) => `<div class="clarify-q"><b>${esc(q.title)}</b>${q.hint ? `<small>${esc(q.hint)}</small>` : ''}<div class="segmented" role="group" aria-label="${esc(q.title)}">${q.options.map((o, i) => `<button type="button" data-cq="${esc(q.id)}" data-ci="${i}" aria-pressed="${r.answers[q.id] === o.value}">${esc(o.label)}</button>`).join('')}</div></div>`)
        .join('')}<div class="actions"><button class="btn btn-primary btn-small" data-a="go" ${r.sent ? 'disabled' : ''}>${r.sent ? 'Ответы отправлены' : r.answers.where === 'current' ? 'Подобрать моды' : 'Подобрать'}</button></div>${by}`;
    const wire = (el) => {
      $$('[data-cq]', el).forEach(
        (b) =>
          (b.onclick = () => {
            if (r.sent) return;
            const q = r.questions.find((x) => x.id === b.dataset.cq);
            r.answers[q.id] = q.options[Number(b.dataset.ci)].value;
            if (q.id === 'where') {
              // другой набор вопросов: перерисовать этот ответ (и запомнить для перерисовки ленты)
              const entry = S.assistant.feed.find((m) => m.r === r);
              if (entry) entry.html = html();
              el.innerHTML = html();
              return wire(el);
            }
            $$(`[data-cq="${CSS.escape(q.id)}"]`, el).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
          }),
      );
      $('[data-a="go"]', el).onclick = () => {
        if (r.sent) return;
        r.sent = true;
        const sum = shown().map((q) => `${q.title}: ${q.options.find((o) => o.value === r.answers[q.id])?.label || ''}`).join(' · ');
        ask(r.text, r.answers, sum);
      };
    };
    return push(html(), wire);
  }
  if (r.kind === 'build') {
    const b = r.build;
    const groups = r.groups.map((g) => `<p><b>${esc(g.title)}:</b> ${g.names.map(esc).join(', ')}</p>`).join('');
    return push(
      `<h3>Новая сборка «${esc(b.name)}»</h3><p>Minecraft ${esc(b.minecraft)} · ${esc(LOADERS[b.loader] || b.loader)} · ${b.mods} ${plural(b.mods, 'мод', 'мода', 'модов')}${b.deps ? ` и ${b.deps} ${plural(b.deps, 'библиотека', 'библиотеки', 'библиотек')} для них` : ''}. Версию и загрузчик выбрал те, под которые есть больше всего нужных модов.</p>${groups}${notFound}${dropped}${r.note ? `<div class="notice">${esc(r.note)}</div>` : ''}<p><b>Что сделаю:</b></p>${taskSteps(r.task)}<details class="more"><summary>Весь список с версиями</summary>${planHtml(r.plan)}</details>${taskBox('Создать и установить')}${by}`,
      (el) => wireTask(el, r, 'Создать и установить', doneText),
    );
  }
  if (r.kind === 'plan') {
    return push(
      `<h3>Предлагаю для «${esc(p.name)}»</h3><p>${esc(r.explanation || '')}</p>${r.task ? taskSteps(r.task) : planHtml(r.plan)}${notFound}${dropped}${r.already?.length ? `<p class="hint">Уже в сборке: ${r.already.map(esc).join(', ')}.</p>` : ''}${r.note ? `<div class="notice">${esc(r.note)}</div>` : ''}${r.task ? taskBox('Сделать', '<button class="btn btn-ghost btn-small" data-a="apply">Подробнее</button>') : `<div class="actions"><button class="btn btn-primary btn-small" data-a="apply" ${r.plan.ok ? '' : 'disabled'}>Посмотреть и применить</button></div>`}${by}`,
      (el) => {
        if ($('[data-a="apply"]', el)) $('[data-a="apply"]', el).onclick = () => planDialog(r.plan, 'Изменения сборки', { pid: p.id, explanation: r.explanation });
        wireTask(el, r, 'Сделать', doneText);
      },
    );
  }
  if (r.kind === 'diagnose') {
    const f = r.findings || [];
    const fix = r.task ? `<p><b>Могу исправить сам:</b></p>${taskSteps(r.task)}${r.task.significant ? '<p class="hint">Перед изменением сделаю копии миров этой сборки.</p>' : ''}${taskBox('Исправить')}` : '';
    return push(`<h3>${f.length ? 'Нашёл, с чего начать' : 'Точную причину назвать не могу'}</h3>${f.map((x) => `<div class="notice ${x.level === 'error' ? 'error' : ''}"><strong>${esc(x.title)}</strong>${esc(x.fix)}</div>`).join('')}${r.guess ? `<div class="notice"><strong>${r.guess.confident ? 'Вероятная причина' : 'Предположение'}</strong>${esc(r.guess.text)}</div>` : ''}${r.needMore ? `<p>${esc(r.needMore)}</p>` : ''}${fix}${by}`, (el) =>
      wireTask(el, r, 'Исправить', () => 'Готово, исправил. Запусти игру ещё раз — если вылет повторится, пришли новый журнал.'),
    );
  }
  if (r.kind === 'optimize') {
    return push(`<h3>Настройки под твой ПК</h3>${taskSteps(r.task)}<p class="hint">${esc(r.note)}</p>${taskBox('Применить всё')}${by}`, (el) =>
      wireTask(el, r, 'Применить всё', () => 'Готово. Новые настройки применятся при следующем запуске игры.'),
    );
  }
  pushAnswer(`<p>${esc(r.message || '')}</p>${by}`);
}
$('#assistant-form').onsubmit = (e) => {
  e.preventDefault();
  const v = $('#assistant-input').value;
  $('#assistant-input').value = '';
  ask(v);
};
$('#assistant-input').onkeydown = (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    $('#assistant-form').requestSubmit();
  }
};
$$('[data-suggestion]').forEach((b) => (b.onclick = () => ask(b.dataset.suggestion)));
$('#assistant-log').onclick = () => $('#file-input').click();
$('#file-input').onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  if (f.size > 4 * 1024 * 1024) return toast('Файл больше 4 МБ — выбери latest.log или crash-report.');
  ask(await f.text());
};

// ---------- окно ----------
$$('[data-window]').forEach((b) => (b.onclick = () => call('win:' + b.dataset.window)));

// ---------- старт ----------
(async () => {
  hydrate();
  try {
    S.sys = await call('sys:info');
    S.auth = await call('auth:status');
    await call('profiles:first');
    await refresh();
    animateEnter();
    render();
  } catch (e) {
    $('#main').innerHTML = `<div class="page"><div class="notice error"><strong>Не удалось загрузить данные лаунчера</strong>${esc(e.message)}</div><div class="actions"><button class="btn btn-primary" id="boot-retry">Повторить</button><button class="btn btn-ghost" id="boot-logs">Журнал лаунчера</button></div></div>`;
    $('#boot-retry').onclick = () => location.reload();
    $('#boot-logs').onclick = () => call('open:folder', 'logs');
  }
  call('mc:versions')
    .then((v) => (S.versions = v))
    .catch(() => {});
})();
