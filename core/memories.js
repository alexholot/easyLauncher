'use strict';
// «Камера воспоминаний»: короткие ролики из своей игры для живого фона лаунчера.
// Включается только самим игроком. Пишется только окно Minecraft, пока оно активно и игрок в мире:
// 10–20 секунд раз в N минут активной игры, без звука, 30 кадров, аппаратный кодировщик видеокарты,
// если он есть. Процесс FFmpeg получает пониженный приоритет, старые ролики удаляются сами.
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const childProcess = require('child_process');
const { EventEmitter } = require('events');
const AdmZip = require('adm-zip');
const http = require('./http');
const gamewindow = require('./gamewindow');
const { readJson, writeJson } = require('./store');

// Сборки FFmpeg для Windows (BtbN/FFmpeg-Builds): выпуск «latest» обновляется, имена архивов с номером ветки.
// Список хешей лежит рядом с архивами — без API GitHub (у него жёсткий лимит запросов без входа).
const FF_BASE = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/';
// LGPL: в ней есть кодировщики видеокарт и Windows, её можно класть в установщик рядом с программой
const FF_ASSET = /^ffmpeg-n(\d+)\.(\d+)-latest-win64-lgpl-shared-\d+\.\d+\.zip$/;

// От самого быстрого для игры к самому медленному: кодировщики видеокарт не трогают процессор.
// h264_mf — кодировщик самой Windows, есть почти везде; libx264 — только в GPL-сборках FFmpeg.
const ENCODERS = ['h264_nvenc', 'h264_amf', 'h264_qsv', 'h264_mf', 'libx264'];
const ENCODER_LABEL = { h264_nvenc: 'NVIDIA NVENC', h264_amf: 'AMD AMF', h264_qsv: 'Intel Quick Sync', h264_mf: 'кодировщик Windows', libx264: 'процессор (x264 ultrafast)' };
const ENCODER_OPTS = {
  h264_nvenc: ['-preset', 'p1', '-tune', 'll', '-rc', 'vbr', '-cq', '30', '-maxrate', '6M', '-bufsize', '6M'],
  h264_amf: ['-quality', 'speed', '-rc', 'vbr_peak', '-b:v', '4M', '-maxrate', '6M'],
  h264_qsv: ['-preset', 'veryfast', '-b:v', '4M'],
  // без -hw_encoding: на ПК с NVIDIA он выбирает чужой аппаратный модуль и запись не начинается
  h264_mf: ['-b:v', '4M'],
  libx264: ['-preset', 'ultrafast', '-tune', 'zerolatency', '-crf', '28', '-threads', '2'],
};

const DEFAULTS = { record: false, background: true, interval: 15, keep: 20, quality: 720, length: 15 };
const CHOICES = { interval: [5, 10, 15, 20, 30], keep: [10, 15, 20, 30], quality: [720, 1080], length: [10, 15, 20] };
const FIRST_CLIP_MS = 3 * 60 * 1000; // первый ролик — после 3 минут активной игры, когда игрок уже в деле
const MIN_SECONDS = 6; // ролик короче (игрок свернул игру) не сохраняется

// Буфер моментов: видеокарта непрерывно пишет окно игры кусками по 2 с в кольцо из 15 файлов (~30 с).
// Кадр идёт с экрана сразу в кодировщик видеокарты (без копирования в память) — ~1% одного ядра процессора.
// Так в ролик достижения попадают секунды ДО него. Только NVENC/AMF и один монитор; иначе ролик пишется после события.
const ZERO_COPY = ['h264_nvenc', 'h264_amf'];
const SEG_SECONDS = 2;
const SEG_WRAP = 15;
const MOMENT_AFTER = 4; // секунд после события в ролике (всплывающее «Достижение получено» видно ~5 с)
const MOMENT_COOLDOWN_MS = 45000; // не чаще одного ролика-момента в 45 с: серия достижений подряд — один ролик

/** Настройки камеры: только известные значения. */
function normalizeMemories(m = {}) {
  const out = { record: m?.record === true, background: m?.background !== false, moments: m?.moments !== false, deaths: m?.deaths !== false };
  for (const [k, list] of Object.entries(CHOICES)) out[k] = list.includes(m?.[k]) ? m[k] : DEFAULTS[k];
  return out;
}

/** Самая новая стабильная ветка FFmpeg из списка хешей выпуска. */
function pickFfmpeg(checksums) {
  let best = null;
  for (const line of String(checksums || '').split(/\r?\n/)) {
    const m = /^([0-9a-f]{64})\s+\*?(\S+)$/.exec(line.trim());
    const v = m && FF_ASSET.exec(m[2]);
    if (!v) continue;
    const ver = Number(v[1]) * 1000 + Number(v[2]);
    if (!best || ver > best.ver) best = { ver, name: m[2], sha256: m[1], url: FF_BASE + m[2] };
  }
  return best;
}

