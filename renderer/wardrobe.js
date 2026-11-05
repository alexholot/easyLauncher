'use strict';
// «Гардероб»: 3D-просмотр скина (skinview3d), анимации, слои, плащ и элитры, галерея своих образов.
// Скины из файлов читаются через ядро (skins:read) — WebGL не принимает картинки с протокола easyimg.
/* global call, esc, icon, toast, $, $$, S, hydrate, loginDialog, skinview3d, renderSeq, stale, dialog, closeDialog */
/* exported renderWardrobe, disposeWardrobe */

const WR = {
  viewer: null,
  items: [],
  active: null,
  account: null, // {name, skin:{file, model}, capes:[{id, alias, active, file}]}
  accountError: null,
  preview: null, // {kind:'item'|'account'|'default', id?, file?, model}
  anim: 'idle',
  speed: 1,
  paused: false,
  layers: { hat: true, jacket: true, sleeves: true, pants: true },
  back: 'cape', // 'none' | 'cape' | 'elytra'
  cape: null, // файл плаща для просмотра; null — плащ лаунчера (только просмотр)
  bitmaps: new Map(), // файл → canvas 64×N
  ro: null,
};
const ANIMS = [
  ['idle', 'Покой'],
  ['walk', 'Ходьба'],
  ['run', 'Бег'],
  ['fly', 'Полёт'],
];
const LAYERS = [
  ['hat', 'Шляпа'],
  ['jacket', 'Куртка'],
  ['sleeves', 'Рукава'],
  ['pants', 'Штаны'],
];

let skinLib = null;
/** Библиотека 3D подгружается только при открытии гардероба: остальному лаунчеру она не нужна. */
function loadSkinLib() {
  if (window.skinview3d) return Promise.resolve();
  return (skinLib ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'vendor/skinview3d.bundle.js';
    s.onload = resolve;
    s.onerror = () => {
      skinLib = null;
      reject(new Error('Не загрузился модуль 3D-просмотра.'));
    };
    document.head.appendChild(s);
  }));
}

/** Картинка из гардероба → canvas (не «испорченный»: из него можно читать пиксели и грузить в WebGL). */
async function skinCanvas(file) {
  if (WR.bitmaps.has(file)) return WR.bitmaps.get(file);
  const bytes = await call('skins:read', file);
  const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
  const c = document.createElement('canvas');
  c.width = bmp.width;
  c.height = bmp.height;
  c.getContext('2d').drawImage(bmp, 0, 0);
  WR.bitmaps.set(file, c);
  return c;
}

/** Свой стандартный образ лаунчера (не скин Mojang): нарисован по развёртке 64×64. */
function defaultSkin() {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const g = c.getContext('2d');
  const box = (x, y, w, h, col) => ((g.fillStyle = col), g.fillRect(x, y, w, h));
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#f2b25c';
  // голова: кожа, волосы сверху и по краям, глаза
  box(0, 0, 32, 16, '#c99872');
  box(8, 0, 8, 8, '#4a2f1d');
  box(0, 8, 32, 2, '#4a2f1d');
  box(24, 8, 8, 8, '#4a2f1d');
  box(9, 12, 2, 1, '#ffffff');
  box(10, 12, 1, 1, '#2d4a7a');
  box(13, 12, 2, 1, '#ffffff');
  box(13, 12, 1, 1, '#2d4a7a');
  box(11, 14, 2, 1, '#9c6b4e');
  // туловище и рукава — куртка цвета акцента, руки, штаны и ботинки
  box(16, 16, 24, 16, accent);
  box(20, 20, 8, 1, '#00000033');
  box(40, 16, 16, 16, accent);
  box(40, 28, 16, 4, '#c99872');
  box(32, 48, 16, 16, accent);
  box(32, 60, 16, 4, '#c99872');
  box(0, 16, 16, 16, '#3b4a6b');
  box(0, 28, 16, 4, '#2b2420');
  box(16, 48, 16, 16, '#3b4a6b');
  box(16, 60, 16, 4, '#2b2420');
  return c;
}

/** Плащ лаунчера — только для просмотра плаща и элитр, если у аккаунта своего нет. */
function defaultCape() {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 32;
  const g = c.getContext('2d');
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#f2b25c';
  g.fillStyle = accent;
  g.fillRect(0, 0, 64, 32);
  g.fillStyle = '#00000038';
  for (let y = 0; y < 32; y += 2) for (let x = (y / 2) % 2; x < 64; x += 2) g.fillRect(x, y, 1, 1);
  g.fillStyle = '#ffffff55';
  g.fillRect(1, 1, 10, 1);
  g.fillRect(12, 1, 10, 1);
  g.fillStyle = '#00000055';
  g.fillRect(4, 6, 4, 4);
  g.fillRect(15, 6, 4, 4);
  return c;
}

