'use strict';
// Схема зависимостей мода: блоки по колонкам, линии между ними (SVG под блоками).
// Слева — кому нужен мод, в центре — он сам, справа — что нужно ему, дальше — по цепочке.
const MG = { pid: null, history: [], data: null, sel: null, token: 0 };
const MG_W = 224;
const MG_H = 62;
const MG_GX = 104;
const MG_GY = 16;
const MG_PAD = 30;
const MG_HEAD = 34;
const MG_KIND = { required: 'обязательная', optional: 'необязательная', embedded: 'встроена в мод', incompatible: 'несовместим (так указал автор мода)' };
const MG_RANK = { required: 0, embedded: 1, optional: 2, incompatible: 3 };

const mgName = (n) => n.name || `${n.source === 'curseforge' ? 'CurseForge' : 'Modrinth'} · ${n.projectId || '?'}`;
const mgLetter = (n) => esc(String(n.name || '?').slice(0, 1).toUpperCase());

/** Открыть схему зависимостей мода сборки pid. */
function openModGraph(pid, key) {
  MG.pid = pid;
  MG.history = [];
  MG.sel = null;
  dialog('Зависимости мода', `<div class="mg" id="mg"><div class="mg-stage mg-loading"><div class="skeleton" style="height:100%"></div></div></div>`, 'xl');
  mgLoad(key);
}

async function mgLoad(key) {
  const token = ++MG.token;
  let data;
  try {
    data = await call('mods:graph', MG.pid, key);
  } catch (e) {
    if (token !== MG.token || !$('#mg')) return;
    $('#mg').innerHTML = `<div class="notice error">${esc(e.message || 'Не удалось построить схему.')}</div>`;
    return;
  }
  // окно уже закрыли или открыли схему другого мода
  if (token !== MG.token || !$('#mg') || $('#overlay').hidden) return;
  MG.data = data;
  MG.sel = key;
  mgRender();
}

function mgLayout(d) {
  const byKey = new Map(d.nodes.map((n) => [n.key, n]));
  const levels = [...new Set(d.nodes.map((n) => n.level))].sort((a, b) => a - b);
  const pos = new Map(); // key → номер в колонке
  const cols = new Map();
  const incoming = (n) => d.edges.filter((e) => e.to === n.key && byKey.get(e.from)?.level === n.level - 1);
  for (const L of levels) {
    const list = d.nodes.filter((n) => n.level === L);
    const score = (n) => {
      const inc = incoming(n);
      const bc = inc.length ? inc.reduce((s, e) => s + (pos.get(e.from) ?? 0), 0) / inc.length : 1e6;
      const rank = Math.min(...(L < 0 ? [0] : inc.map((e) => MG_RANK[e.kind] ?? 4)), 4);
      return [bc, rank];
    };
    // слева (кому нужен) — по алфавиту; справа — под своими «родителями», обязательные выше
    list.sort((a, b) => {
      if (L > 0) {
        const [ba, ra] = score(a);
        const [bb, rb] = score(b);
        if (ba !== bb) return ba - bb;
        if (ra !== rb) return ra - rb;
      }
      if (a.installed !== b.installed) return a.installed ? -1 : 1;
      return mgName(a).localeCompare(mgName(b), 'ru');
    });
    list.forEach((n, i) => pos.set(n.key, i));
    cols.set(L, list);
  }
  // колонки «кому нужен», сам мод и прямые связи — по центру; дальше каждый блок — напротив своих «родителей»
  const step = MG_H + MG_GY;
  const maxRows = Math.max(...levels.filter((L) => L <= 1).map((L) => cols.get(L).length));
  const midH = maxRows * step - MG_GY;
  const top0 = MG_HEAD + MG_PAD;
  const xy = new Map();
  levels.forEach((L, ci) => {
    const list = cols.get(L);
    const x = MG_PAD + ci * (MG_W + MG_GX);
    if (L <= 1) {
      const top = top0 + (midH - (list.length * step - MG_GY)) / 2;
      list.forEach((n, i) => xy.set(n.key, { x, y: top + i * step, col: ci }));
      return;
    }
    // желаемая высота — средняя у родителей; наложения раздвигаются вниз, потом весь столбец — вверх, если ушёл за край
    const want = list.map((n) => {
      const ys = incoming(n).map((e) => xy.get(e.from)?.y).filter((y) => y != null);
      return ys.length ? ys.reduce((s, y) => s + y, 0) / ys.length : top0;
    });
    const ys = [];
    list.forEach((n, i) => (ys[i] = Math.max(want[i], i ? ys[i - 1] + step : top0)));
    const over = Math.max(0, ys[ys.length - 1] - Math.max(top0 + midH - MG_H, ys[0]));
    const shift = Math.min(over, ys[0] - top0);
    list.forEach((n, i) => xy.set(n.key, { x, y: ys[i] - shift, col: ci }));
  });
  const bottom = Math.max(...[...xy.values()].map((p) => p.y + MG_H));
  return { levels, xy, width: MG_PAD * 2 + levels.length * MG_W + (levels.length - 1) * MG_GX, height: bottom + MG_PAD };
}