const even = (n) => Math.max(2, Math.floor(n / 2) * 2);

// Windows не завершает дочерние процессы вместе с лаунчером: если он упадёт во время буфера моментов,
// FFmpeg писал бы экран до перезагрузки. Живые процессы записи гасятся при любом выходе лаунчера,
// а сам буфер ограничен часом (дальше перезапускается) — так даже «сирота» не живёт долго.
const LIVE_PROCS = new Set();
const BUFFER_MAX_SECONDS = 3600;
process.on('exit', () => {
  for (const p of LIVE_PROCS) {
    try {
      p.kill();
    } catch {}
  }
});
function track(p) {
  LIVE_PROCS.add(p);
  p.on?.('close', () => LIVE_PROCS.delete(p));
  return p;
}

/**
 * Аргументы FFmpeg для записи области экрана (клиентской области окна игры).
 * ddagrab (Desktop Duplication, видеокарта) — при одном мониторе: смещения считаются от его угла;
 * gdigrab — запасной путь, смещения от угла виртуального экрана.
 */
/** Видимая часть окна на экране: окно частично за краем — пишем только то, что видно. Размеры чётные. */
function region(rect, screens) {
  const scr = screens || { left: 0, top: 0, width: rect.x + rect.width, height: rect.y + rect.height };
  const x0 = Math.max(rect.x, scr.left);
  const y0 = Math.max(rect.y, scr.top);
  const x1 = Math.min(rect.x + rect.width, scr.left + scr.width);
  const y1 = Math.min(rect.y + rect.height, scr.top + scr.height);
  return { x0, y0, w: even(x1 - x0), h: even(y1 - y0), ox: x0 - scr.left, oy: y0 - scr.top };
}

/** Буфер моментов: ddagrab → кодировщик видеокарты напрямую, кольцо файлов .ts и их список (готовые куски). */
function bufferArgs({ encoder, rect, screens, dir }) {
  const { w, h, ox, oy } = region(rect, screens);
  return [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `ddagrab=output_idx=0:framerate=30:draw_mouse=0:offset_x=${ox}:offset_y=${oy}:video_size=${w}x${h}`,
    '-t', String(BUFFER_MAX_SECONDS), '-an', '-c:v', encoder, ...(ENCODER_OPTS[encoder] || []),
    // ключевой кадр каждые 2 с — куски режутся ровно по ним и склеиваются без перекодирования
    '-g', String(SEG_SECONDS * 30), ...(encoder === 'h264_nvenc' ? ['-forced-idr', '1'] : []),
    '-f', 'segment', '-segment_time', String(SEG_SECONDS), '-segment_wrap', String(SEG_WRAP), '-reset_timestamps', '1', '-segment_format', 'mpegts',
    '-segment_list', path.join(dir, 'list.csv'), '-segment_list_type', 'csv', '-segment_list_size', String(SEG_WRAP),
    path.join(dir, 'buf%02d.ts'),
  ];
}

function captureArgs({ grabber, encoder, rect, screens, seconds, quality, out }) {
  const { x0, y0, w, h, ox, oy } = region(rect, screens);
  const height = Math.min(quality, h);
  const scale = `scale=-2:${even(height)}:flags=bilinear,format=yuv420p`;
  const input =
    grabber === 'ddagrab'
      ? ['-f', 'lavfi', '-i', `ddagrab=output_idx=0:framerate=30:draw_mouse=0:offset_x=${ox}:offset_y=${oy}:video_size=${w}x${h}`]
      : ['-f', 'gdigrab', '-framerate', '30', '-draw_mouse', '0', '-offset_x', String(x0), '-offset_y', String(y0), '-video_size', `${w}x${h}`, '-i', 'desktop'];
  const vf = grabber === 'ddagrab' ? `hwdownload,format=bgra,${scale}` : scale;
  return ['-hide_banner', '-loglevel', 'error', '-y', ...input, '-t', String(seconds), '-an', '-vf', vf, '-r', '30', '-c:v', encoder, ...(ENCODER_OPTS[encoder] || []), '-movflags', '+faststart', out];
}

