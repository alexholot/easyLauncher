'use strict';
// Применение плана сборки: скачивание (очередь, отмена, докачка) → проверка → транзакция с откатом.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { inspectJar } = require('./modcache');
const { sideFromEnvironment, validateLock, inGame } = require('./lock');
const { readJson, writeJson } = require('./store');

/** В папку mods кладутся только включённые клиентские моды. */
const active = (m) => m.enabled !== false && inGame(m);

class ModInstaller {
  /** isBusy(pid) — профиль сейчас используется игрой или сервером. */
  constructor(store, cache, { isBusy = () => false } = {}) {
    this.store = store;
    this.cache = cache;
    this.isBusy = isBusy;
    this.queue = Promise.resolve();
  }

  historyDir(pid) {
    return path.join(this.store.profileDir(pid), 'history');
  }
  journal(pid) {
    return path.join(this.store.profileDir(pid), '.transaction.json');
  }

  /** Установки выполняются по одной (очередь), каждую можно отменить сигналом. */
  apply(pid, plan, opts = {}) {
    const run = () => this._apply(pid, plan, opts);
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  async _apply(pid, plan, opts = {}) {
    this.activePid = pid;
    try {
      return await this._applyInner(pid, plan, opts);
    } finally {
      this.activePid = null;
    }
  }

  async _applyInner(pid, plan, { signal, onProgress, imports = {} } = {}) {
    if (this.isBusy(pid))
      throw Object.assign(new Error('Сборку нельзя менять во время игры или работы сервера.'), { code: 'SESSION_ACTIVE' });
    if (!plan.ok) throw Object.assign(new Error('В плане есть ошибки или вопросы — сначала ответь на них.'), { code: 'PLAN_NOT_READY' });
    const lock = plan.nextLock;
    const changed = new Set(plan.changes.filter((c) => c.type !== 'remove').map((c) => c.key));
    const toFetch = lock.mods.filter((m) => changed.has(m.key) || !this.cache.has(m.file));

    // 1. Файлы в кэш: скачать или принять импорт; прогресс — по реально полученным байтам
    const total = toFetch.filter((m) => !m.blocked).reduce((a, m) => a + (m.file.size || 0), 0);
    let done = 0;
    onProgress?.({ phase: 'download', done, total });
    const missing = [];
    for (const m of toFetch) {
      if (signal?.aborted) throw Object.assign(new Error('Установка отменена. Сборка не изменилась.'), { code: 'CANCELLED' });
      if (m.blocked || !m.file.url) {
        if (this.cache.has(m.file)) continue;
        if (imports[m.key]) await this.cache.importFile(imports[m.key], m);
        else missing.push(m);
        continue;
      }
      const start = done;
      await this.cache.ensure(m, {
        signal,
        onBytes: (n) => {
          done += n;
          onProgress?.({ phase: 'download', done, total, name: m.name });
        },
      });
      done = start + (m.file.size || 0);
      onProgress?.({ phase: 'download', done, total, name: m.name });
    }
    if (missing.length) {
      const e = new Error(
        'Эти файлы автор разрешил скачивать только с официальной страницы: ' + missing.map((m) => m.name).join(', ') + '. Скачай их и импортируй.',
      );
      e.code = 'DOWNLOAD_BLOCKED';
      e.missing = missing.map((m) => ({ key: m.key, name: m.name, filename: m.file.filename, pageUrl: m.pageUrl }));
      throw e;
    }

    // 2. Проверка содержимого: это JAR нужного загрузчика; уточняем сторону по fabric.mod.json
    onProgress?.({ phase: 'verify', done: total, total });
    for (const m of lock.mods) {
      if (!changed.has(m.key)) continue;
      const info = inspectJar(this.cache.pathFor(m.file));
      if (!info.ok) throw Object.assign(new Error(`${m.name}: ${info.reason}.`), { code: 'CORRUPT' });
      // Quilt запускает моды Fabric; ранние NeoForge (1.20.1–1.20.4) читали mods.toml, как Forge
      const loaderFits = info.loaders.includes(lock.loader) || (lock.loader === 'quilt' && info.loaders.includes('fabric')) || (lock.loader === 'neoforge' && info.loaders.includes('forge'));
      if (info.loaders.length && !loaderFits)
        throw Object.assign(new Error(`${m.name}: файл предназначен для ${info.loaders.join('/')}, а профиль — ${lock.loader}.`), { code: 'WRONG_LOADER' });
      if ((m.side.client === 'unknown' || m.side.server === 'unknown') && info.environment) m.side = sideFromEnvironment(info.environment);
      delete m.blocked;
    }
    validateLock(lock);

    // 3. Транзакция: журнал → новый lock → раскладка в mods. При сбое возвращаем прежний состав.
    const prev = await this.store.getLock(pid);
    await writeJson(this.journal(pid), { prev, startedAt: new Date().toISOString() });
    try {
      await this.store.saveLock(pid, lock);
      await this.cache.materialize(path.join(this.store.gameDir(pid), 'mods'), lock.mods.filter(active));
      await this.saveHistory(pid, prev);
      await fsp.rm(this.journal(pid), { force: true });
    } catch (e) {
      await this.recover(pid);
      throw Object.assign(new Error('Не удалось применить изменения, сборка возвращена к прежнему состоянию: ' + e.message), { code: 'ROLLED_BACK' });
    }
    onProgress?.({ phase: 'done', done: total, total });
    return lock;
  }

  async saveHistory(pid, prev) {
    const dir = this.historyDir(pid);
    await fsp.mkdir(dir, { recursive: true });
    await writeJson(path.join(dir, Date.now() + '.lock.json'), prev);
    const files = (await fsp.readdir(dir)).sort();
    for (const f of files.slice(0, -10)) await fsp.rm(path.join(dir, f), { force: true });
  }

  /** Прерванная транзакция (сбой, выключение ПК) — вернуть сохранённый в журнале состав. */
  async recover(pid) {
    const j = await readJson(this.journal(pid));
    if (!j?.prev) return false;
    await this.store.saveLock(pid, j.prev);
    try {
      await this.cache.materialize(path.join(this.store.gameDir(pid), 'mods'), j.prev.mods.filter(active));
    } catch {}
    await fsp.rm(this.journal(pid), { force: true });
    return true;
  }

  /** Откат последнего изменения сборки. Файлы прежних версий остаются в кэше. */
  async rollback(pid) {
    if (this.isBusy(pid)) throw Object.assign(new Error('Сначала закрой игру и останови сервер.'), { code: 'SESSION_ACTIVE' });
    const dir = this.historyDir(pid);
    let files = [];
    try {
      files = (await fsp.readdir(dir)).sort();
    } catch {}
    const last = files.pop();
    if (!last) throw new Error('Нет предыдущего состава для отката.');
    const prev = await readJson(path.join(dir, last));
    const missing = prev.mods.filter((m) => !this.cache.has(m.file));
    if (missing.length) throw new Error('Файлов прежнего состава нет в кэше: ' + missing.map((m) => m.name).join(', '));
    await this.store.saveLock(pid, prev);
    await this.cache.materialize(path.join(this.store.gameDir(pid), 'mods'), prev.mods.filter(active));
    await fsp.rm(path.join(dir, last), { force: true });
    return prev;
  }

  /**
   * Включить/выключить мод без удаления. Выключение зависимости включённого мода — предупреждение
   * (игра с таким составом, скорее всего, не запустится), выбор остаётся за игроком.
   */
  async setEnabled(pid, key, on) {
    if (this.isBusy(pid)) throw Object.assign(new Error('Сборку нельзя менять во время игры или работы сервера.'), { code: 'SESSION_ACTIVE' });
    const lock = await this.store.getLock(pid);
    const m = lock.mods.find((x) => x.key === key);
    if (!m) throw new Error('Мод не найден в сборке.');
    if (on) delete m.enabled;
    else m.enabled = false;
    const enabledNow = lock.mods.filter((x) => x.enabled !== false);
    const warnings = [];
    if (!on) {
      const dependents = enabledNow.filter((x) => (x.dependencies || []).some((d) => d.key === key && d.kind === 'required'));
      if (dependents.length) warnings.push(`${m.name} нужен для: ${dependents.map((x) => x.name).join(', ')}. Без него игра может не запуститься.`);
    } else {
      const missing = (m.dependencies || []).filter((d) => d.kind === 'required').map((d) => lock.mods.find((x) => x.key === d.key)).filter((x) => x && x.enabled === false);
      if (missing.length) warnings.push(`Для ${m.name} нужно включить: ${missing.map((x) => x.name).join(', ')}.`);
    }
    // включение/выключение обратимо само по себе и в историю составов для отката не пишется
    await this.store.saveLock(pid, lock);
    await this.cache.materialize(path.join(this.store.gameDir(pid), 'mods'), lock.mods.filter(active));
    return { lock, warnings };
  }

  async setPinned(pid, key, pinned) {
    const lock = await this.store.getLock(pid);
    const m = lock.mods.find((x) => x.key === key);
    if (!m) throw new Error('Мод не найден в сборке.');
    m.pinned = !!pinned;
    await this.store.saveLock(pid, lock);
    return lock;
  }
}

module.exports = { ModInstaller };