/**
 * Кривая между блоками. Обычно — от правого края a к левому краю b. Связь назад (кольцо, общая
 * библиотека левее) — дугой снизу от левого края a к правому краю b; в одной колонке — дугой справа.
 */
function mgPath(a, b) {
  const ay = a.y + MG_H / 2;
  const by = b.y + MG_H / 2;
  let p;
  if (b.col > a.col) {
    const sx = a.x + MG_W;
    const c = Math.max(36, (b.x - sx) / 2);
    p = [sx, ay, sx + c, ay, b.x - c, by, b.x, by];
  } else if (b.col < a.col) {
    const ex = b.x + MG_W;
    const c = Math.max(40, (a.x - ex) / 2);
    const sag = MG_H * 0.9;
    p = [a.x, ay, a.x - c, ay + sag, ex + c, by + sag, ex, by];
  } else {
    const sx = a.x + MG_W;
    const c = 60 + Math.abs(by - ay) * 0.25;
    p = [sx, ay, sx + c, ay, sx + c, by, sx, by];
  }
  // середина кривой Безье — для значка несовместимости
  const mx = (p[0] + 3 * p[2] + 3 * p[4] + p[6]) / 8;
  const my = (p[1] + 3 * p[3] + 3 * p[5] + p[7]) / 8;
  return { d: `M${p[0]} ${p[1]} C${p[2]} ${p[3]}, ${p[4]} ${p[5]}, ${p[6]} ${p[7]}`, mx, my };
}

function mgColTitle(L, d) {
  if (L < 0) return 'Нужен для';
  if (L === 0) return 'Этот мод';
  if (L === 1) {
    const kinds = new Set(d.edges.filter((e) => e.from === d.root).map((e) => e.kind));
    if (kinds.size === 1 && kinds.has('incompatible')) return 'Несовместим с';
    return kinds.has('incompatible') ? 'Связи' : 'Нужно ему';
  }
  const n = L - 1;
  return `Через ${n} ${n % 10 === 1 && n % 100 !== 11 ? 'мод' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? 'мода' : 'модов'}`;
}

