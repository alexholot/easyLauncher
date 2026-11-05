'use strict';
// «Почему тормозило»: разбор прошедшего запуска. FPS лаунчер не видит — судит по тому, что видно честно:
// журнал игры (отставание мира, нехватка памяти, время загрузки), реальная память процесса Java,
// состав сборки (есть ли моды оптимизации) и дальность прорисовки из options.txt.
const fs = require('fs');
const path = require('path');

// моды оптимизации по загрузчику: любой из группы закрывает роль
const PERF_MODS = {
  fabric: [['sodium'], ['lithium'], ['ferrite-core']],
  quilt: [['sodium'], ['lithium'], ['ferrite-core']],
  forge: [['embeddium', 'rubidium'], ['ferrite-core'], ['modernfix']],
  neoforge: [['sodium', 'embeddium'], ['ferrite-core'], ['modernfix']],
};
const PERF_NAMES = { sodium: 'Sodium', embeddium: 'Embeddium', rubidium: 'Rubidium', lithium: 'Lithium', 'ferrite-core': 'FerriteCore', modernfix: 'ModernFix' };

const RE = {
  lag: /Can't keep up! Is the server overloaded\? Running (\d+)ms or (\d+) ticks behind/,
  oom: /java\.lang\.OutOfMemoryError/,
  loaded: /Sound engine started|Created: \d+x\d+x\d+ minecraft:textures\/atlas\/blocks/,
};

class PerfWatch {
  /** opts: {rss(pid) → МБ, now?} */
  constructor(opts = {}) {
    this.rss = opts.rss || (() => 0);
    this.now = opts.now || Date.now;
    this.run = null;
    this.timer = null;
  }

  start({ pid, profileId, ramGb, loader, mods = [], gameDir, totalRamGb }) {
    this.stopTimer();
    this.run = { pid, profileId, ramGb, loader, slugs: mods.filter((m) => m.enabled !== false).map((m) => String(m.slug || '').toLowerCase()), mods: mods.length, gameDir, totalRamGb, started: this.now(), loadMs: null, lag: 0, maxLagMs: 0, oom: false, peakRss: 0 };
    this.sample();
    this.timer = setInterval(() => this.sample(), 15000);
    this.timer.unref?.();
  }
  stopTimer() {
    clearInterval(this.timer);
    this.timer = null;
  }
  /** Замер памяти процесса игры (tasklist/ps — асинхронно; ответ может прийти уже после конца запуска). */
  sample() {
    const r = this.run;
    if (!r) return Promise.resolve();
    return Promise.resolve(this.rss(r.pid))
      .then((mb) => {
        if (Number(mb) > r.peakRss) r.peakRss = Number(mb);
      })
      .catch(() => {});
  }
  feed(line) {
    const r = this.run;
    if (!r) return;
    let m;
    if ((m = RE.lag.exec(line))) {
      r.lag++;
      r.maxLagMs = Math.max(r.maxLagMs, Number(m[1]));
    } else if (RE.oom.test(line)) r.oom = true;
    else if (r.loadMs == null && RE.loaded.test(line)) r.loadMs = this.now() - r.started;
  }

  /** Конец запуска: отчёт с причинами и тем, что можно сделать одной кнопкой. null — разбирать нечего. */
  stop({ seconds = 0 } = {}) {
    this.stopTimer();
    const r = this.run;
    this.run = null;
    if (!r || seconds < 60) return null; // меньше минуты — не о чем судить
    const issues = [];
    const heapMb = r.ramGb * 1024;
    const maxRam = Math.max(2, Math.min(16, (r.totalRamGb || 8) - 4));
    const moreRam = Math.min(maxRam, r.ramGb + (r.mods > 80 ? 4 : 2));
    if (r.oom) issues.push({ id: 'oom', level: 'bad', text: `Игре не хватило памяти: в журнале «OutOfMemoryError». Сейчас выделено ${r.ramGb} ГБ.`, fix: moreRam > r.ramGb ? { type: 'ram', value: moreRam, label: `Дать ${moreRam} ГБ` } : null });
    else if (r.peakRss && r.peakRss > heapMb * 1.15 && moreRam > r.ramGb)
      issues.push({ id: 'ram', level: 'warn', text: `Память впритык: игра занимала до ${(r.peakRss / 1024).toFixed(1)} ГБ при выделенных ${r.ramGb} ГБ — Java часто чистит память, отсюда рывки.`, fix: { type: 'ram', value: moreRam, label: `Дать ${moreRam} ГБ` } });
    if (r.lag >= 3 || r.maxLagMs >= 2000)
      issues.push({ id: 'lag', level: r.maxLagMs >= 5000 ? 'bad' : 'warn', text: `Мир не успевал считаться: ${r.lag} ${r.lag === 1 ? 'раз' : 'раз(а)'} отставал, до ${(r.maxLagMs / 1000).toFixed(1)} с. Это мобы, фермы, редстоун и генерация новых чанков.`, fix: { type: 'simulation', value: 8, label: 'Дальность симуляции 8' } });
    const groups = PERF_MODS[r.loader];
    if (groups) {
      const missing = groups.filter((g) => !g.some((s) => r.slugs.includes(s))).map((g) => PERF_NAMES[g[0]] || g[0]);
      if (missing.length && (r.lag || r.mods >= 20 || issues.length))
        issues.push({ id: 'mods', level: 'warn', text: `Нет модов оптимизации: ${missing.join(', ')}. Они дают больше FPS и меньше рывков, игру не меняют.`, fix: { type: 'perfmods', label: 'Добавить моды на FPS' } });
    }
    const render = renderDistance(r.gameDir);
    if (render && render > 16 && (r.lag || issues.some((i) => i.id === 'ram' || i.id === 'oom')))
      issues.push({ id: 'render', level: 'warn', text: `Дальность прорисовки ${render} чанков — для этой сборки много.`, fix: { type: 'render', value: 12, label: 'Прорисовка 12' } });
    if (r.loadMs && r.loadMs > 180000 && r.mods >= 40 && !r.slugs.includes('modernfix') && r.loader !== 'fabric' && r.loader !== 'quilt')
      issues.push({ id: 'load', level: 'info', text: `Игра загружалась ${Math.round(r.loadMs / 60000)} мин. ModernFix заметно ускоряет запуск больших сборок.`, fix: { type: 'perfmods', label: 'Добавить моды на FPS' } });
    return { at: new Date().toISOString(), profileId: r.profileId, seconds: Math.round(seconds), ramGb: r.ramGb, peakRssMb: Math.round(r.peakRss), lag: r.lag, maxLagMs: r.maxLagMs, loadMs: r.loadMs, mods: r.mods, oom: r.oom, issues };
  }
}

/** Дальность прорисовки из options.txt игры (null — файла нет). */
function renderDistance(gameDir) {
  try {
    const m = /^renderDistance:(\d+)/m.exec(fs.readFileSync(path.join(gameDir, 'options.txt'), 'utf8'));
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

module.exports = { PerfWatch, PERF_MODS, renderDistance };