/** Тонкие руки (Alex): пиксель руки на развёртке прозрачен. Для старых 64×32 — всегда обычные. */
function guessModel(c) {
  if (c.height !== 64) return 'classic';
  return c.getContext('2d').getImageData(54, 20, 1, 1).data[3] === 0 ? 'slim' : 'classic';
}

/** Миниатюра «бумажная кукла»: вид спереди с внешним слоем, 16×32 пикселя. */
function paperDoll(src, model) {
  const c = document.createElement('canvas');
  c.width = 16;
  c.height = 32;
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = false;
  const old = src.height === 32;
  const aw = model === 'slim' ? 3 : 4;
  const part = (sx, sy, w, h, dx, dy, flip) => {
    if (!flip) return g.drawImage(src, sx, sy, w, h, dx, dy, w, h);
    g.save();
    g.translate(dx + w, dy);
    g.scale(-1, 1);
    g.drawImage(src, sx, sy, w, h, 0, 0, w, h);
    g.restore();
  };
  part(8, 8, 8, 8, 4, 0);
  part(20, 20, 8, 12, 4, 8);
  part(44, 20, aw, 12, 4 - aw, 8);
  if (old) part(44, 20, aw, 12, 12, 8, true);
  else part(36, 52, aw, 12, 12, 8);
  part(4, 20, 4, 12, 4, 20);
  if (old) part(4, 20, 4, 12, 8, 20, true);
  else part(20, 52, 4, 12, 8, 20);
  part(40, 8, 8, 8, 4, 0);
  if (!old) {
    part(20, 36, 8, 12, 4, 8);
    part(44, 36, aw, 12, 4 - aw, 8);
    part(52, 52, aw, 12, 12, 8);
    part(4, 36, 4, 12, 4, 20);
    part(4, 52, 4, 12, 8, 20);
  }
  return c;
}

function disposeWardrobe() {
  WR.ro?.disconnect();
  WR.ro = null;
  if (WR.viewer) {
    WR.viewer.dispose();
    WR.viewer = null;
  }
}

function makeAnim() {
  const L = window.skinview3d;
  const a = WR.anim === 'walk' ? new L.WalkingAnimation() : WR.anim === 'run' ? new L.RunningAnimation() : WR.anim === 'fly' ? new L.FlyingAnimation() : new L.IdleAnimation();
  a.speed = WR.speed;
  a.paused = WR.paused;
  return a;
}

function applyLayers() {
  const s = WR.viewer?.playerObject.skin;
  if (!s) return;
  s.head.outerLayer.visible = WR.layers.hat;
  s.body.outerLayer.visible = WR.layers.jacket;
  s.leftArm.outerLayer.visible = s.rightArm.outerLayer.visible = WR.layers.sleeves;
  s.leftLeg.outerLayer.visible = s.rightLeg.outerLayer.visible = WR.layers.pants;
}

async function applyBack() {
  const v = WR.viewer;
  if (!v) return;
  if (WR.back === 'none') return v.loadCape(null);
  const tex = WR.cape ? await skinCanvas(WR.cape).catch(() => defaultCape()) : defaultCape();
  v.loadCape(tex, { backEquipment: WR.back });
}

/** Показать в 3D выбранный образ (скин гардероба, скин аккаунта или стандартный). */
async function showPreview() {
  const v = WR.viewer;
  const p = WR.preview;
  if (!v || !p) return;
  try {
    const tex = p.file ? await skinCanvas(p.file) : defaultSkin();
    v.loadSkin(tex, { model: p.model === 'slim' ? 'slim' : 'default' });
  } catch (e) {
    toast('Скин не открылся: ' + e.message);
    v.loadSkin(defaultSkin(), { model: 'default' });
  }
  applyLayers();
  paintStageInfo();
}