function mgRender() {
  const d = MG.data;
  const box = $('#mg');
  if (!box || !d) return;
  const byKey = new Map(d.nodes.map((n) => [n.key, n]));
  const root = byKey.get(d.root);
  $('#dialog-title').textContent = `Зависимости: ${mgName(root)}`;
  const lay = mgLayout(d);
  const bad = new Set(d.problems.flatMap((p) => [p.from, p.to]));
  const c = d.counts;
  const chip = (n, text, cls = '') => (n ? `<span class="mg-chip ${cls}"><b>${n}</b>${text}</span>` : '');
  const plural3 = (n, a, b, c5) => (n % 10 === 1 && n % 100 !== 11 ? a : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? b : c5);
  const lonely = d.nodes.length === 1;

  const edges = d.edges
    .map((e, i) => {
      const a = lay.xy.get(e.from);
      const b = lay.xy.get(e.to);
      if (!a || !b) return '';
      const p = mgPath(a, b);
      const x = e.kind === 'incompatible' ? `<g class="mg-x" data-e="${i}" transform="translate(${p.mx} ${p.my})"><circle r="9"/><path d="M-3.5 -3.5 3.5 3.5 M3.5 -3.5 -3.5 3.5"/></g>` : '';
      return `<path class="mg-edge k-${e.kind}" data-e="${i}" data-from="${esc(e.from)}" data-to="${esc(e.to)}" d="${p.d}" marker-end="url(#mg-arrow-${e.kind})" style="--d:${0.12 + Math.max(0, a.col, b.col) * 0.09}s"/>${x}`;
    })
    .join('');
  const markers = Object.keys(MG_KIND)
    .map((k) => `<marker id="mg-arrow-${k}" class="k-${k}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 10 5 0 10z"/></marker>`)
    .join('');
  const heads = lay.levels
    .map((L, ci) => `<div class="mg-col-title" style="left:${MG_PAD + ci * (MG_W + MG_GX)}px;width:${MG_W}px">${esc(mgColTitle(L, d))}</div>`)
    .join('');
  const nodes = d.nodes
    .map((n) => {
      const q = lay.xy.get(n.key);
      const rel = d.edges.find((e) => e.from === d.root && e.to === n.key) || d.edges.find((e) => e.to === n.key);
      const sub = !n.installed
        ? rel?.kind === 'incompatible'
          ? 'не нужен вместе с ним'
          : 'не установлен'
        : !n.enabled
          ? `${n.version ? esc(n.version) + ' · ' : ''}выключен`
          : esc(n.version || '');
      const img = n.iconUrl ? `<img src="${esc(n.iconUrl)}" alt="" data-letter="${mgLetter(n)}">` : mgLetter(n);
      const cls = ['mg-node', n.key === d.root ? 'root' : '', n.installed ? '' : 'ghost', n.installed && !n.enabled ? 'off' : '', bad.has(n.key) ? 'bad' : '', rel && n.key !== d.root ? `k-${rel.kind}` : ''].join(' ');
      return `<button class="${cls}" data-node="${esc(n.key)}" style="left:${q.x}px;top:${q.y}px;--d:${0.05 + q.col * 0.09}s" title="${esc(mgName(n))}" aria-label="${esc(mgName(n))}${n.installed ? '' : ', не установлен'}"><span class="mod-icon">${img}</span><span class="mg-text"><b>${esc(mgName(n))}</b><small>${sub}</small></span>${bad.has(n.key) ? `<span class="mg-warn" title="Есть проблема">${icon('warning')}</span>` : ''}</button>`;
    })
    .join('');
  const problems = d.problems
    .map((p) => {
      const a = esc(mgName(byKey.get(p.from)));
      const b = esc(mgName(byKey.get(p.to)));
      if (p.kind === 'missing') return `<div class="notice error mg-problem"><span>Для «${a}» нужен «${b}», а его нет в сборке — игра не запустится.</span>${mgCanOpen(byKey.get(p.to)) ? `<button class="btn btn-small btn-secondary" data-mg-open="${esc(p.to)}">Найти в каталоге</button>` : ''}</div>`;
      if (p.kind === 'disabled') return `<div class="notice error mg-problem"><span>«${b}» выключен, а без него не работает «${a}».</span>${MG_ROOM() ? '' : `<button class="btn btn-small btn-secondary" data-mg-enable="${esc(p.to)}">Включить</button>`}</div>`;
      return `<div class="notice error mg-problem"><span>Автор «${a}» указал, что он несовместим с «${b}», а включены оба — выключи один из них.</span></div>`;
    })
    .join('');
  const legend = Object.entries(MG_KIND)
    .filter(([k]) => d.edges.some((e) => e.kind === k))
    .map(([k, t]) => `<span class="mg-leg k-${k}"><svg viewBox="0 0 34 10" aria-hidden="true"><path d="M1 5h30"/></svg>${t}</span>`)
    .join('');

  box.innerHTML = `
    <div class="mg-head">
      ${MG.history.length ? `<button class="btn btn-ghost btn-small" id="mg-back">${icon('back')}${esc(MG.history[MG.history.length - 1].name)}</button>` : ''}
      <div class="mg-chips">
        ${chip(c.required, plural3(c.required, ' обязательная', ' обязательные', ' обязательных'), 'k-required')}
        ${chip(c.embedded, ' встроено', 'k-embedded')}
        ${chip(c.optional, plural3(c.optional, ' необязательная', ' необязательные', ' необязательных'), 'k-optional')}
        ${chip(c.incompatible, ' несовместим', 'k-incompatible')}
        ${chip(c.dependents, ` ${plural3(c.dependents, 'мод зависит', 'мода зависят', 'модов зависят')} от него`, 'k-up')}
        ${c.chain > c.required ? `<span class="mg-chip"><b>${c.chain}</b>всего в цепочке обязательных</span>` : ''}
      </div>
    </div>
    ${problems}
    <div class="mg-stage" id="mg-stage" tabindex="-1">
      <div class="mg-canvas" style="width:${lay.width}px;height:${lay.height}px"><div class="mg-inner" style="width:${lay.width}px;height:${lay.height}px">
        ${heads}
        <svg class="mg-lines" width="${lay.width}" height="${lay.height}" viewBox="0 0 ${lay.width} ${lay.height}" aria-hidden="true"><defs>${markers}</defs>${edges}</svg>
        ${nodes}
      </div></div>
    </div>
    ${lonely ? `<p class="hint mg-lonely">У этого мода нет зависимостей, и другие моды сборки от него не зависят — его можно выключить или удалить, ничего не сломав.</p>` : ''}
    ${d.truncated ? '<p class="hint">Схема большая — показаны первые 80 модов.</p>' : ''}
    <div class="mg-foot"><div class="mg-legend">${legend}${legend ? '<span class="mg-leg-note">стрелка: мод → то, что ему нужно</span>' : ''}</div><div class="mg-detail" id="mg-detail" aria-live="polite"></div></div>`;

  // не загрузилась картинка — снова буква (без onerror в разметке: CSP)
  $$('.mg-node img', box).forEach((im) => im.addEventListener('error', () => (im.parentElement.textContent = im.dataset.letter)));
  mgBind(box, byKey);
  mgDraw(box);
  mgDetail(MG.sel && byKey.has(MG.sel) ? MG.sel : d.root);
  // маленькая схема — посередине окна; большая — прокрутка, выбранный мод в центре видимой области
  const stage = $('#mg-stage');
  // всё окно схемы — без своей прокрутки: высота поля = сколько осталось от экрана после заголовка и подсказок
  const body = $('#dialog-body');
  const rest = $('.dialog').offsetHeight - body.clientHeight + body.scrollHeight - stage.offsetHeight;
  stage.style.maxHeight = Math.max(220, Math.min(640, innerHeight - 60 - rest)) + 'px';
  const cw = Math.max(lay.width, stage.clientWidth);
  const ch = Math.max(lay.height, stage.clientHeight);
  const ox = Math.floor((cw - lay.width) / 2);
  const oy = Math.floor((ch - lay.height) / 2);
  Object.assign($('.mg-canvas', stage).style, { width: cw + 'px', height: ch + 'px' });
  Object.assign($('.mg-inner', stage).style, { left: ox + 'px', top: oy + 'px' });
  const r = lay.xy.get(d.root);
  stage.scrollLeft = Math.max(0, ox + r.x + MG_W / 2 - stage.clientWidth / 2);
  stage.scrollTop = Math.max(0, oy + r.y + MG_H / 2 - stage.clientHeight / 2);
}

