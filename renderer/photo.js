'use strict';
// Фото-режим: скриншот сборки → фильтр, рамка, подпись (мир, игровой день из летописи) → сохранить или скопировать.
// Всё рисуется на холсте в полном размере скриншота; в окне — уменьшенный вид того же холста.

const PH_FILTERS = [
  ['none', 'Без фильтра', ''],
  ['vivid', 'Яркий', 'saturate(1.45) contrast(1.08)'],
  ['warm', 'Тёплый', 'sepia(0.22) saturate(1.25) brightness(1.03)'],
  ['cinema', 'Кино', 'contrast(1.2) saturate(0.82) brightness(0.96)'],
  ['night', 'Ночь', 'brightness(0.78) saturate(0.7) contrast(1.12)'],
  ['dream', 'Мечта', 'saturate(1.18) brightness(1.08) contrast(0.94)'],
  ['bw', 'Ч/Б', 'grayscale(1) contrast(1.12)'],
  ['sepia', 'Сепия', 'sepia(0.85) contrast(1.05)'],
];
const PH_FRAMES = [
  ['none', 'Без рамки'],
  ['polaroid', 'Полароид'],
  ['film', 'Плёнка'],
  ['blocks', 'Блоки'],
  ['thin', 'Тонкая'],
];

async function photoDialog(p, shot) {
  dialog('Фото-режим', '<p>Открываю скриншот…</p><div class="bar indeterminate"><span></span></div>', 'xl');
  let src;
  let info;
  try {
    [src, info] = await Promise.all([call('shots:data', p.id, shot.file), call('shots:info', p.id, shot.file).catch(() => null)]);
  } catch (e) {
    return errorDialog(e, 'Скриншот не открылся');
  }
  const img = new Image();
  img.src = src;
  try {
    await img.decode();
  } catch {
    return errorDialog({ message: 'Скриншот повреждён или в неизвестном формате.' }, 'Скриншот не открылся');
  }
  const st = { filter: 'none', frame: 'none', vignette: false, caption: true, coords: false, text: photoCaption(info, p, false) };
  dialog(
    'Фото-режим',
    `<div class="photo">
      <div class="photo-view"><canvas id="ph-canvas"></canvas></div>
      <div class="photo-side">
        <h3>Фильтр</h3><div class="photo-chips" id="ph-filters">${PH_FILTERS.map(([id, t]) => `<button data-ph-filter="${id}" aria-pressed="${id === st.filter}">${t}</button>`).join('')}</div>
        <label class="pill-check" style="margin-top:8px"><input type="checkbox" id="ph-vig"><span>Виньетка</span></label>
        <h3>Рамка</h3><div class="photo-chips" id="ph-frames">${PH_FRAMES.map(([id, t]) => `<button data-ph-frame="${id}" aria-pressed="${id === st.frame}">${t}</button>`).join('')}</div>
        <h3>Подпись</h3>
        <label class="pill-check"><input type="checkbox" id="ph-cap" checked><span>Показывать подпись</span></label>
        <input class="input" id="ph-text" maxlength="90" value="${esc(st.text)}" style="margin-top:8px">
        ${info?.pos ? '<label class="pill-check" style="margin-top:8px"><input type="checkbox" id="ph-coords"><span>Координаты (примерно)</span></label>' : ''}
        <p class="hint">${info?.world ? 'Мир и игровой день — из летописи мира.' : 'Скриншот не привязан к сессии в летописи — подпись можно написать свою.'}</p>
        <div class="actions" style="margin-top:auto"><button class="btn btn-primary" id="ph-save">${icon('download')}Сохранить</button><button class="btn btn-secondary" id="ph-copy">Скопировать</button></div>
      </div>
    </div>`,
    'xl',
  );
  const canvas = $('#ph-canvas');
  const draw = () => photoRender(canvas, img, st);
  draw();
  $$('[data-ph-filter]').forEach(
    (b) =>
      (b.onclick = () => {
        st.filter = b.dataset.phFilter;
        $$('[data-ph-filter]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
        draw();
      }),
  );
  $$('[data-ph-frame]').forEach(
    (b) =>
      (b.onclick = () => {
        st.frame = b.dataset.phFrame;
        $$('[data-ph-frame]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
        draw();
      }),
  );
  $('#ph-vig').onchange = (e) => ((st.vignette = e.target.checked), draw());
  $('#ph-cap').onchange = (e) => ((st.caption = e.target.checked), draw());
  $('#ph-text').oninput = (e) => ((st.text = e.target.value), draw());
  if ($('#ph-coords'))
    $('#ph-coords').onchange = (e) => {
      st.text = photoCaption(info, p, e.target.checked);
      $('#ph-text').value = st.text;
      draw();
    };
  const name = `${p.name} ${shot.file.split(/[\\/]/).pop().replace(/\.\w+$/, '')}`;
  $('#ph-save').onclick = async () => {
    const f = await call('image:save', canvas.toDataURL('image/png'), name).catch((e) => (toast(e.message), null));
    if (f) toast('Снимок сохранён');
  };
  $('#ph-copy').onclick = () => copyImage(canvas.toDataURL('image/png')).then(() => toast('Снимок скопирован — вставь его в чат'), (e) => toast(e.message));
}

/** Подпись по умолчанию: мир, игровой день, дата; с координатами — где закончилась сессия (примерно). */
function photoCaption(info, p, coords) {
  const parts = [info?.world ? `Мир «${info.world}»` : p.name];
  if (info?.day != null) parts.push(`день ${info.day}`); // как в летописи мира
  if (coords && info?.pos) parts.push(`${info.pos.map((v) => Math.round(v)).join(' ')}`);
  if (info?.at) parts.push(new Date(info.at).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }));
  return parts.join(' · ').slice(0, 90);
}