class Memories extends EventEmitter {
  /**
   * opts: { settings: async () => настройки камеры, bundled?: папка FFmpeg из установщика,
   *         window?: {foreground, screens, available}, spawn?, tickMs? }
   */
  constructor(root, opts = {}) {
    super();
    this.root = root;
    this.dir = path.join(root, 'memories');
    this.ffDir = path.join(root, 'ffmpeg');
    this.bundledDir = opts.bundled || null;
    this.indexFile = path.join(this.dir, 'index.json');
    this.stateFile = path.join(this.ffDir, 'state.json');
    this.getSettings = opts.settings || (async () => normalizeMemories());
    this.win = opts.window || gamewindow;
    this.spawn = opts.spawn || childProcess.spawn;
    this.tickMs = opts.tickMs || 5000;
    this.guardMs = opts.guardMs || 1000; // как часто во время записи проверять, что окно игры ещё активно
    this.retryMs = opts.retryMs ?? 2000;
    this.cutDelayMs = opts.cutDelayMs ?? null; // для тестов: сколько ждать перед вырезкой из буфера
    this.game = null; // {pid, profileId, profileName, level(), activeMs, nextAt, failures}
    this.recording = null; // {proc, started, stop()}
    this.buffer = null; // буфер моментов {proc, rect, dir, started, stopped}
    this.saving = false; // идёт вырезка ролика из буфера
    this.installing = null;
    this.lastError = null;
    this.lastClip = null;
    this.timer = null;
    this.write = Promise.resolve();
  }