/** Сплошные линии «прорисовываются» от мода к зависимости; пунктирные просто проявляются (CSS). */
function mgDraw(box) {
  const t = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--t')) || 0;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches && document.documentElement.dataset.motion !== 'full';
  if (!t || reduce || document.documentElement.dataset.motion === 'off') return;
  $$('.mg-edge.k-required', box).forEach((p) => {
    const len = p.getTotalLength();
    const delay = parseFloat(p.style.getPropertyValue('--d')) * 1000 || 0;
    p.animate([{ strokeDasharray: `${len} ${len}`, strokeDashoffset: len }, { strokeDasharray: `${len} ${len}`, strokeDashoffset: 0 }], { duration: 650 * t, delay: delay * t, easing: 'cubic-bezier(.3,.7,.3,1)', fill: 'backwards' });
  });
}

// окно лаунчера изменило размер — схема заново подстраивается под него
let mgResizeTimer;
addEventListener('resize', () => {
  clearTimeout(mgResizeTimer);
  mgResizeTimer = setTimeout(() => $('#mg-stage') && !$('#overlay').hidden && mgRender(), 200);
});

const MG_ROOM = () => profile(MG.pid)?.kind === 'room';
const mgCanOpen = (n) => !!n && !MG_ROOM() && ['modrinth', 'curseforge'].includes(n.source) && !!n.projectId;

