'use strict';
// Трофеи: блок на главной, окно со всеми трофеями и прогрессом, карточка-картинка, чтобы поделиться.

/** Блок «Трофеи» на главной: последние полученные; ни одного — ближайшие с прогрессом. */
async function paintTrophies(n) {
  const t = await call('trophies:list').catch(() => null);
  const box = S.view === 'play' && !stale(n) ? $('#home-trophies') : null;
  if (!t || !box) return;
  S.trophies = t;
  const got = t.list.filter((x) => x.done).sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const next = t.list.filter((x) => !x.done).sort((a, b) => b.value / b.need - a.value / a.need);
  const badge = (x) => `<div class="trophy ${x.done ? 'got' : ''}" title="${esc(x.text)}"><span class="trophy-ic">${x.icon}</span><span><b>${esc(x.title)}</b><small>${x.done ? esc(x.text) : `${fmtNum(x.value)} из ${x.need}`}</small>${x.done ? '' : `<i class="trophy-bar"><i style="width:${Math.round((x.value / x.need) * 100)}%"></i></i>`}</span></div>`;
  box.hidden = false;
  box.innerHTML = `<div class="sec-head"><h2>Трофеи <span class="hint" style="margin:0;font-weight:400">${t.earned} из ${t.total}</span></h2><button class="btn btn-ghost btn-small" id="trophies-all">Все трофеи ${icon('arrow')}</button></div>
    <div class="trophy-row">${(got.length ? got.slice(0, 4).concat(next.slice(0, Math.max(0, 6 - Math.min(4, got.length)))) : next.slice(0, 6)).map(badge).join('')}</div>`;
  $('#trophies-all').onclick = () => trophiesDialog(t);
}
const fmtNum = (v) => (Number.isInteger(v) ? v : Math.floor(v * 10) / 10);

function trophiesDialog(t) {
  const groups = [...new Set(t.list.map((x) => x.group))];
  dialog(
    `Трофеи — ${t.earned} из ${t.total}`,
    `${groups
      .map(
        (g) =>
          `<h3 class="trophy-group">${esc(g)}</h3><div class="trophy-grid">${t.list
            .filter((x) => x.group === g)
            .map(
              (x) =>
                `<div class="trophy ${x.done ? 'got' : ''}"><span class="trophy-ic">${x.icon}</span><span><b>${esc(x.title)}</b><small>${esc(x.text)}${x.done && x.at ? ` · ${esc(date(x.at))}` : ''}</small>${x.done ? '' : `<i class="trophy-bar"><i style="width:${Math.round((x.value / x.need) * 100)}%"></i></i><small>${fmtNum(x.value)} из ${x.need}</small>`}</span></div>`,
            )
            .join('')}</div>`,
      )
      .join('')}<p class="hint">Трофеи считаются по тому, что лаунчер видит сам: часы, летопись миров (достижения, смерти, игровые дни), ролики, вызовы, скриншоты. Полученный трофей не пропадает.</p>
    <div class="actions"><button class="btn btn-primary" id="tr-save" ${t.earned ? '' : 'disabled'}>${icon('download')}Сохранить картинкой</button><button class="btn btn-secondary" id="tr-copy" ${t.earned ? '' : 'disabled'}>Скопировать картинку</button><button class="btn btn-ghost" data-close>Закрыть</button></div>`,
    true,
  );
  $('#tr-save').onclick = async () => {
    const p = await call('image:save', await trophyCard(t), 'Трофеи easyLauncher').catch((e) => (toast(e.message), null));
    if (p) toast('Картинка сохранена');
  };
  $('#tr-copy').onclick = async () => {
    await copyImage(await trophyCard(t)).then(() => toast('Картинка скопирована — вставь её в чат'), (e) => toast(e.message));
  };
}

/** Картинка (PNG data URL) в буфер обмена: в Electron 44 это делает само окно. */
async function copyImage(dataUrl) {
  // без fetch: защита окна (connect-src 'none') не пускает даже data:-адреса
  const bin = atob(dataUrl.slice(dataUrl.indexOf(',') + 1));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const blob = new Blob([bytes], { type: 'image/png' });
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
  return true;
}

/** Карточка трофеев 1200×630 (как превью ссылки в мессенджерах) — PNG data URL. */
async function trophyCard(t) {
  await document.fonts?.ready;
  const W = 1200;
  const H = 630;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#b9d38e';
  const bg = g.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#11161a');
  bg.addColorStop(1, '#1d2a1f');
  g.fillStyle = bg;
  g.fillRect(0, 0, W, H);
  // пиксельная «трава» внизу — узнаваемо, но без игровых текстур
  for (let x = 0; x < W; x += 20) {
    g.fillStyle = x % 40 ? '#3d6b2c' : '#4b7d35';
    g.fillRect(x, H - 40, 20, 12);
    g.fillStyle = x % 60 ? '#5a3d24' : '#4d331d';
    g.fillRect(x, H - 28, 20, 28);
  }
  const font = (w, s) => `${w} ${s}px 'Manrope Variable', 'Segoe UI', sans-serif`;
  g.fillStyle = '#f2f4ec';
  g.font = font(800, 54);
  g.fillText(`Трофеи${t.nick ? ' ' + t.nick : ''}`, 60, 100);
  g.font = font(500, 26);
  g.fillStyle = accent;
  g.fillText(`${t.earned} из ${t.total} · ${t.hours} ${plural(t.hours, 'час', 'часа', 'часов')} в игре`, 60, 146);
  const got = t.list.filter((x) => x.done).sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 12);
  got.forEach((x, i) => {
    const col = i % 3;
    const row = Math.floor(i / 3);
    const X = 60 + col * 370;
    const Y = 190 + row * 92;
    g.fillStyle = 'rgba(255,255,255,0.06)';
    roundRect(g, X, Y, 350, 76, 14);
    g.fill();
    // значок — непрозрачным цветом (иначе цветной эмодзи берёт прозрачность фона плитки)
    g.fillStyle = '#ffffff';
    g.font = `40px 'Segoe UI Emoji', 'Apple Color Emoji', sans-serif`;
    g.fillText(x.icon, X + 14, Y + 52);
    g.fillStyle = '#f2f4ec';
    g.font = font(700, 22);
    g.fillText(fitText(g, x.title, 260), X + 72, Y + 34);
    g.fillStyle = '#aeb6a4';
    g.font = font(500, 16);
    g.fillText(fitText(g, x.text, 260), X + 72, Y + 58);
  });
  g.fillStyle = 'rgba(242,244,236,0.75)';
  g.font = font(700, 20);
  g.fillText('easyLauncher', W - 210, 60);
  return c.toDataURL('image/png');
}
function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}
/** Обрезать текст по ширине с многоточием. */
function fitText(g, s, w) {
  if (g.measureText(s).width <= w) return s;
  while (s.length > 1 && g.measureText(s + '…').width > w) s = s.slice(0, -1);
  return s + '…';
}