function paintStageInfo() {
  const box = $('#wr-now');
  if (!box) return;
  const p = WR.preview || {};
  const it = p.kind === 'item' ? WR.items.find((x) => x.id === p.id) : null;
  const name = it ? it.name : p.kind === 'account' ? 'Скин аккаунта' : 'Стандартный образ лаунчера';
  const worn = it && WR.active === it.id;
  box.innerHTML = `<b>${esc(name)}</b><small>${p.model === 'slim' ? 'Тонкие руки (Alex)' : 'Обычные руки (Steve)'}${worn ? ' · надет' : ''}</small>`;
  $$('[data-wr-model]').forEach((b) => b.setAttribute('aria-pressed', String((p.model || 'classic') === b.dataset.wrModel)));
  const wear = $('#wr-wear');
  if (wear) {
    wear.disabled = !it || worn;
    wear.innerHTML = `${icon('check')}${worn ? 'Надет' : S.auth.account ? 'Надеть в игре' : 'Выбрать'}`;
  }
}

async function loadWardrobeData() {
  const r = await call('skins:list').catch(() => ({ items: [], active: null }));
  WR.items = r.items;
  WR.active = r.active;
  if (S.auth.account && !WR.account) {
    try {
      WR.account = await call('skins:account');
      WR.accountError = null;
    } catch (e) {
      WR.accountError = e.message;
    }
  }
  if (!S.auth.account) WR.account = null;
  if (!WR.preview) {
    const it = WR.items.find((x) => x.id === WR.active);
    if (it) WR.preview = { kind: 'item', id: it.id, file: it.file, model: it.model };
    else if (WR.account?.skin?.file) WR.preview = { kind: 'account', file: WR.account.skin.file, model: WR.account.skin.model };
    else WR.preview = { kind: 'default', model: 'classic' };
  }
  const activeCape = WR.account?.capes.find((c) => c.active) || WR.account?.capes[0];
  if (WR.cape === null && activeCape) WR.cape = activeCape.file;
}