function mgBind(box, byKey) {
  const stage = $('#mg-stage');
  const lit = (key) => {
    stage.classList.toggle('focus', !!key);
    $$('.mg-node', stage).forEach((el) => el.classList.remove('lit'));
    $$('.mg-edge, .mg-x', stage).forEach((el) => el.classList.remove('lit'));
    if (!key) return;
    $(`.mg-node[data-node="${CSS.escape(key)}"]`, stage)?.classList.add('lit');
    $$('.mg-edge', stage).forEach((p) => {
      if (p.dataset.from !== key && p.dataset.to !== key) return;
      p.classList.add('lit');
      $(`.mg-x[data-e="${p.dataset.e}"]`, stage)?.classList.add('lit');
      $(`.mg-node[data-node="${CSS.escape(p.dataset.from === key ? p.dataset.to : p.dataset.from)}"]`, stage)?.classList.add('lit');
    });
  };
  $$('.mg-node', stage).forEach((el) => {
    el.onmouseenter = el.onfocus = () => lit(el.dataset.node);
    el.onmouseleave = el.onblur = () => lit(null);
    el.onclick = () => {
      MG.sel = el.dataset.node;
      $$('.mg-node.sel', stage).forEach((x) => x.classList.remove('sel'));
      el.classList.add('sel');
      mgDetail(el.dataset.node);
    };
    el.ondblclick = () => {
      const n = byKey.get(el.dataset.node);
      if (n.installed && n.key !== MG.data.root) mgFocus(n.key);
    };
  });
  // перетаскивание схемы мышью за пустое место
  stage.onmousedown = (e) => {
    if (e.button !== 0 || e.target.closest('.mg-node')) return;
    const sx = e.clientX + stage.scrollLeft;
    const sy = e.clientY + stage.scrollTop;
    stage.classList.add('drag');
    const move = (m) => {
      stage.scrollLeft = sx - m.clientX;
      stage.scrollTop = sy - m.clientY;
    };
    const up = () => {
      stage.classList.remove('drag');
      removeEventListener('mousemove', move);
      removeEventListener('mouseup', up);
    };
    addEventListener('mousemove', move);
    addEventListener('mouseup', up);
    e.preventDefault();
  };
  if ($('#mg-back', box))
    $('#mg-back', box).onclick = () => {
      const prev = MG.history.pop();
      mgLoad(prev.key);
    };
  $$('[data-mg-open]', box).forEach((b) => (b.onclick = () => mgOpenCatalog(byKey.get(b.dataset.mgOpen))));
  $$('[data-mg-enable]', box).forEach(
    (b) =>
      (b.onclick = async () => {
        b.disabled = true;
        // состав сохраняется даже когда раскладка файлов не удалась — схему и список обновляем в любом случае
        await call('mods:enable', MG.pid, b.dataset.mgEnable, true).catch((e) => toast(e.message || 'Не удалось включить мод'));
        await refresh().catch(() => {});
        render();
        mgLoad(MG.data.root);
      }),
  );
}