  supported() {
    return process.platform === 'win32' && this.win.available();
  }
  /** FFmpeg из установщика лаунчера (основной путь) или скачанный отдельно (старые версии, разработка). */
  bundled() {
    return !!this.bundledDir && fs.existsSync(path.join(this.bundledDir, 'ffmpeg.exe'));
  }
  ffmpeg() {
    if (this.bundled()) return path.join(this.bundledDir, 'ffmpeg.exe');
    return path.join(this.ffDir, 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  }
  installed() {
    return fs.existsSync(this.ffmpeg());
  }
  /** Какой именно FFmpeg проверяли: после обновления лаунчера (новый FFmpeg) кодировщик ищется заново. */
  ffmpegSig() {
    try {
      const st = fs.statSync(this.ffmpeg());
      return `${this.ffmpeg()}|${st.size}|${Math.round(st.mtimeMs)}`;
    } catch {
      return null;
    }
  }
  async ffState() {
    return (await readJson(this.stateFile)) || {};
  }

  async status() {
    const s = await this.getSettings();
    const st = await this.ffState();
    const { clips } = await this.index();
    const g = this.game;
    return {
      supported: this.supported(),
      installed: this.installed(),
      bundled: this.bundled(),
      installing: this.installing,
      settings: s,
      encoder: st.encoder || null,
      encoderLabel: ENCODER_LABEL[st.encoder] || null,
      grabber: st.grabber || null,
      recording: !!this.recording || this.saving,
      // буфер моментов идёт прямо сейчас (окно игры пишется по кругу, последние ~30 с)
      buffering: !!this.buffer,
      // как ловятся моменты на этом ПК: с секундами до события (буфер) или только после
      momentsMode: !this.installed() ? null : ZERO_COPY.includes(st.encoder) && st.zeroCopy !== false && this.win.screens?.()?.monitors === 1 ? 'buffer' : st.encoder ? 'after' : null,
      watching: !!(g && s.record && this.installed()),
      clips: clips.length,
      // через сколько минут активной игры следующий ролик (только пока игра идёт)
      nextInMin: g && s.record ? Math.max(0, Math.ceil((g.nextAt - g.activeMs) / 60000)) : null,
      lastError: this.lastError,
      lastClip: this.lastClip,
    };
  }
  async notify() {
    this.emit('state', await this.status().catch(() => null));
  }

  // ---------- FFmpeg ----------
  async plan() {
    const r = await http.request(FF_BASE + 'checksums.sha256', { retries: 2 });
    const pick = pickFfmpeg(await r.text());
    if (!pick) throw Object.assign(new Error('Не нашёл сборку FFmpeg для Windows.'), { action: 'Попробуй позже.' });
    // размер — из заголовка ответа на запрос одного байта, без API GitHub
    try {
      const h = await http.request(pick.url, { retries: 1, headers: { Range: 'bytes=0-0' } });
      pick.size = Number(/\/(\d+)$/.exec(h.headers.get('content-range') || '')?.[1]) || null;
      await h.body?.cancel?.().catch(() => {});
    } catch {
      pick.size = null;
    }
    return pick;
  }

  /** Скачать FFmpeg (хеш SHA-256 из выпуска), распаковать только bin/ без ffplay, найти рабочий кодировщик. */
  async install({ onProgress, signal } = {}) {
    if (!this.supported()) throw new Error('Запись игры пока есть только в Windows.');
    if (this.installing) throw new Error('FFmpeg уже скачивается.');
    this.installing = { done: 0, total: null };
    try {
      const plan = await this.plan();
      this.installing.total = plan.size;
      const zip = path.join(this.ffDir, 'ffmpeg.zip');
      await fsp.mkdir(this.ffDir, { recursive: true });
      await http.download(plan.url, zip + '.unverified', {
        signal,
        onBytes: (n) => {
          this.installing.done += n;
          onProgress?.({ done: this.installing.done, total: plan.size });
        },
      });
      if ((await http.hashFile(zip + '.unverified', 'sha256')) !== plan.sha256) {
        await fsp.rm(zip + '.unverified', { force: true });
        throw new Error('Архив FFmpeg повреждён (хеш не совпал). Попробуй ещё раз.');
      }
      onProgress?.({ done: this.installing.done, total: plan.size, phase: 'extract' });
      const bin = path.join(this.ffDir, 'bin');
      await fsp.rm(bin, { recursive: true, force: true });
      await fsp.mkdir(bin, { recursive: true });
      const az = new AdmZip(zip + '.unverified');
      for (const e of az.getEntries()) {
        const m = /^[^/]+\/bin\/([\w.-]+\.(?:exe|dll))$/i.exec(e.entryName);
        if (!m || /^ffplay/i.test(m[1])) continue;
        await fsp.writeFile(path.join(bin, m[1]), e.getData());
      }
      await fsp.rm(zip + '.unverified', { force: true });
      if (!this.installed()) throw new Error('В архиве FFmpeg не оказалось ffmpeg.exe.');
      await writeJson(this.stateFile, { version: plan.name });
      onProgress?.({ done: this.installing.done, total: plan.size, phase: 'probe' });
      await this.probe();
      return this.status();
    } finally {
      this.installing = null;
      this.notify();
    }
  }

  async uninstall() {
    if (this.bundled()) throw new Error('FFmpeg входит в лаунчер — удалять его не нужно.');
    if (this.recording) this.recording.stop();
    await fsp.rm(this.ffDir, { recursive: true, force: true });
    await this.notify();
  }

  run(args, { timeoutMs = 20000 } = {}) {
    return new Promise((resolve) => {
      let err = '';
      let p;
      try {
        p = this.spawn(this.ffmpeg(), args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
      } catch (e) {
        return resolve({ code: -1, err: e.message });
      }
      const t = setTimeout(() => p.kill(), timeoutMs);
      p.stderr?.on('data', (d) => (err = (err + d).slice(-2000)));
      p.on('error', (e) => (err += e.message));
      p.on('close', (code) => {
        clearTimeout(t);
        resolve({ code, err });
      });
    });
  }

  /** Первый кодировщик, который реально кодирует на этом ПК (у NVENC/AMF/QSV бывает драйвер без поддержки). */
  async probe() {
    let encoder = null;
    for (const e of ENCODERS) {
      // с теми же настройками, что и настоящая запись: иначе проба проходит, а запись падает
      const r = await this.run(['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=1280x720:r=30', '-frames:v', '15', '-vf', 'format=yuv420p', '-c:v', e, ...ENCODER_OPTS[e], '-f', 'null', '-']);
      if (r.code === 0) {
        encoder = e;
        break;
      }
    }
    const st = await this.ffState();
    st.encoder = encoder;
    st.exe = this.ffmpegSig();
    delete st.grabber; // способ захвата выберется заново при первой записи
    await writeJson(this.stateFile, st);
    if (!encoder) throw new Error('FFmpeg не смог закодировать видео ни одним способом.');
    return encoder;
  }

  // ---------- ролики ----------
  async index() {
    const d = (await readJson(this.indexFile)) || {};
    const clips = (Array.isArray(d.clips) ? d.clips : []).filter((c) => c && /^[\w-]{6,40}$/.test(c.id) && fs.existsSync(this.clipFile(c.id)));
    return { clips };
  }
  clipFile(id) {
    return path.join(this.dir, id + '.mp4');
  }
  thumbFile(id) {
    return path.join(this.dir, id + '.jpg');
  }
  change(fn) {
    const next = this.write.catch(() => {}).then(async () => {
      const idx = await this.index();
      const r = await fn(idx);
      await writeJson(this.indexFile, idx);
      return r;
    });
    this.write = next;
    return next;
  }
  async list() {
    const { clips } = await this.index();
    return clips.map((c) => ({ ...c, file: this.clipFile(c.id), thumb: fs.existsSync(this.thumbFile(c.id)) ? this.thumbFile(c.id) : null }));
  }
  async remove(id) {
    await this.change(async (idx) => {
      idx.clips = idx.clips.filter((c) => c.id !== id);
    });
    await fsp.rm(this.clipFile(id), { force: true });
    await fsp.rm(this.thumbFile(id), { force: true });
    await this.notify();
    return true;
  }
  async pin(id, v) {
    await this.change(async (idx) => {
      const c = idx.clips.find((x) => x.id === id);
      if (c) c.pinned = v === true;
    });
    return true;
  }
  /** Оставить не больше keep роликов: удаляются самые старые незакреплённые. */
  async rotate(keep) {
    const gone = await this.change(async (idx) => {
      const drop = [];
      const loose = idx.clips.filter((c) => !c.pinned).sort((a, b) => String(a.at).localeCompare(String(b.at)));
      while (idx.clips.length > keep && loose.length) {
        const c = loose.shift();
        idx.clips = idx.clips.filter((x) => x !== c);
        drop.push(c.id);
      }
      return drop;
    });
    for (const id of gone) {
      await fsp.rm(this.clipFile(id), { force: true }).catch(() => {});
      await fsp.rm(this.thumbFile(id), { force: true }).catch(() => {});
    }
    return gone;
  }

  // ---------- игра ----------
  /** Игра запущена: pid процесса Java (окно игры принадлежит ему), сборка и текущий мир. */
  gameStarted({ pid, profileId, profileName, level }) {
    this.gameStopped();
    this.game = { pid, profileId, profileName, level: level || (() => null), activeMs: 0, nextAt: FIRST_CLIP_MS, failures: 0 };
    this.timer = setInterval(() => this.tick().catch(() => {}), this.tickMs);
    this.timer.unref?.();
    this.notify();
  }
  gameStopped() {
    clearInterval(this.timer);
    this.timer = null;
    this.recording?.stop();
    this.stopBuffer();
    if (this.game) {
      this.game = null;
      this.notify();
    }
  }

  /** Окно игры активно, не свёрнуто и достаточно большое. */
  gameRect() {
    const fg = this.win.foreground();
    if (!this.game || !fg || fg.pid !== this.game.pid || fg.minimized || !fg.rect) return null;
    return fg.rect.width >= 320 && fg.rect.height >= 240 ? fg.rect : null;
  }

  async tick() {
    // такт идёт раз в 5 с, а запись ролика — до 20 с: второй такт не начинается, пока не закончился первый
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.tickNow();
    } finally {
      this.ticking = false;
    }
  }

  async tickNow() {
    const g = this.game;
    if (!g || this.installing) return;
    const s = await this.getSettings();
    if (!s.record || !this.installed()) return this.stopBuffer();
    const rect = this.gameRect();
    // время считается только реальной игрой в мире: не в меню, не при свёрнутом окне
    const active = !!(rect && g.level());
    await this.syncBuffer(active ? rect : null, s);
    if (!active || this.recording || this.saving) return;
    g.activeMs += this.tickMs;
    if (g.activeMs < g.nextAt || g.failures >= 3) return;
    // буфер идёт, но в нём ещё мало кадров — ролик по расписанию чуть позже, из буфера
    if (this.buffer && !this.bufferReady(s.length)) return;
    g.nextAt = g.activeMs + s.interval * 60000;
    const meta = { pid: g.profileId, profile: g.profileName, world: g.level() };
    const r = this.buffer ? await this.saveFromBuffer({ seconds: s.length, after: 0, meta }) : await this.record({ rect, seconds: s.length, quality: s.quality, watch: true, meta });
    if (!r.ok && !r.short) g.failures++;
  }

  // ---------- моменты ----------
  /** Можно ли держать буфер: кодировщик видеокарты принимает кадры напрямую, один монитор, способ не отказал. */
  async canBuffer() {
    let st = await this.ffState();
    // кодировщик ещё не искали (или FFmpeg обновился) — ищем сейчас, это ~1 с
    if ((!st.encoder || st.exe !== this.ffmpegSig()) && !this.probing) {
      this.probing = true;
      await this.probe().catch(() => {});
      this.probing = false;
      st = await this.ffState();
    }
    return ZERO_COPY.includes(st.encoder) && st.exe === this.ffmpegSig() && st.zeroCopy !== false && this.win.screens?.()?.monitors === 1;
  }

  /** Буфер идёт, пока игрок в мире и окно игры активно; окно сдвинули — буфер перезапускается под новое место. */
  async syncBuffer(rect, s) {
    const want = rect && (s.moments || s.deaths) && (await this.canBuffer());
    if (!want) return this.stopBuffer();
    const b = this.buffer;
    if (b && b.rect.x === rect.x && b.rect.y === rect.y && b.rect.width === rect.width && b.rect.height === rect.height) return;
    this.stopBuffer();
    await this.startBuffer(rect);
  }

  async startBuffer(rect) {
    const st = await this.ffState();
    const dir = path.join(this.dir, 'buffer');
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    await fsp.mkdir(dir, { recursive: true });
    let p;
    try {
      p = track(this.spawn(this.ffmpeg(), bufferArgs({ encoder: st.encoder, rect, screens: this.win.screens?.(), dir }), { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] }));
    } catch (e) {
      this.lastError = e.message;
      return;
    }
    try {
      if (p.pid) os.setPriority(p.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
    } catch {}
    const b = { proc: p, rect, dir, started: Date.now(), stopped: false, err: '' };
    this.buffer = b;
    p.stderr?.on('data', (d) => (b.err = (b.err + d).slice(-1000)));
    p.on('error', (e) => (b.err += e.message));
    p.on('close', async () => {
      if (this.buffer === b) this.buffer = null;
      // сразу упал сам — значит, этот кодировщик не берёт кадры напрямую: дальше ролики пишутся после события
      if (!b.stopped && Date.now() - b.started < 5000) {
        this.lastError = 'Буфер моментов не запустился: ' + (b.err.trim().split('\n').pop() || 'кодировщик не принимает кадры видеокарты');
        await writeJson(this.stateFile, { ...(await this.ffState()), zeroCopy: false });
      }
      this.notify();
    });
    this.notify();
  }

  stopBuffer() {
    const b = this.buffer;
    if (!b) return;
    this.buffer = null;
    b.stopped = true;
    try {
      b.proc.stdin.write('q');
    } catch {}
    setTimeout(() => b.proc.kill(), 3000).unref?.();
    this.notify();
  }

  bufferReady(seconds) {
    return !!this.buffer && Date.now() - this.buffer.started >= (seconds + SEG_SECONDS) * 1000;
  }

  /** Готовые куски буфера по порядку записи (из списка, который ведёт FFmpeg: недописанный кусок туда не попадает). */
  async bufferSegments(dir) {
    const csv = await fsp.readFile(path.join(dir, 'list.csv'), 'utf8').catch(() => '');
    return csv
      .split(/\r?\n/)
      .map((l) => l.split(',')[0])
      .filter((n) => /^buf\d+\.ts$/.test(n || ''));
  }

  /**
   * Ролик из буфера: последние seconds секунд, из них after — после события (ждём, пока они запишутся).
   * Куски сначала копируются (кольцо перезаписывает старые), потом склеиваются без перекодирования.
   */
  async saveFromBuffer({ seconds, after, meta }) {
    const b = this.buffer;
    if (!b || this.saving) return { ok: false, error: 'Буфер не идёт.' };
    this.saving = true;
    const dir = b.dir;
    try {
      await new Promise((r) => setTimeout(r, this.cutDelayMs ?? (after + SEG_SECONDS) * 1000 + 300));
      const names = (await this.bufferSegments(dir)).slice(-Math.ceil(seconds / SEG_SECONDS));
      if (names.length < 2) return { ok: false, short: true };
      const id = Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
      const cut = path.join(this.dir, 'cut-' + id);
      await fsp.mkdir(cut, { recursive: true });
      try {
        for (const n of names) await fsp.copyFile(path.join(dir, n), path.join(cut, n));
        const list = names.map((n) => `file '${path.join(cut, n).replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n');
        await fsp.writeFile(path.join(cut, 'list.txt'), list);
        const r = await this.run(['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', path.join(cut, 'list.txt'), '-c', 'copy', '-movflags', '+faststart', this.clipFile(id)]);
        const size = fs.existsSync(this.clipFile(id)) ? fs.statSync(this.clipFile(id)).size : 0;
        if (r.code !== 0 || size < 10000) {
          await fsp.rm(this.clipFile(id), { force: true });
          this.lastError = 'Ролик из буфера не склеился: ' + (r.err.trim().split('\n').pop() || `код ${r.code}`);
          return { ok: false, error: this.lastError };
        }
        return { ok: true, clip: await this.addClip(id, names.length * SEG_SECONDS, meta, (await this.ffState()).encoder) };
      } finally {
        await fsp.rm(cut, { recursive: true, force: true }).catch(() => {});
      }
    } finally {
      this.saving = false;
      this.notify();
    }
  }

  /**
   * Достижение, испытание, цель или смерть игрока (из журнала игры). С буфером в ролик попадают секунды до события,
   * без него ролик пишется сразу после. Серия событий подряд даёт один ролик.
   */
  async moment(m) {
    const g = this.game;
    if (!g) return { ok: false };
    const s = await this.getSettings();
    if (!s.record || !this.installed() || !(m.kind === 'death' ? s.deaths : s.moments)) return { ok: false };
    if (Date.now() - (this.lastMomentAt || 0) < MOMENT_COOLDOWN_MS) return { ok: false, cooldown: true };
    // ролик ещё сохраняется — этот момент в него и так попадёт; паузу не тратим
    if (this.saving || this.recording) return { ok: false, busy: true };
    this.lastMomentAt = Date.now();
    // ролик по расписанию сразу после момента не нужен
    g.nextAt = Math.max(g.nextAt, g.activeMs + 2 * 60000);
    const meta = { pid: g.profileId, profile: g.profileName, world: g.level(), moment: { kind: m.kind, title: String(m.title || '').slice(0, 80) } };
    if (this.buffer && !this.saving) return this.saveFromBuffer({ seconds: s.length, after: MOMENT_AFTER, meta });
    const rect = this.gameRect();
    if (!rect || this.recording || this.saving) return { ok: false };
    return this.record({ rect, seconds: s.length, quality: s.quality, watch: true, meta });
  }

  /** Превью, запись в список роликов, ротация. */
  async addClip(id, seconds, meta, encoder) {
    await this.run(['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(Math.min(3, seconds / 2)), '-i', this.clipFile(id), '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '4', this.thumbFile(id)]);
    const clip = { id, at: new Date().toISOString(), seconds: Math.round(seconds), profileId: meta.pid || null, profile: meta.profile || '', world: meta.world || '', encoder, ...(meta.moment ? { moment: meta.moment } : {}) };
    await this.change(async (idx) => void idx.clips.push(clip));
    const s = await this.getSettings();
    await this.rotate(s.keep);
    this.lastError = null;
    this.lastClip = clip.at;
    this.notify();
    return clip;
  }

  /**
   * Записать ролик. watch — останавливать запись, если окно игры потеряло фокус или сдвинулось.
   * test — проверочная запись (в галерею не попадает).
   */
  async record({ rect, seconds, quality, watch = false, test = false, meta = {} }) {
    if (this.recording) return { ok: false, error: 'Запись уже идёт.' };
    let st = await this.ffState();
    if (!st.encoder || st.exe !== this.ffmpegSig()) {
      await this.probe();
      st = await this.ffState();
    }
    const encoder = st.encoder;
    const screens = this.win.screens?.() || null;
    // ddagrab — только при одном мониторе: номер монитора DXGI и Windows не всегда совпадают
    const grabbers = st.grabber ? [st.grabber] : screens?.monitors === 1 ? ['ddagrab', 'gdigrab'] : ['gdigrab'];
    const id = test ? 'test' : Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
    await fsp.mkdir(this.dir, { recursive: true });
    const out = test ? path.join(this.dir, 'test.mp4') : this.clipFile(id);
    let result = { ok: false, error: 'Запись не началась.' };
    // при самом первом запуске антивирус проверяет свежие библиотеки FFmpeg, и захват иногда не успевает
    // получить кадры — тогда ещё одна попытка тем же способом после паузы
    const attempts = [...grabbers, grabbers[0]];
    for (let i = 0; i < attempts.length; i++) {
      const grabber = attempts[i];
      if (i === grabbers.length) await new Promise((r) => setTimeout(r, this.retryMs));
      result = await this.capture({ grabber, encoder, rect, screens, seconds, quality, out, watch });
      if (result.ok || result.short) {
        if (st.grabber !== grabber) await writeJson(this.stateFile, { ...(await this.ffState()), grabber });
        break;
      }
    }
    if (!result.ok) {
      await fsp.rm(out, { force: true }).catch(() => {});
      if (!result.short) this.lastError = result.error;
      this.notify();
      return result;
    }
    this.lastError = null;
    if (test) {
      const thumb = path.join(this.dir, 'test.jpg');
      await this.run(['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(Math.min(3, result.seconds / 2)), '-i', out, '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '4', thumb]);
      return { ...result, file: out, thumb: fs.existsSync(thumb) ? thumb : null, encoder, encoderLabel: ENCODER_LABEL[encoder] };
    }
    return { ...result, clip: await this.addClip(id, result.seconds, meta, encoder) };
  }

  capture({ grabber, encoder, rect, screens, seconds, quality, out, watch }) {
    return new Promise((resolve) => {
      const args = captureArgs({ grabber, encoder, rect, screens, seconds, quality, out });
      const started = Date.now();
      let err = '';
      let stoppedEarly = false;
      let p;
      try {
        p = track(this.spawn(this.ffmpeg(), args, { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] }));
      } catch (e) {
        return resolve({ ok: false, error: e.message });
      }
      // игра важнее записи: FFmpeg получает приоритет ниже обычного
      try {
        if (p.pid) os.setPriority(p.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
      } catch {}
      const stop = () => {
        if (stoppedEarly) return;
        stoppedEarly = true;
        // «q» — штатная остановка: FFmpeg допишет файл, и он останется целым
        try {
          p.stdin.write('q');
        } catch {}
        setTimeout(() => p.kill(), 4000).unref?.();
      };
      this.recording = { proc: p, started, stop };
      this.notify();
      const guard = watch
        ? setInterval(() => {
            const r = this.gameRect();
            if (!r || r.x !== rect.x || r.y !== rect.y || r.width !== rect.width || r.height !== rect.height) stop();
          }, this.guardMs)
        : null;
      const hard = setTimeout(stop, (seconds + 15) * 1000);
      p.stderr?.on('data', (d) => (err = (err + d).slice(-2000)));
      p.on('error', (e) => (err += e.message));
      p.on('close', (code) => {
        clearInterval(guard);
        clearTimeout(hard);
        this.recording = null;
        const secs = Math.min(seconds, (Date.now() - started) / 1000);
        let size = 0;
        try {
          size = fs.statSync(out).size;
        } catch {}
        if (stoppedEarly && secs < MIN_SECONDS) return resolve({ ok: false, short: true, seconds: secs });
        if ((code !== 0 && !stoppedEarly) || size < 10000) return resolve({ ok: false, error: (err.trim().split('\n').pop() || `FFmpeg завершился с кодом ${code}`).slice(0, 300) });
        resolve({ ok: true, seconds: secs, grabber, size });
      });
    });
  }

  /**
   * «Фильм сессии»: ролики одной сессии (сборка и время) подряд в один файл 1280×720. Ролики бывают разного
   * размера (по расписанию — 720p, моменты из буфера — размер окна), поэтому кадр приводится к одному с полями.
   */
  async film({ profileId, from, to }) {
    if (!this.installed()) throw new Error('Нет FFmpeg для склейки.');
    const t0 = Date.parse(from) - 60000;
    const t1 = Date.parse(to) + 60000;
    if (!Number.isFinite(t0) || !Number.isFinite(t1)) throw new Error('Неизвестное время сессии.');
    const clips = (await this.list()).filter((c) => c.profileId === profileId && Date.parse(c.at) >= t0 && Date.parse(c.at) <= t1).sort((a, b) => a.at.localeCompare(b.at));
    if (clips.length < 2) throw new Error('Для фильма нужно хотя бы два ролика из этой сессии.');
    let st = await this.ffState();
    if (!st.encoder || st.exe !== this.ffmpegSig()) {
      await this.probe();
      st = await this.ffState();
    }
    const dir = path.join(this.dir, 'films');
    await fsp.mkdir(dir, { recursive: true });
    const out = path.join(dir, `film-${Date.parse(to).toString(36)}-${profileId.replace(/[^\w-]/g, '').slice(0, 20)}.mp4`);
    const parts = clips.map((c, i) => `[${i}:v]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p[v${i}]`);
    const filter = `${parts.join(';')};${clips.map((c, i) => `[v${i}]`).join('')}concat=n=${clips.length}:v=1:a=0[out]`;
    const args = ['-hide_banner', '-loglevel', 'error', '-y', ...clips.flatMap((c) => ['-i', c.file]), '-filter_complex', filter, '-map', '[out]', '-an', '-c:v', st.encoder, ...(ENCODER_OPTS[st.encoder] || []), '-movflags', '+faststart', out];
    const r = await this.run(args, { timeoutMs: 10 * 60000 });
    if (r.code !== 0 || !fs.existsSync(out)) throw new Error('Фильм не склеился: ' + (r.err.trim().split('\n').pop() || `код ${r.code}`));
    return { file: out, clips: clips.length, seconds: clips.reduce((a, c) => a + (c.seconds || 0), 0) };
  }

  /** Проверка камеры из лаунчера: 4 секунды активного окна (это окно самого лаунчера). */
  async test(ownPid) {
    if (!this.installed()) throw new Error('Сначала скачай FFmpeg.');
    const fg = this.win.foreground();
    if (!fg?.rect || fg.pid !== ownPid) throw new Error('Окно лаунчера должно быть активным во время проверки.');
    const r = await this.record({ rect: fg.rect, seconds: 4, quality: 720, test: true });
    if (!r.ok) throw new Error('Запись не получилась: ' + (r.error || 'неизвестная ошибка'));
    return r;
  }
}

module.exports = { Memories, normalizeMemories, pickFfmpeg, captureArgs, bufferArgs, ENCODERS, ENCODER_LABEL, CHOICES };
