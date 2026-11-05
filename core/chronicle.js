'use strict';
// «Летопись мира»: история каждого мира, которую лаунчер ведёт сам — из журнала игры, level.dat,
// скриншотов и роликов камеры. Хранится в profiles/<pid>/chronicle.json, по папке мира.
// События: first (мир впервые открыт в лаунчере), session (сессия: время, скриншоты, где закончил),
// advancement / challenge / goal (достижения), death (смерть, место — из level.dat).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readJson, writeJson } = require('./store');
const { readWorld } = require('./worlddata');

const KINDS = ['first', 'session', 'advancement', 'challenge', 'goal', 'death', 'challenge-done'];
const MAX_EVENTS = 600; // на мир: при переполнении уходят старые сессии, достижения и смерти остаются дольше
const MC_DAY_MS = 20 * 60 * 1000; // игровые сутки — 20 минут реального времени

class Chronicle {
  constructor(store, worlds) {
    this.store = store;
    this.worlds = worlds;
    this.write = new Map(); // pid → очередь записей
  }

  file(pid) {
    return path.join(this.store.profileDir(pid), 'chronicle.json');
  }
  async data(pid) {
    const d = (await readJson(this.file(pid))) || {};
    return d && typeof d.worlds === 'object' ? d : { worlds: {} };
  }
  change(pid, fn) {
    const prev = this.write.get(pid) || Promise.resolve();
    const next = prev.catch(() => {}).then(async () => {
      const d = await this.data(pid);
      const r = await fn(d);
      await writeJson(this.file(pid), d);
      return r;
    });
    this.write.set(pid, next);
    return next;
  }

  /** Сведения о мире прямо сейчас (день, где игрок, где последняя смерть) — во всех форматах, включая 26.x. */
  async level(pid, folder) {
    try {
      // свои UUID — чтобы на сервере сессии взять свой файл игрока, а не друга
      return await readWorld(this.worlds.dir(pid, folder), { uuids: this.uuids?.() || [] });
    } catch {
      return null;
    }
  }

  async add(pid, folder, ev) {
    if (!KINDS.includes(ev.kind)) throw new Error('Неизвестное событие летописи.');
    const item = { id: Date.now().toString(36) + crypto.randomBytes(3).toString('hex'), at: new Date().toISOString(), ...ev };
    await this.change(pid, async (d) => {
      const w = (d.worlds[folder] ||= { events: [] });
      w.events.push(item);
      if (w.events.length > MAX_EVENTS) {
        const drop = w.events.findIndex((e) => e.kind === 'session') >= 0 ? w.events.findIndex((e) => e.kind === 'session') : 0;
        w.events.splice(drop, 1);
      }
    });
    return item;
  }

  async update(pid, folder, id, patch) {
    return this.change(pid, async (d) => {
      const e = d.worlds[folder]?.events.find((x) => x.id === id);
      if (e) Object.assign(e, patch);
      return e || null;
    });
  }

  async events(pid, folder) {
    const d = await this.data(pid);
    return (d.worlds[folder]?.events || []).slice();
  }

  // ---------- сессия в мире ----------
  /** Игрок вошёл в мир: запоминаем, с какого игрового дня и когда начали; первое открытие — событие. */
  async begin(pid, folder) {
    const lv = await this.level(pid, folder);
    const s = { pid, folder, startedAt: Date.now(), startDay: lv?.day ?? null, moments: [], isNew: false };
    if (!(await this.events(pid, folder)).length) {
      // для «Вызова» новый мир — нет в летописи И моложе одних игровых суток: старые миры после обновления
      // лаунчера тоже впервые попадают в летопись, но в них уже могут быть добыты алмазы
      s.isNew = !lv || lv.ticks == null || lv.ticks < 24000;
      await this.add(pid, folder, { kind: 'first', day: lv?.day ?? null, pos: lv?.player?.pos || null, dim: lv?.player?.dim || null });
    }
    return s;
  }

  /** Примерный игровой день сейчас: день на входе + прошедшие 20-минутные сутки. */
  dayNow(s) {
    return s.startDay == null ? null : s.startDay + Math.floor((Date.now() - s.startedAt) / MC_DAY_MS);
  }