/** Сделать центром схемы другой мод (кнопка «Назад» вернёт). */
function mgFocus(key) {
  const root = MG.data.nodes.find((n) => n.key === MG.data.root);
  MG.history.push({ key: root.key, name: mgName(root) });
  mgLoad(key);
}

function mgOpenCatalog(n) {
  if (!mgCanOpen(n)) return;
  closeDialog();
  S.mods.target = MG.pid;
  S.mods.source = n.source;
  S.mods.project = { source: n.source, id: String(n.projectId), all: false };
  go('mods');
}

/** Строка под схемой: что за мод и как он связан с выбранным. */
function mgDetail(key) {
  const box = $('#mg-detail');
  const d = MG.data;
  if (!box || !d) return;
  const byKey = new Map(d.nodes.map((n) => [n.key, n]));
  const n = byKey.get(key);
  if (!n) return (box.innerHTML = '');
  const root = byKey.get(d.root);
  const out = d.edges.find((e) => e.from === d.root && e.to === key);
  const inn = d.edges.find((e) => e.from === key && e.to === d.root);
  let rel;
  if (key === d.root) rel = n.installed && !n.enabled ? 'Выбранный мод — сейчас выключен.' : 'Выбранный мод. Наведи на блок — подсветятся его связи; двойной щелчок — схема этого мода.';
  else if (out)
    rel =
      out.kind === 'incompatible'
        ? // так помечает автор мода в каталоге; чаще всего — нужное уже встроено или моды делают одно и то же
          `Автор «${esc(mgName(root))}» пометил его в каталоге как несовместимый — ставить их вместе не надо. Обычно так бывает, когда то же самое уже встроено в «${esc(mgName(root))}» или моды заменяют друг друга.`
          : `${out.kind === 'required' ? 'Обязательная' : out.kind === 'embedded' ? 'Встроенная' : 'Необязательная'} зависимость «${esc(mgName(root))}».`;
  else if (inn) rel = inn.kind === 'required' ? `Не работает без «${esc(mgName(root))}».` : `Использует «${esc(mgName(root))}», если он есть.`;
  else {
    const via = d.edges.find((e) => e.to === key);
    rel = via ? `Нужен «${esc(mgName(byKey.get(via.from)))}» (${MG_KIND[via.kind]}).` : '';
  }
  const state = !n.installed ? 'не установлен' : !n.enabled ? 'выключен' : n.addedBy === 'dependency' ? 'поставлен как зависимость' : 'установлен';
  const acts = [
    n.installed && key !== d.root ? `<button class="btn btn-secondary btn-small" data-mg-focus="${esc(key)}">${icon('graph')}Его схема</button>` : '',
    mgCanOpen(n) ? `<button class="btn btn-ghost btn-small" data-mg-cat="${esc(key)}">${icon('external')}В каталоге</button>` : '',
  ].join('');
  box.innerHTML = `<div class="mg-detail-text"><b>${esc(mgName(n))}</b>${n.version ? `<span class="tag">${esc(n.version)}</span>` : ''}<span class="tag ${!n.installed || !n.enabled ? 'warn' : ''}">${state}</span><span class="mg-rel">${rel}</span></div><div class="mg-detail-acts">${acts}</div>`;
  const f = $('[data-mg-focus]', box);
  if (f) f.onclick = () => mgFocus(f.dataset.mgFocus);
  const c = $('[data-mg-cat]', box);
  if (c) c.onclick = () => mgOpenCatalog(n);
}