async function renderWardrobe(main) {
  const n = renderSeq;
  if (!$('#wardrobe')) main.innerHTML = `<div class="page wardrobe"><div class="page-head"><div class="grow"><h1>Гардероб</h1><p class="lead">Покрути модель мышкой, приблизь колёсиком. Перетащи сюда файл скина .png — он сохранится в твоих образах.</p></div></div><div class="skeleton" style="height:520px"></div></div>`;
  await loadWardrobeData();
  if (S.view !== 'wardrobe' || stale(n)) return;
  const acc = S.auth.account;
  const capes = WR.account?.capes || [];
  main.innerHTML = `<div class="page wardrobe" id="wardrobe">
    <div class="page-head"><div class="grow"><h1>Гардероб</h1><p class="lead">Покрути модель мышкой, приблизь колёсиком. Перетащи сюда файл скина .png — он сохранится в твоих образах.</p></div></div>
    <div class="wr-grid">
      <section class="panel wr-stage-panel">
        <div class="wr-stage" id="wr-stage"><canvas id="wr-canvas" aria-label="3D-модель скина"></canvas><div class="wr-now" id="wr-now"></div><div class="wr-drop-hint">${icon('upload')}<span>Отпусти, чтобы добавить скин</span></div></div>
        <div class="wr-controls">
          <div class="segmented" role="group" aria-label="Анимация">${ANIMS.map(([k, l]) => `<button data-wr-anim="${k}" aria-pressed="${WR.anim === k}">${l}</button>`).join('')}</div>
          <div class="wr-speed"><button class="icon-button" id="wr-pause" aria-label="${WR.paused ? 'Продолжить' : 'Пауза'}" title="${WR.paused ? 'Продолжить' : 'Пауза'}">${icon(WR.paused ? 'play' : 'pause')}</button><label class="sr-only" for="wr-speed">Скорость анимации</label><input type="range" id="wr-speed" min="0.25" max="2" step="0.25" value="${WR.speed}"><span class="tag pixel-tag" id="wr-speed-v">×${WR.speed}</span></div>
        </div>
        <div class="wr-controls">
          <div class="wr-checks" role="group" aria-label="Второй слой скина">${LAYERS.map(([k, l]) => `<label class="pill-check"><input type="checkbox" data-wr-layer="${k}" ${WR.layers[k] ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div>
          <div class="segmented" role="group" aria-label="На спине">${[['none', 'Ничего'], ['cape', 'Плащ'], ['elytra', 'Элитры']].map(([k, l]) => `<button data-wr-back="${k}" aria-pressed="${WR.back === k}">${l}</button>`).join('')}</div>
        </div>
        <div class="wr-controls">
          <div class="segmented" role="group" aria-label="Модель рук"><button data-wr-model="classic">Steve · 4 px</button><button data-wr-model="slim">Alex · 3 px</button></div>
          <button class="btn btn-primary" id="wr-wear">${icon('check')}Надеть</button>
        </div>
      </section>
      <div class="wr-side">
        <section class="panel wr-drop" id="wr-drop" tabindex="0" role="button" aria-label="Добавить скин из файла">
          <span class="wr-drop-ic">${icon('upload')}</span><span><b>Новый образ</b><small>Перетащи .png 64×64 или нажми, чтобы выбрать файл</small></span>
        </section>
        <section class="panel"><div class="sec-head"><h2>Мои образы</h2><span class="tag pixel-tag">${WR.items.length}</span></div>
          ${WR.items.length ? `<div class="wr-gallery" id="wr-gallery">${WR.items
            .slice()
            .sort((a, b) => Number(!!b.favorite) - Number(!!a.favorite))
            .map((x) => `<div class="wr-item ${WR.preview?.id === x.id ? 'current' : ''} ${WR.active === x.id ? 'worn' : ''}" data-wr-item="${esc(x.id)}"><button class="wr-doll" data-wr-show="${esc(x.id)}" title="Показать «${esc(x.name)}»"><canvas width="16" height="32" data-doll="${esc(x.id)}"></canvas></button><span class="wr-name" title="${esc(x.name)}">${x.favorite ? '★ ' : ''}${esc(x.name)}</span><span class="wr-item-acts"><button class="icon-button" data-wr-fav="${esc(x.id)}" aria-label="${x.favorite ? 'Убрать из избранного' : 'В избранное'}" title="${x.favorite ? 'Убрать из избранного' : 'В избранное'}">${x.favorite ? '★' : '☆'}</button><button class="icon-button" data-wr-del="${esc(x.id)}" aria-label="Удалить «${esc(x.name)}»" title="Удалить">${icon('trash')}</button></span></div>`)
            .join('')}</div>` : '<p class="hint">Пока пусто. Добавь первый скин — файл .png можно скачать на сайтах скинов или нарисовать самому.</p>'}
        </section>
        <section class="panel"><h2>Аккаунт</h2>${
          acc
            ? `${WR.accountError ? `<div class="notice warn">${esc(WR.accountError)}</div>` : ''}${WR.account?.skin?.file ? `<div class="wr-acc"><button class="wr-doll small" data-wr-acc title="Показать скин аккаунта"><canvas width="16" height="32" data-doll="account"></canvas></button><span><b>${esc(acc.name)}</b><small>Скин, который сейчас видят в игре</small></span><button class="btn btn-ghost btn-small" id="wr-acc-save">${icon('download')}В мои образы</button></div>` : '<p class="hint">Скин аккаунта не загрузился.</p>'}
              ${capes.length ? `<label class="field" for="wr-cape">Плащ</label><select class="input" id="wr-cape"><option value="">Без плаща</option>${capes.map((c) => `<option value="${esc(c.id)}" ${c.active ? 'selected' : ''}>${esc(c.alias)}</option>`).join('')}</select><p class="hint">Смена плаща сразу применяется к аккаунту Minecraft.</p>` : '<p class="hint">Плащей у аккаунта нет — в просмотре показан плащ лаунчера (в игре его не будет).</p>'}`
            : `<p class="hint">Без входа в Microsoft скин выбирается только в лаунчере: в игре без входа виден стандартный скин. Чтобы скин видели все, войди — «Надеть» загрузит его в профиль Minecraft.</p><div class="actions"><button class="btn btn-secondary btn-small" data-act="login">${icon('lock')}Войти через Microsoft</button></div>`
        }</section>
      </div>
    </div></div>`;
  hydrate(main);
  wireWardrobe();
  paintDolls();
  try {
    await loadSkinLib();
  } catch (e) {
    $('#wr-stage').insertAdjacentHTML('beforeend', `<div class="notice error">${esc(e.message)}</div>`);
    return;
  }
  if (S.view !== 'wardrobe' || stale(n) || !$('#wr-canvas')) return;
  disposeWardrobe();
  const stage = $('#wr-stage');
  WR.viewer = new skinview3d.SkinViewer({ canvas: $('#wr-canvas'), width: stage.clientWidth, height: stage.clientHeight, zoom: 0.82, fov: 50 });
  WR.viewer.controls.enablePan = false;
  WR.viewer.controls.minDistance = 22;
  WR.viewer.controls.maxDistance = 90;
  WR.viewer.animation = makeAnim();
  WR.viewer.playerWrapper.rotation.y = -0.45; // чуть боком — объём виден сразу
  WR.ro = new ResizeObserver(() => WR.viewer && WR.viewer.setSize(stage.clientWidth, stage.clientHeight));
  WR.ro.observe(stage);
  await showPreview();
  await applyBack();
}

async function paintDolls() {
  for (const cv of $$('canvas[data-doll]')) {
    const id = cv.dataset.doll;
    const file = id === 'account' ? WR.account?.skin?.file : WR.items.find((x) => x.id === id)?.file;
    const model = id === 'account' ? WR.account?.skin?.model : WR.items.find((x) => x.id === id)?.model;
    if (!file) continue;
    try {
      const src = await skinCanvas(file);
      const g = cv.getContext('2d');
      g.imageSmoothingEnabled = false;
      g.clearRect(0, 0, 16, 32);
      g.drawImage(paperDoll(src, model), 0, 0);
    } catch {}
  }
}

async function addSkinBytes(name, bytes) {
  const blob = new Blob([bytes], { type: 'image/png' });
  let model = 'classic';
  try {
    const bmp = await createImageBitmap(blob);
    const c = document.createElement('canvas');
    c.width = bmp.width;
    c.height = bmp.height;
    c.getContext('2d').drawImage(bmp, 0, 0);
    model = guessModel(c);
  } catch {}
  const it = await call('skins:add', { name, model, bytes });
  WR.preview = { kind: 'item', id: it.id, file: it.file, model: it.model };
  toast(it.duplicate ? `Этот скин уже есть: «${it.name}»` : `Добавлен образ «${it.name}»`);
}

function wireWardrobe() {
  const page = $('#wardrobe');
  $$('[data-wr-anim]').forEach(
    (b) =>
      (b.onclick = () => {
        WR.anim = b.dataset.wrAnim;
        // полёт выглядит как полёт только с элитрами
        if (WR.anim === 'fly' && WR.back !== 'elytra') {
          WR.back = 'elytra';
          $$('[data-wr-back]').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.wrBack === 'elytra')));
          applyBack();
        }
        $$('[data-wr-anim]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
        if (WR.viewer) WR.viewer.animation = makeAnim();
      }),
  );
  $('#wr-pause').onclick = () => {
    WR.paused = !WR.paused;
    if (WR.viewer?.animation) WR.viewer.animation.paused = WR.paused;
    $('#wr-pause').innerHTML = icon(WR.paused ? 'play' : 'pause');
    $('#wr-pause').setAttribute('aria-label', WR.paused ? 'Продолжить' : 'Пауза');
  };
  $('#wr-speed').oninput = (e) => {
    WR.speed = Number(e.target.value);
    $('#wr-speed-v').textContent = '×' + WR.speed;
    if (WR.viewer?.animation) WR.viewer.animation.speed = WR.speed;
  };
  $$('[data-wr-layer]').forEach(
    (c) =>
      (c.onchange = () => {
        WR.layers[c.dataset.wrLayer] = c.checked;
        applyLayers();
      }),
  );
  $$('[data-wr-back]').forEach(
    (b) =>
      (b.onclick = () => {
        WR.back = b.dataset.wrBack;
        $$('[data-wr-back]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
        applyBack();
      }),
  );
  $$('[data-wr-model]').forEach(
    (b) =>
      (b.onclick = async () => {
        const model = b.dataset.wrModel;
        WR.preview = { ...(WR.preview || { kind: 'default' }), model };
        // у образа из гардероба модель запоминается
        if (WR.preview.kind === 'item') {
          await call('skins:update', WR.preview.id, { model }).catch((e) => toast(e.message));
          const it = WR.items.find((x) => x.id === WR.preview.id);
          if (it) it.model = model;
        }
        showPreview();
      }),
  );
  $('#wr-wear').onclick = async () => {
    const p = WR.preview;
    if (p?.kind !== 'item') return;
    $('#wr-wear').disabled = true;
    try {
      const r = await call('skins:apply', p.id);
      WR.active = p.id;
      WR.account = null; // скин аккаунта поменялся — перечитаем
      toast(r.uploaded ? 'Скин загружен в профиль Minecraft — его увидят на серверах.' : 'Образ выбран. В игре без входа в Microsoft виден стандартный скин.');
      renderWardrobe($('#main'));
    } catch (e) {
      if (e.code === 'AUTH_REQUIRED') loginDialog();
      else toast(e.message);
      if ($('#wr-wear')) $('#wr-wear').disabled = false;
    }
  };
  $$('[data-wr-show]').forEach(
    (b) =>
      (b.onclick = () => {
        const it = WR.items.find((x) => x.id === b.dataset.wrShow);
        if (!it) return;
        WR.preview = { kind: 'item', id: it.id, file: it.file, model: it.model };
        $$('.wr-item').forEach((x) => x.classList.toggle('current', x.dataset.wrItem === it.id));
        showPreview();
      }),
  );
  $$('[data-wr-fav]').forEach(
    (b) =>
      (b.onclick = async () => {
        const it = WR.items.find((x) => x.id === b.dataset.wrFav);
        await call('skins:update', it.id, { favorite: !it.favorite }).catch((e) => toast(e.message));
        renderWardrobe($('#main'));
      }),
  );
  $$('[data-wr-del]').forEach(
    (b) =>
      (b.onclick = async () => {
        const it = WR.items.find((x) => x.id === b.dataset.wrDel);
        if (!it) return;
        dialog('Удалить образ?', `<p>«${esc(it.name)}» пропадёт из гардероба. Скин в профиле Minecraft не изменится.</p><div class="actions"><button class="btn btn-danger" id="wr-del-ok">${icon('trash')}Удалить</button><button class="btn btn-ghost" data-close>Отмена</button></div>`);
        $('#wr-del-ok').onclick = async () => {
          closeDialog();
          await call('skins:remove', it.id).catch((e) => toast(e.message));
          WR.bitmaps.delete(it.file);
          if (WR.preview?.id === it.id) WR.preview = null;
          renderWardrobe($('#main'));
        };
      }),
  );
  if ($('[data-wr-acc]'))
    $('[data-wr-acc]').onclick = () => {
      WR.preview = { kind: 'account', file: WR.account.skin.file, model: WR.account.skin.model };
      $$('.wr-item').forEach((x) => x.classList.remove('current'));
      showPreview();
    };
  if ($('#wr-acc-save'))
    $('#wr-acc-save').onclick = async () => {
      try {
        const bytes = await call('skins:read', WR.account.skin.file);
        await addSkinBytes(`Скин ${S.auth.account?.name || 'аккаунта'}`, bytes);
        renderWardrobe($('#main'));
      } catch (e) {
        toast(e.message);
      }
    };
  if ($('#wr-cape'))
    $('#wr-cape').onchange = async (e) => {
      const id = e.target.value || null;
      try {
        await call('skins:cape', id);
        const c = WR.account.capes.find((x) => x.id === id);
        WR.account.capes.forEach((x) => (x.active = x.id === id));
        WR.cape = c?.file || null;
        if (!c) WR.back = 'none';
        applyBack();
        toast(c ? `Плащ «${c.alias}» надет` : 'Плащ снят');
      } catch (err) {
        toast(err.message);
      }
    };
  const pick = async () => {
    try {
      const it = await call('skins:pick');
      if (!it) return;
      WR.preview = { kind: 'item', id: it.id, file: it.file, model: it.model };
      toast(it.duplicate ? `Этот скин уже есть: «${it.name}»` : `Добавлен образ «${it.name}»`);
      renderWardrobe($('#main'));
    } catch (e) {
      toast(e.message);
    }
  };
  $('#wr-drop').onclick = pick;
  $('#wr-drop').onkeydown = (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), pick());
  // перетаскивание файла на любое место гардероба
  let depth = 0;
  page.addEventListener('dragenter', (e) => {
    e.preventDefault();
    depth++;
    page.classList.add('dragging');
  });
  page.addEventListener('dragleave', () => {
    if (--depth <= 0) page.classList.remove('dragging');
  });
  page.addEventListener('dragover', (e) => e.preventDefault());
  page.addEventListener('drop', async (e) => {
    e.preventDefault();
    depth = 0;
    page.classList.remove('dragging');
    const f = [...(e.dataTransfer?.files || [])].find((x) => /\.png$/i.test(x.name));
    if (!f) return toast('Скин — файл .png.');
    if (f.size > 512 * 1024) return toast('Файл скина больше 512 КБ.');
    try {
      await addSkinBytes(f.name, new Uint8Array(await f.arrayBuffer()));
      renderWardrobe($('#main'));
    } catch (err) {
      toast(err.message);
    }
  });
}