  /**
   * Достижение или смерть. Место достижения — примерное: позиция игрока из последнего автосохранения
   * (раз в несколько минут). Место смерти уточняется в конце сессии по LastDeathLocation.
   */
  async moment(s, m) {
    const lv = await this.level(s.pid, s.folder);
    const ev = await this.add(s.pid, s.folder, {
      kind: m.kind,
      title: String(m.title || '').slice(0, 80),
      day: this.dayNow(s),
      pos: m.kind === 'death' ? null : lv?.player?.pos || null,
      dim: m.kind === 'death' ? null : lv?.player?.dim || null,
      approx: m.kind !== 'death',
    });
    s.moments.push(ev.id);
    return ev;
  }

  /**
   * Конец сессии: сколько играли, скриншоты, где закончил; смерть получает точное место из level.dat.
   * level.dat игра дописывает чуть позже строки «Stopping server» — ждём, пока файл обновится (до 10 с).
   */
  async end(s, { shots = [], waitMs = 10000 } = {}) {
    // в 26.x игрок и его смерть — в players/data, но level.dat переписывается при каждом сохранении
    const levelFile = path.join(this.worlds.dir(s.pid, s.folder), 'level.dat');
    const t0 = Date.now();
    const mtime = () => {
      try {
        return fs.statSync(levelFile).mtimeMs;
      } catch {
        return 0;
      }
    };
    while (Date.now() - t0 < waitMs && mtime() < s.startedAt) await new Promise((r) => setTimeout(r, 500));
    const lv = await this.level(s.pid, s.folder);
    const seconds = Math.round((Date.now() - s.startedAt) / 1000);
    if (lv?.lastDeath) {
      const evs = await this.events(s.pid, s.folder);
      const death = evs.filter((e) => s.moments.includes(e.id) && e.kind === 'death').pop();
      if (death) await this.update(s.pid, s.folder, death.id, { pos: lv.lastDeath.pos, dim: lv.lastDeath.dim, approx: false });
    }
    if (seconds < 20 && !shots.length && !s.moments.length) return null; // зашёл и сразу вышел — не событие
    return this.add(s.pid, s.folder, {
      kind: 'session',
      seconds,
      day: lv?.day ?? this.dayNow(s),
      startDay: s.startDay,
      shots: shots.map((f) => path.basename(f)).filter((f) => /^[\w .()-]+\.(png|jpe?g)$/i.test(f)).slice(0, 40),
      pos: lv?.player?.pos || null,
      dim: lv?.player?.dim || null,
      moments: s.moments.length,
    });
  }

  /**
   * Летопись для окна: события новые сверху; скриншоты — полными путями (только существующие),
   * ролики камеры этого мира, которые не привязаны к событию, — отдельными записями.
   */
  async list(pid, folder, { worldName, clips = [] } = {}) {
    const shotsDir = path.join(this.store.gameDir(pid), 'screenshots');
    const evs = (await this.events(pid, folder)).map((e) => ({
      ...e,
      shots: (e.shots || []).map((f) => path.join(shotsDir, f)).filter((f) => fs.existsSync(f)),
    }));
    const used = new Set(evs.map((e) => e.clip).filter(Boolean));
    for (const c of clips) {
      if (c.profileId !== pid || used.has(c.id)) continue;
      if (c.world !== worldName && c.world !== folder) continue;
      evs.push({ id: 'clip-' + c.id, kind: c.moment ? c.moment.kind : 'clip', title: c.moment?.title || '', at: c.at, clip: c.id });
    }
    const byId = new Map(clips.map((c) => [c.id, c]));
    return evs
      .map((e) => (e.clip && byId.has(e.clip) ? { ...e, clipInfo: { file: byId.get(e.clip).file, thumb: byId.get(e.clip).thumb, seconds: byId.get(e.clip).seconds } } : e))
      .sort((a, b) => String(b.at).localeCompare(String(a.at)));
  }

  /** Мир удалён — его летопись тоже. */
  async forget(pid, folder) {
    await this.change(pid, async (d) => void delete d.worlds[folder]);
  }
}

module.exports = { Chronicle, MC_DAY_MS };