/** Нарисовать снимок с фильтром, рамкой и подписью на холст (в полном размере). */
function photoRender(canvas, img, st) {
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const u = Math.max(4, Math.round(Math.min(w, h) / 60)); // единица толщины рамки
  // поля рамки: [слева, сверху, справа, снизу]
  const pad = { none: [0, 0, 0, 0], polaroid: [u * 2, u * 2, u * 2, u * 9], film: [u * 2, u * 4, u * 2, u * 4], blocks: [u * 2, u * 2, u * 2, u * 2], thin: [u, u, u, u] }[st.frame];
  canvas.width = w + pad[0] + pad[2];
  canvas.height = h + pad[1] + pad[3];
  const g = canvas.getContext('2d');
  // фон рамки
  const frameBg = { none: '#000', polaroid: '#f6f4ee', film: '#0b0b0b', blocks: '#7a7a7a', thin: '#fbfbf8' }[st.frame];
  g.fillStyle = frameBg;
  g.fillRect(0, 0, canvas.width, canvas.height);
  if (st.frame === 'blocks') {
    // каменные блоки 2×2 «пикселя» в каждой клетке — без текстур игры
    const cell = u;
    for (let y = 0; y < canvas.height; y += cell) {
      for (let x = 0; x < canvas.width; x += cell) {
        const inside = x >= pad[0] - cell + 1 && x < pad[0] + w && y >= pad[1] - cell + 1 && y < pad[1] + h;
        if (inside) continue;
        const n = ((x * 73856093) ^ (y * 19349663)) >>> 0;
        const v = 104 + (n % 5) * 9;
        g.fillStyle = `rgb(${v},${v},${v})`;
        g.fillRect(x, y, cell, cell);
      }
    }
  }
  if (st.frame === 'film') {
    g.fillStyle = '#e8e2d0';
    const hole = Math.round(u * 1.4);
    for (let x = u; x < canvas.width - hole; x += hole * 2.2) {
      g.fillRect(x, Math.round(u * 1.3), hole, hole);
      g.fillRect(x, canvas.height - Math.round(u * 1.3) - hole, hole, hole);
    }
  }
  // сам снимок с фильтром
  g.save();
  g.filter = PH_FILTERS.find((f) => f[0] === st.filter)?.[2] || 'none';
  g.drawImage(img, pad[0], pad[1], w, h);
  g.restore();
  if (st.filter === 'night') {
    g.fillStyle = 'rgba(20, 40, 110, 0.18)';
    g.fillRect(pad[0], pad[1], w, h);
  }
  if (st.filter === 'cinema') {
    // киношный «тил-оранж»: холодные тени, тёплые света
    g.save();
    g.globalCompositeOperation = 'soft-light';
    const cg = g.createLinearGradient(pad[0], pad[1], pad[0] + w, pad[1] + h);
    cg.addColorStop(0, 'rgba(0, 120, 140, 0.35)');
    cg.addColorStop(1, 'rgba(255, 140, 40, 0.35)');
    g.fillStyle = cg;
    g.fillRect(pad[0], pad[1], w, h);
    g.restore();
  }
  if (st.vignette) {
    const vg = g.createRadialGradient(pad[0] + w / 2, pad[1] + h / 2, Math.min(w, h) * 0.35, pad[0] + w / 2, pad[1] + h / 2, Math.max(w, h) * 0.75);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(0,0,0,0.55)');
    g.fillStyle = vg;
    g.fillRect(pad[0], pad[1], w, h);
  }
  if (st.frame === 'thin') {
    g.strokeStyle = 'rgba(0,0,0,0.25)';
    g.lineWidth = Math.max(1, u / 4);
    g.strokeRect(pad[0], pad[1], w, h);
  }
  // подпись
  const text = st.caption ? String(st.text || '').trim() : '';
  if (!text) return;
  const font = (s, weight = 600) => `${weight} ${s}px 'Manrope Variable', 'Segoe UI', sans-serif`;
  if (st.frame === 'polaroid') {
    g.fillStyle = '#2a2a28';
    g.font = font(Math.round(u * 3.2), 600);
    g.textBaseline = 'middle';
    g.fillText(fitText(g, text, w), pad[0], pad[1] + h + pad[3] / 2);
    return;
  }
  const size = Math.round(u * 2.6);
  g.font = font(size, 700);
  const tw = Math.min(g.measureText(text).width, w - u * 4);
  const bx = pad[0] + u * 2;
  const by = pad[1] + h - u * 2 - size * 1.8;
  g.fillStyle = 'rgba(0,0,0,0.5)';
  roundRect(g, bx - u, by, tw + u * 2, size * 1.8, u);
  g.fill();
  g.fillStyle = '#ffffff';
  g.textBaseline = 'middle';
  g.fillText(fitText(g, text, w - u * 4), bx, by + size * 0.9);
}
