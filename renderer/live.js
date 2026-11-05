'use strict';
// Живой фон: ролики «Камеры воспоминаний» с плавной сменой или, если их нет, пиксельная панорама темы:
// луг со сменой дня и ночи, ночь у костра, пышная пещера, древний город. Рисуется в низком разрешении
// (один «пиксель» = 4 точки экрана) не чаще 30 раз в секунду и замирает, пока открыта игра или окно скрыто.
/* exported Live */
const Live = (() => {
  const PX = 4; // размер пикселя панорамы в точках экрана
  const FPS = 30;
  const FADE_MS = 1400; // смена роликов: затухание одного и проявление другого

  // ---------- шум и случайности (детерминированные: панорама одинакова при каждом открытии) ----------
  const hash = (n) => {
    let x = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
    x ^= x >>> 13;
    x = Math.imul(x, 0xc2b2ae35);
    return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
  };
  const smooth = (t) => t * t * (3 - 2 * t);
  /** Плавный одномерный шум: высота рельефа по номеру столбца блоков. */
  const noise = (x, seed) => {
    const i = Math.floor(x);
    const f = x - i;
    return hash(i * 374761 + seed) * (1 - smooth(f)) + hash((i + 1) * 374761 + seed) * smooth(f);
  };
  const fbm = (x, seed) => noise(x, seed) * 0.62 + noise(x * 2.3, seed + 7) * 0.28 + noise(x * 5.1, seed + 13) * 0.1;
  const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
  const rgb = (c, a = 1) => (a >= 1 ? `rgb(${c[0]},${c[1]},${c[2]})` : `rgba(${c[0]},${c[1]},${c[2]},${a})`);
  const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

  // ---------- палитры тем ----------
  const SCENES = {
    meadow: {
      kind: 'surface',
      cycle: 300, // секунд на сутки
      sky: { day: ['#7fc4ef', '#d6eefa'], dusk: ['#5a5f9e', '#f6b07a'], night: ['#0d1430', '#27325a'] },
      layers: [
        { color: '#8db8a0', block: 3, base: 0.56, amp: 0.16, speed: 0.15, seed: 11, depth: 0.25, fog: 0.55 },
        { color: '#5f9b55', top: '#7cbf5e', block: 4, base: 0.66, amp: 0.15, speed: 0.35, seed: 23, depth: 0.55, fog: 0.25, trees: 0.12 },
        { color: '#6b4a2f', top: '#5fae3f', block: 6, base: 0.8, amp: 0.1, speed: 0.7, seed: 37, depth: 1, fog: 0, trees: 0.08, flowers: true },
      ],
      particles: 'petals',
      clouds: true,
      realtime: true,
    },
    campfire: {
      kind: 'surface',
      cycle: 0, // всегда ночь
      sky: { night: ['#07080f', '#231b26'] },
      // у костра мир не едет: огонь стоит на земле, двигается только параллакс от мыши
      layers: [
        { color: '#22222f', block: 3, base: 0.5, amp: 0.15, speed: 0, seed: 51, depth: 0.25, fog: 0.3 },
        { color: '#18171f', top: '#232a1e', block: 4, base: 0.62, amp: 0.13, speed: 0, seed: 63, depth: 0.55, fog: 0.15, trees: 0.16, pine: true },
        { color: '#100e11', top: '#1d2618', block: 6, base: 0.74, amp: 0.06, speed: 0, seed: 71, depth: 1, fog: 0, trees: 0.05, pine: true },
      ],
      particles: 'embers',
      fire: 0.6, // где костёр по ширине окна
    },
    lush: {
      kind: 'cave',
      bg: ['#0c1a14', '#1a2a1a'],
      rock: ['#22392a', '#2d4631'],
      moss: '#4f7a2e',
      mossTop: '#79a83c',
      glow: '#ffb347',
      particles: 'spores',
      vines: true,
    },
    deepdark: {
      kind: 'cave',
      bg: ['#03080b', '#071318'],
      rock: ['#10242b', '#163038'],
      moss: '#0b2a33',
      mossTop: '#0f4c5c',
      glow: '#3fe0d0',
      particles: 'souls',
      sculk: true,
    },
  };

  SCENES.meadowNight = { ...SCENES.meadow, cycle: 0, realtime: false, sky: { night: ['#0b1228', '#25304f'] } };

  // ---------- состояние ----------
  let canvas = null;
  let ctx = null;
  let scene = null;
  let W = 0;
  let H = 0;
  let raf = 0;
  let last = 0;
  let t0 = performance.now();
  let paused = false;
  let parts = [];
  const mouse = { x: 0, y: 0, tx: 0, ty: 0 };
  const fireAt = { x: 0, y: 0 }; // откуда летят искры

  const motion = () => document.documentElement.dataset.motion || 'full';

  function resize() {
    if (!canvas) return;
    W = Math.max(80, Math.ceil(innerWidth / PX));
    H = Math.max(60, Math.ceil(innerHeight / PX));
    canvas.width = W;
    canvas.height = H;
    ctx.imageSmoothingEnabled = false;
    parts = [];
  }

  /**
   * Сезон по дате компьютера: зима (снег), Хэллоуин (тыквы и летучие мыши). Так фон «знает», какое сейчас время года.
   */
  function seasonOf(d = new Date()) {
    const m = d.getMonth() + 1;
    const day = d.getDate();
    if (m === 12 || m <= 2) return 'winter';
    if ((m === 10 && day >= 20) || (m === 11 && day <= 3)) return 'halloween';
    return null;
  }
  let season = seasonOf();
  let seasonAt = 0;
  let seasonForced = false;

  /** Время суток 0..1 (0 — полдень, 0.5 — полночь) и смесь неба. */
  function daylight(sc, sec) {
    if (sc.realtime) {
      // луг живёт по часам компьютера: рассвет 6–8, день, закат 19–21, ночь
      const d = new Date();
      const h = d.getHours() + d.getMinutes() / 60;
      const night = h < 6 || h >= 21 ? 1 : h < 8 ? 1 - smooth((h - 6) / 2) : h >= 19 ? smooth((h - 19) / 2) : 0;
      return { night, dusk: 1 - Math.min(1, Math.abs(night - 0.5) * 2), phase: (((h - 12) / 24) % 1 + 1) % 1 };
    }
    if (!sc.cycle) return { night: 1, dusk: 0, phase: 0.5 };
    const phase = (sec / sc.cycle) % 1;
    // день → закат → ночь → рассвет: «ночность» 0..1 и «закатность» на переходах
    const night = phase < 0.4 ? 0 : phase < 0.5 ? smooth((phase - 0.4) / 0.1) : phase < 0.85 ? 1 : 1 - smooth((phase - 0.85) / 0.15);
    const dusk = 1 - Math.min(1, Math.abs(night - 0.5) * 2);
    return { night, dusk, phase };
  }

  function sky(sc, light) {
    const s = sc.sky;
    const day = (s.day || s.night).map(hex);
    const nightC = s.night.map(hex);
    let top = mix(day[0], nightC[0], light.night);
    let bot = mix(day[1], nightC[1], light.night);
    if (s.dusk && light.dusk > 0) {
      const d = s.dusk.map(hex);
      top = mix(top, d[0], light.dusk * 0.7);
      bot = mix(bot, d[1], light.dusk);
    }
    return { top, bot };
  }

  function drawSurface(sc, sec, dt) {
    const light = daylight(sc, sec);
    const { top, bot } = sky(sc, light);
    // небо полосами по 2 пикселя — ступенчатый градиент, как у блочного мира
    for (let y = 0; y < H; y += 2) {
      ctx.fillStyle = rgb(mix(top, bot, Math.min(1, y / (H * 0.8))));
      ctx.fillRect(0, y, W, 2);
    }
    // звёзды
    if (light.night > 0.05) {
      for (let i = 0; i < 140; i++) {
        const x = Math.floor(hash(i * 3 + 1) * W);
        const y = Math.floor(hash(i * 3 + 2) * H * 0.55);
        const tw = 0.55 + 0.45 * Math.sin(sec * (0.6 + hash(i) * 1.8) + i);
        ctx.fillStyle = `rgba(255,255,240,${(light.night * tw * (0.35 + hash(i * 7) * 0.65)).toFixed(3)})`;
        ctx.fillRect(x, y, hash(i * 5) > 0.92 ? 2 : 1, 1);
      }
    }
    // солнце и луна — квадраты по дуге
    if (sc.cycle) {
      const a = light.phase * Math.PI * 2;
      const cx = W * 0.5 + Math.sin(a) * W * 0.42;
      const sunY = H * 0.62 - Math.cos(a) * H * 0.5;
      const moonY = H * 0.62 + Math.cos(a) * H * 0.5;
      const mx = W * 0.5 - Math.sin(a) * W * 0.42;
      const sz = Math.max(8, Math.round(H * 0.07));
      ctx.fillStyle = 'rgba(255,240,180,.18)';
      ctx.fillRect(Math.round(cx - sz), Math.round(sunY - sz), sz * 2, sz * 2);
      ctx.fillStyle = '#fff6c8';
      ctx.fillRect(Math.round(cx - sz / 2), Math.round(sunY - sz / 2), sz, sz);
      ctx.fillStyle = '#dfe4ee';
      ctx.fillRect(Math.round(mx - sz / 2), Math.round(moonY - sz / 2), sz, sz);
      ctx.fillStyle = '#b7bfcc';
      ctx.fillRect(Math.round(mx - sz / 4), Math.round(moonY - sz / 4), Math.ceil(sz / 4), Math.ceil(sz / 4));
      ctx.fillRect(Math.round(mx + sz / 8), Math.round(moonY + sz / 8), Math.ceil(sz / 5), Math.ceil(sz / 5));
    } else {
      // ночь у костра: луна стоит на месте
      // мягкое сияние вместо квадрата-подложки: серый квадрат читался как сбой интерфейса
      const sz = Math.max(8, Math.round(H * 0.06));
      const mx = Math.round(W * 0.56 - sz / 2);
      const my = Math.round(H * 0.16 - sz / 2);
      halo(mx + sz / 2, my + sz / 2, sz * 2.6, [200, 210, 240], 0.22);
      ctx.fillStyle = '#eef1f8';
      ctx.fillRect(mx, my, sz, sz);
      ctx.fillStyle = '#c3cad8';
      const c = Math.max(1, Math.round(sz / 5));
      ctx.fillRect(mx + c, my + c, c, c);
      ctx.fillRect(mx + sz - c * 2, my + sz - c * 2, c, c);
    }
    // облака — плоские блоки, плывут медленно
    if (sc.clouds) {
      const cAlpha = 0.85 - light.night * 0.6;
      ctx.fillStyle = light.night > 0.5 ? `rgba(150,160,190,${cAlpha * 0.4})` : `rgba(255,255,255,${cAlpha})`;
      const off = sec * 2.2 + mouse.x * 4;
      for (let i = 0; i < 9; i++) {
        const w = 14 + Math.floor(hash(i + 90) * 26);
        const x = ((hash(i + 40) * (W + 120) + off) % (W + 120)) - 60;
        const y = Math.floor(H * (0.08 + hash(i + 60) * 0.22));
        ctx.fillRect(Math.round(x), y, w, 3);
        ctx.fillRect(Math.round(x + w * 0.2), y - 2, Math.round(w * 0.5), 2);
      }
    }
    // слои рельефа: дальние светлее (туман), ближние темнее и быстрее
    const shade = 1 - light.night * 0.72;
    for (const L of sc.layers) drawLayer(L, sec, shade, bot, light);
    if (sc.fire) {
      // костёр стоит на ближнем слое: та же поправка параллакса, что у земли под ним
      const near = sc.layers[sc.layers.length - 1];
      const scroll = sec * near.speed + mouse.x * 10 * near.depth;
      const col = Math.floor((W * sc.fire) / near.block + scroll);
      fireAt.x = Math.round((col - scroll) * near.block + near.block / 2);
      fireAt.y = layerHeight(near, col) + Math.round(mouse.y * 4 * near.depth);
      drawFire(sec, fireAt.x, fireAt.y);
    }
    if (season === 'halloween') bats(sec, light);
    particles(sc, sec, dt, light);
  }

  function layerHeight(L, col) {
    return Math.floor(H * (L.base - fbm(col * 0.11, L.seed) * L.amp) / L.block) * L.block;
  }

  function drawLayer(L, sec, shade, fogColor, light) {
    const b = L.block;
    const scroll = sec * L.speed + mouse.x * 10 * L.depth;
    const first = Math.floor(scroll);
    const frac = scroll - first;
    const cols = Math.ceil(W / b) + 2;
    const base = mix(hex(L.color), [0, 0, 0], 1 - shade);
    const body = mix(base, fogColor, L.fog * (1 - light.night * 0.5));
    // зимой верх земли под снегом
    const topHex = season === 'winter' && L.top ? '#eef3f6' : L.top;
    const topC = topHex ? mix(mix(hex(topHex), [0, 0, 0], 1 - shade), fogColor, L.fog) : body;
    const dy = Math.round(mouse.y * 4 * L.depth);
    for (let c = 0; c < cols; c++) {
      const col = first + c;
      const x = Math.round((c - frac) * b);
      const h = layerHeight(L, col) + dy;
      ctx.fillStyle = rgb(body);
      ctx.fillRect(x, h, b, H - h);
      // верхний блок — трава, на ближнем слое чуть пёстрые блоки земли
      ctx.fillStyle = rgb(topC);
      ctx.fillRect(x, h, b, Math.max(1, Math.round(b / 2)));
      if (L.depth === 1 && hash(col * 17) > 0.7) {
        ctx.fillStyle = rgb(mix(body, [0, 0, 0], 0.18));
        ctx.fillRect(x + 1, h + b + 1, Math.max(1, b - 3), Math.max(1, b - 3));
      }
      if (season === 'halloween' && L.depth === 1 && hash(col * 41) > 0.9) drawPumpkin(x, h, b, shade, light);
      if (L.flowers && season !== 'winter' && hash(col * 29) > 0.86) {
        ctx.fillStyle = rgb(mix(hex(hash(col) > 0.5 ? '#f4d35e' : '#e86a92'), [0, 0, 0], 1 - shade));
        ctx.fillRect(x + Math.floor(b / 2), h - 2, 1, 1);
      }
      if (L.trees && hash(col * 7 + L.seed) < L.trees) drawTree(L, x, h, shade, fogColor, col);
    }
  }

  function drawTree(L, x, ground, shade, fog, col) {
    const b = L.block;
    const trunkH = b * (3 + Math.floor(hash(col * 11) * 2));
    const trunk = mix(mix(hex('#5b3f26'), [0, 0, 0], 1 - shade), fog, L.fog);
    const leaf = mix(mix(hex(L.pine ? '#1f3b2a' : '#3f8a3a'), [0, 0, 0], 1 - shade), fog, L.fog);
    ctx.fillStyle = rgb(trunk);
    ctx.fillRect(x + Math.floor(b / 3), ground - trunkH, Math.max(1, Math.ceil(b / 3)), trunkH);
    ctx.fillStyle = rgb(leaf);
    if (L.pine) {
      for (let i = 0; i < 4; i++) {
        const w = b * (3 - i * 0.6);
        ctx.fillRect(Math.round(x + b / 2 - w / 2), ground - trunkH - i * b + b, Math.round(w), b);
      }
    } else {
      ctx.fillRect(x - b, ground - trunkH - b, b * 3, b * 2);
      ctx.fillRect(x, ground - trunkH - b * 2, b, b);
    }
    if (season === 'winter') {
      // снежные шапки на кронах
      ctx.fillStyle = rgb(mix(mix(hex('#f4f8fb'), [0, 0, 0], 1 - shade), fog, L.fog));
      if (L.pine) ctx.fillRect(Math.round(x + b / 2 - b * 0.6), ground - trunkH - 2 * b, Math.round(b * 1.2), Math.max(1, Math.round(b / 3)));
      else {
        ctx.fillRect(x - b, ground - trunkH - b, b * 3, Math.max(1, Math.round(b / 3)));
        ctx.fillRect(x, ground - trunkH - b * 2, b, Math.max(1, Math.round(b / 3)));
      }
    }
  }

  /** Тыква-светильник на земле (Хэллоуин): ночью светится. */
  function drawPumpkin(x, ground, b, shade, light) {
    const s = Math.max(3, b - 1);
    const px = x + Math.floor((b - s) / 2);
    const py = ground - s;
    ctx.fillStyle = rgb(mix(hex('#d9741c'), [0, 0, 0], 1 - Math.max(shade, 0.55)));
    ctx.fillRect(px, py, s, s);
    ctx.fillStyle = light.night > 0.4 ? '#ffd65a' : '#3a2410';
    ctx.fillRect(px + 1, py + 1, 1, 1);
    ctx.fillRect(px + s - 2, py + 1, 1, 1);
    ctx.fillRect(px + 1, py + s - 2, s - 2, 1);
    if (light.night > 0.4) halo(px + s / 2, py + s / 2, 6, [255, 190, 70], 0.25);
  }

  /** Летучие мыши (Хэллоуин, ночью): несколько тёмных силуэтов, машут крыльями. */
  function bats(sec, light) {
    if (light.night < 0.3) return;
    ctx.fillStyle = `rgba(20,14,24,${(0.85 * light.night).toFixed(2)})`;
    for (let i = 0; i < 5; i++) {
      const sp = 6 + hash(i + 300) * 10;
      const x = ((hash(i + 310) * (W + 40) + sec * sp) % (W + 40)) - 20;
      const y = H * (0.12 + hash(i + 320) * 0.3) + Math.sin(sec * 2 + i) * 4;
      const up = Math.sin(sec * 12 + i * 2) > 0;
      ctx.fillRect(Math.round(x), Math.round(y), 2, 1);
      ctx.fillRect(Math.round(x) - 2, Math.round(y) + (up ? -1 : 1), 2, 1);
      ctx.fillRect(Math.round(x) + 2, Math.round(y) + (up ? -1 : 1), 2, 1);
    }
  }

  function drawFire(sec, fx, fy) {
    // тёплое пятно света и пляшущие языки пламени
    const flick = 0.85 + Math.sin(sec * 7) * 0.08 + Math.sin(sec * 13.1) * 0.05;
    ctx.globalCompositeOperation = 'lighter';
    const g = ctx.createRadialGradient(fx, fy, 2, fx, fy, H * 0.6 * flick);
    g.addColorStop(0, 'rgba(255,140,40,.55)');
    g.addColorStop(0.3, 'rgba(210,90,25,.22)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#3a2614';
    ctx.fillRect(fx - 9, fy, 18, 3);
    ctx.fillStyle = '#5b3a1d';
    ctx.fillRect(fx - 7, fy - 2, 14, 2);
    for (let i = 0; i < 5; i++) {
      const h = Math.round(6 + 5 * Math.abs(Math.sin(sec * (5 + i) + i * 1.7)));
      ctx.fillStyle = i % 2 ? '#ffb347' : '#ff7b2e';
      ctx.fillRect(fx - 6 + i * 3, fy - 2 - h, 2, h);
      ctx.fillStyle = '#ffe08a';
      ctx.fillRect(fx - 6 + i * 3, fy - 3 - Math.round(h * 0.4), 1, Math.round(h * 0.4));
    }
  }

  function drawCave(sc, sec, dt) {
    const bg = sc.bg.map(hex);
    for (let y = 0; y < H; y += 2) {
      ctx.fillStyle = rgb(mix(bg[0], bg[1], Math.abs(y / H - 0.5) * 2));
      ctx.fillRect(0, y, W, 2);
    }
    const rock = sc.rock.map(hex);
    // дальняя стена — крупные тусклые блоки
    const far = 5;
    const scrollFar = sec * 0.18 + mouse.x * 3;
    for (let cx = -1; cx < W / far + 1; cx++) {
      const col = cx + Math.floor(scrollFar);
      for (let cy = 0; cy < H / far; cy++) {
        const v = hash(col * 1013 + cy * 7919);
        if (v > 0.55) continue;
        ctx.fillStyle = rgb(mix(rock[0], bg[1], 0.45 + v * 0.4), 0.6);
        ctx.fillRect(Math.round((cx - (scrollFar % 1)) * far), cy * far, far, far);
      }
    }
    // потолок со сталактитами и пол со сталагмитами, два слоя глубины
    const layers = [
      { block: 4, speed: 0.35, depth: 0.5, seed: 5, c: mix(rock[1], bg[1], 0.35) },
      { block: 6, speed: 0.75, depth: 1, seed: 9, c: rock[0] },
    ];
    for (const L of layers) {
      const b = L.block;
      const scroll = sec * L.speed + mouse.x * 12 * L.depth;
      const first = Math.floor(scroll);
      const frac = scroll - first;
      const dy = Math.round(mouse.y * 4 * L.depth);
      for (let c = 0; c < W / b + 2; c++) {
        const col = first + c;
        const x = Math.round((c - frac) * b);
        // сталактиты: местами потолок свисает на несколько блоков
        const drip = hash(col * 31 + L.seed) > 0.84 ? b * (2 + Math.floor(hash(col * 37) * 4)) : 0;
        const ceil = Math.floor((H * (0.08 + fbm(col * 0.13, L.seed) * 0.2)) / b) * b + drip + dy;
        const floor = Math.floor((H * (0.66 + fbm(col * 0.09, L.seed + 3) * 0.14)) / b) * b + dy;
        ctx.fillStyle = rgb(L.c);
        ctx.fillRect(x, 0, b, ceil);
        ctx.fillRect(x, floor, b, H - floor);
        // мох / скалк на полу
        ctx.fillStyle = rgb(mix(hex(sc.moss), bg[0], L.depth === 1 ? 0 : 0.4));
        ctx.fillRect(x, floor, b, Math.ceil(b / 2));
        ctx.fillStyle = rgb(mix(hex(sc.mossTop), bg[0], L.depth === 1 ? 0 : 0.4));
        if (hash(col * 13 + L.seed) > 0.5) ctx.fillRect(x, floor - 1, b, 1);
        if (L.depth === 1) caveDetail(sc, col, x, b, ceil, floor, sec);
      }
    }
    particles(sc, sec, dt, { night: 1 });
  }

  /** Лианы со светящимися ягодами (пещера) или пульсирующие сенсоры скалка (древний город). */
  function caveDetail(sc, col, x, b, ceil, floor, sec) {
    const glow = hex(sc.glow);
    if (sc.vines && hash(col * 47) > 0.8) {
      const len = Math.round(H * (0.06 + hash(col * 53) * 0.3));
      ctx.fillStyle = '#3d6b2a';
      ctx.fillRect(x + Math.floor(b / 2), ceil, 1, len);
      for (let y = ceil + 4; y < ceil + len; y += 5 + Math.floor(hash(col + y) * 6)) {
        if (hash(col * 3 + y) > 0.5) {
          ctx.fillStyle = rgb(glow);
          ctx.fillRect(x + Math.floor(b / 2) - 1, y, 2, 2);
          halo(x + b / 2, y + 1, 7, glow, 0.22 + 0.06 * Math.sin(sec * 2 + col));
        }
      }
    }
    if (sc.sculk && hash(col * 61) > 0.72) {
      // волна по сенсорам: древний город «дышит»
      const wave = Math.max(0, Math.sin(sec * 1.4 - col * 0.35));
      ctx.fillStyle = rgb(mix([8, 40, 48], glow, 0.3 + wave * 0.7));
      ctx.fillRect(x + 1, floor - 3, b - 2, 3);
      halo(x + b / 2, floor - 3, 6 + wave * 8, glow, 0.08 + wave * 0.3);
    }
  }

  function halo(x, y, r, c, a) {
    ctx.globalCompositeOperation = 'lighter';
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, rgb(c, a));
    g.addColorStop(1, rgb(c, 0));
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
    ctx.globalCompositeOperation = 'source-over';
  }

  /** Частицы: лепестки и светлячки, искры костра, споры, души. */
  function particles(sc, sec, dt, light) {
    if (motion() === 'off') return;
    // зимой на лугу вместо лепестков — снег
    const kind = season === 'winter' && sc.particles === 'petals' ? 'snow' : sc.particles;
    if (parts.length && parts[0].kind !== kind) parts = [];
    const want = Math.round((W * H) / (kind === 'embers' ? 900 : 1400));
    while (parts.length < want) parts.push(spawn(kind, true));
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      p.age += dt;
      p.x += (p.vx + Math.sin(sec * p.wob + p.ph) * p.sway) * dt;
      p.y += p.vy * dt;
      if (p.age > p.life || p.y > H + 4 || p.y < -6 || p.x < -6 || p.x > W + 6) {
        parts[i] = spawn(kind, false);
        continue;
      }
      const fade = Math.min(1, p.age / 0.8, (p.life - p.age) / 1.2);
      let c = p.c;
      let a = p.a * fade;
      if (kind === 'petals' && light.night > 0.6) {
        // ночью на лугу — светлячки
        c = [210, 255, 120];
        a *= 0.5 + 0.5 * Math.sin(sec * 3 + p.ph);
      }
      ctx.fillStyle = rgb(c, a);
      ctx.fillRect(Math.round(p.x + mouse.x * 6 * p.z), Math.round(p.y + mouse.y * 4 * p.z), p.s, p.s);
      if (kind === 'embers' || kind === 'souls' || (kind === 'petals' && light.night > 0.6)) halo(p.x, p.y, 3, c, a * 0.35);
    }
  }

  function spawn(kind, anywhere) {
    const r = Math.random;
    const p = { kind, age: 0, ph: r() * 6, wob: 0.6 + r() * 1.4, z: 0.4 + r() * 0.8, s: r() > 0.8 ? 2 : 1 };
    if (kind === 'snow') {
      Object.assign(p, { x: r() * W, y: -2, vx: (r() - 0.5) * 3, vy: 5 + r() * 6, sway: 6, life: 40, a: 0.9, c: [245, 248, 255] });
      if (anywhere) p.y = r() * H;
    } else if (kind === 'embers') {
      Object.assign(p, { x: fireAt.x + (r() - 0.5) * 10, y: fireAt.y - 6, vx: (r() - 0.4) * 6, vy: -(8 + r() * 14), sway: 4, life: 2 + r() * 4, a: 0.9, c: r() > 0.5 ? [255, 170, 60] : [255, 110, 40] });
      if (anywhere) p.life = r() * 2;
    } else if (kind === 'souls') {
      Object.assign(p, { x: r() * W, y: H * (0.6 + r() * 0.4), vx: (r() - 0.5) * 2, vy: -(2 + r() * 4), sway: 2, life: 6 + r() * 8, a: 0.55, c: [140, 240, 235] });
      if (anywhere) p.y = r() * H;
    } else if (kind === 'spores') {
      Object.assign(p, { x: r() * W, y: -2, vx: (r() - 0.5) * 2, vy: 2 + r() * 4, sway: 3, life: 20, a: 0.7, c: r() > 0.3 ? [150, 210, 90] : [255, 190, 90] });
      if (anywhere) p.y = r() * H;
    } else {
      Object.assign(p, { x: r() * W, y: -2, vx: 3 + r() * 4, vy: 4 + r() * 5, sway: 5, life: 30, a: 0.85, c: r() > 0.5 ? [255, 214, 232] : [255, 255, 255] });
      if (anywhere) p.y = r() * H;
    }
    return p;
  }

  function frame(now) {
    raf = 0;
    if (!scene || paused || document.hidden) return;
    const m = motion();
    const interval = 1000 / (m === 'reduced' ? 12 : FPS);
    if (now - last >= interval) {
      const dt = Math.min(0.1, (now - (last || now)) / 1000);
      last = now;
      // сезон пересчитывается раз в минуту — лаунчер может быть открыт через полночь
      if (!seasonForced && now - seasonAt > 60000) {
        seasonAt = now;
        season = seasonOf();
      }
      mouse.x += (mouse.tx - mouse.x) * 0.06;
      mouse.y += (mouse.ty - mouse.y) * 0.06;
      const sec = (now - t0) / 1000;
      if (scene.kind === 'cave') drawCave(scene, sec, dt);
      else drawSurface(scene, sec, dt);
    }
    if (m !== 'off') raf = requestAnimationFrame(frame);
  }
  function kick() {
    if (!raf && scene && !paused && !document.hidden) raf = requestAnimationFrame(frame);
  }

  // ---------- ролики ----------
  let videos = [];
  let clips = [];
  let bag = [];
  let front = 0;
  let videoOn = false;
  let fadeTimer = 0;

  function nextClip() {
    if (!bag.length) {
      bag = clips.map((c, i) => i).sort(() => Math.random() - 0.5);
      // тот же ролик два раза подряд — только если он один
      if (bag.length > 1 && clips[bag[0]]?.file === videos[front]?.dataset.file) bag.push(bag.shift());
    }
    return clips[bag.shift()];
  }
  function load(v, clip) {
    v.dataset.file = clip.file;
    v.src = `easyimg://img/?f=${encodeURIComponent(clip.file).replace(/'/g, '%27')}`;
  }
  function crossfade() {
    if (!videoOn || paused || clips.length === 0) return;
    const cur = videos[front];
    const nxt = videos[1 - front];
    const clip = nextClip();
    if (!clip) return;
    load(nxt, clip);
    nxt.currentTime = 0;
    nxt.play().catch(() => {});
    nxt.classList.add('on');
    cur.classList.remove('on');
    clearTimeout(fadeTimer);
    fadeTimer = setTimeout(() => cur.pause(), FADE_MS + 100);
    front = 1 - front;
  }
  function onTime(e) {
    const v = e.target;
    if (v !== videos[front] || !v.duration) return;
    if (v.duration - v.currentTime < FADE_MS / 1000 && !v.dataset.fading) {
      v.dataset.fading = '1';
      crossfade();
    }
  }
  function startVideo() {
    const v = videos[front];
    const clip = nextClip();
    if (!clip) return;
    load(v, clip);
    v.classList.add('on');
    v.play().catch(() => {});
  }

  function apply() {
    const root = document.documentElement;
    const useVideo = videoOn && clips.length > 0;
    root.dataset.live = useVideo ? 'video' : scene ? 'panorama' : 'off';
    if (useVideo) {
      if (!videos.some((v) => v.classList.contains('on'))) startVideo();
      else if (!paused) videos[front].play().catch(() => {});
    }
    if (!useVideo || paused) videos.forEach((v) => v.pause());
    if (useVideo) {
      cancelAnimationFrame(raf);
      raf = 0;
    } else kick();
  }

  return {
    init({ canvas: c, videos: vs }) {
      canvas = c;
      ctx = c.getContext('2d', { alpha: false });
      videos = vs;
      for (const v of videos) {
        v.muted = true;
        v.playsInline = true;
        v.addEventListener('timeupdate', onTime);
        v.addEventListener('playing', () => delete v.dataset.fading);
        // битый или удалённый ролик — сразу следующий
        v.addEventListener('error', () => v === videos[front] && videoOn && setTimeout(crossfade, 300));
      }
      resize();
      addEventListener('resize', resize);
      addEventListener('mousemove', (e) => {
        mouse.tx = (e.clientX / innerWidth) * 2 - 1;
        mouse.ty = (e.clientY / innerHeight) * 2 - 1;
      });
      document.addEventListener('visibilitychange', () => (document.hidden ? videos.forEach((v) => v.pause()) : apply()));
    },
    /** Тема оформления: панорама только у живых тем. */
    setScene(style, theme) {
      // «Дневной луг» в тёмных схемах — ночной луг: светлячки и звёзды под тёмные панели
      const next = (style === 'meadow' && theme && theme !== 'light' ? SCENES.meadowNight : SCENES[style]) || null;
      if (next !== scene) {
        scene = next;
        parts = [];
        t0 = performance.now() - (style === 'meadow' ? 30000 : 0); // луг открывается ясным днём
      }
      apply();
      // «Анимации: выкл.» — один неподвижный кадр
      if (scene && motion() === 'off') requestAnimationFrame(frame);
    },
    /** Ролики камеры воспоминаний и включён ли их показ. */
    setClips(list, on) {
      const files = (list || []).map((c) => c.file).join('|');
      if (files !== clips.map((c) => c.file).join('|')) {
        clips = (list || []).slice();
        bag = [];
      }
      videoOn = !!on;
      apply();
    },
    /** Пока открыта игра, фон замирает: видеокарта и процессор нужны Minecraft. */
    setPaused(v) {
      if (paused === !!v) return;
      paused = !!v;
      apply();
    },
    scenes: Object.keys(SCENES),
    /** Текущий сезон фона (null — обычное время года). setSeason — для проверки вида; undefined — снова по дате. */
    season: () => season,
    setSeason(s) {
      seasonForced = s !== undefined;
      season = seasonForced ? s : seasonOf();
      parts = [];
    },
  };
})();
