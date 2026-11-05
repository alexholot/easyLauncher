'use strict';
// Миры живут внутри своей сборки: profiles/<pid>/game/saves/<папка>, как в обычном Minecraft.
// Поэтому мир нельзя случайно открыть чужой несовместимой сборкой.
// Метаданные лаунчера (обложка, закрепление, последняя сессия) — в profiles/<pid>/worlds.json.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { Worker } = require('worker_threads');
const { readLevel } = require('./nbt');
const { readJson, writeJson } = require('./store');
const { retryFs } = require('./http');

const FOLDER_RE = /^[^\\/:*?"<>|\x00-\x1f]{1,120}$/;
const IMG_RE = /\.(png|jpe?g|webp)$/i;

function archiveWorker(action, source, target) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'archive-worker.js'), { workerData: { action, source, target } });
    let answered = false;
    worker.once('message', (m) => {
      answered = true;
      if (m.ok) resolve();
      else reject(new Error(m.message || 'Не удалось обработать резервную копию.'));
    });
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (!answered) reject(new Error(code ? 'Обработка резервной копии неожиданно остановилась.' : 'Обработка резервной копии завершилась без результата.'));
    });
  });
}

function checkFolder(f) {
  if (!FOLDER_RE.test(String(f)) || f === '.' || f === '..') throw new Error('Некорректная папка мира.');
  return f;
}
function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

class Worlds {
  constructor(store) {
    this.store = store;
  }
  savesDir(pid) {
    return path.join(this.store.gameDir(pid), 'saves');
  }
  dir(pid, folder) {
    return path.join(this.savesDir(pid), checkFolder(folder));
  }
  metaFile(pid) {
    return path.join(this.store.profileDir(pid), 'worlds.json');
  }
  coversDir(pid) {
    return path.join(this.store.profileDir(pid), 'covers');
  }
  backupsDir(pid, folder) {
    return path.join(this.store.backupsDir, pid, checkFolder(folder));
  }
  async meta(pid) {
    return (await readJson(this.metaFile(pid))) || {};
  }
  async saveMeta(pid, m) {
    await writeJson(this.metaFile(pid), m);
  }

  /** Миры сборки: сведения из level.dat, значок мира, обложка лаунчера. */
  async list(pid) {
    let names = [];
    try {
      names = await fsp.readdir(this.savesDir(pid), { withFileTypes: true });
    } catch {}
    const meta = await this.meta(pid);
    const out = [];
    for (const e of names) {
      if (!e.isDirectory() || !FOLDER_RE.test(e.name)) continue;
      const dir = path.join(this.savesDir(pid), e.name);
      const levelFile = path.join(dir, 'level.dat');
      if (!fs.existsSync(levelFile)) continue;
      let info = {};
      try {
        info = readLevel(await fsp.readFile(levelFile));
      } catch {
        info = { name: e.name, damaged: true };
      }
      const icon = fs.existsSync(path.join(dir, 'icon.png')) ? path.join(dir, 'icon.png') : null;
      const m = meta[e.name] || {};
      const cover = m.cover && fs.existsSync(m.cover.file) ? m.cover : null;
      out.push({
        folder: e.name,
        name: info.name || e.name,
        lastPlayed: info.lastPlayed || m.lastSession?.at || null,
        version: info.version,
        gamemode: info.gamemode,
        hardcore: info.hardcore,
        damaged: !!info.damaged,
        icon,
        cover,
        lastSession: m.lastSession || null,
      });
    }
    return out.sort((a, b) => String(b.lastPlayed || '').localeCompare(String(a.lastPlayed || '')));
  }

  async get(pid, folder) {
    const w = (await this.list(pid)).find((x) => x.folder === folder);
    if (!w) throw new Error('Мир не найден в этой сборке.');
    return w;
  }

  /**
   * Обложка мира. source: 'manual' — выбрана игроком (закреплена по умолчанию);
   * 'session' — скриншот, достоверно снятый в этом мире во время запуска из easyLauncher.
   * Закреплённую обложку автоматическое обновление не меняет.
   */
  async setCover(pid, folder, srcPath, { source = 'manual', pinned = source === 'manual' } = {}) {
    checkFolder(folder);
    if (!IMG_RE.test(srcPath)) throw new Error('Обложка — изображение PNG, JPG или WEBP.');
    const st = await fsp.stat(srcPath);
    if (st.size > 20 * 1024 * 1024) throw new Error('Изображение больше 20 МБ.');
    const meta = await this.meta(pid);
    const m = meta[folder] || {};
    if (source !== 'manual' && m.cover?.pinned) return m.cover; // закреплена — не трогаем
    await fsp.mkdir(this.coversDir(pid), { recursive: true });
    const dest = path.join(this.coversDir(pid), `${Buffer.from(folder).toString('hex').slice(0, 40)}-${Date.now()}${path.extname(srcPath).toLowerCase()}`);
    await fsp.copyFile(srcPath, dest);
    if (m.cover?.file && m.cover.file.startsWith(this.coversDir(pid))) await fsp.rm(m.cover.file, { force: true });
    m.cover = { file: dest, source, pinned: !!pinned, at: new Date().toISOString() };
    meta[folder] = m;
    await this.saveMeta(pid, meta);
    return m.cover;
  }

  async pinCover(pid, folder, pinned) {
    const meta = await this.meta(pid);
    if (!meta[folder]?.cover) throw new Error('У мира ещё нет обложки.');
    meta[folder].cover.pinned = !!pinned;
    await this.saveMeta(pid, meta);
  }

  async clearCover(pid, folder) {
    const meta = await this.meta(pid);
    const c = meta[folder]?.cover;
    if (c?.file?.startsWith(this.coversDir(pid))) await fsp.rm(c.file, { force: true });
    if (meta[folder]) delete meta[folder].cover;
    await this.saveMeta(pid, meta);
  }

  async recordSession(pid, folder, info) {
    const meta = await this.meta(pid);
    meta[folder] = { ...(meta[folder] || {}), lastSession: { at: new Date().toISOString(), ...info } };
    await this.saveMeta(pid, meta);
  }

  // ---------- блокировка: мир открыт сервером ----------
  lockFile(pid, folder) {
    return path.join(this.store.profileDir(pid), '.locks', Buffer.from(checkFolder(folder)).toString('hex') + '.json');
  }
  async holder(pid, folder) {
    const l = await readJson(this.lockFile(pid, folder));
    if (!l) return null;
    if (l.pid && !alive(l.pid)) {
      await fsp.rm(this.lockFile(pid, folder), { force: true });
      return null;
    }
    return l;
  }
  async acquire(pid, folder, owner) {
    if (await this.holder(pid, folder)) {
      throw Object.assign(new Error('Этот мир уже открыт сервером совместной игры.'), { code: 'WORLD_LOCKED', action: 'Заверши сессию в «С друзьями».' });
    }
    await writeJson(this.lockFile(pid, folder), { owner, pid: null, at: new Date().toISOString() });
  }
  async setLockPid(pid, folder, procPid) {
    const l = (await readJson(this.lockFile(pid, folder))) || {};
    await writeJson(this.lockFile(pid, folder), { ...l, pid: procPid });
  }
  async release(pid, folder) {
    await fsp.rm(this.lockFile(pid, folder), { force: true });
  }

  // ---------- резервные копии ----------
  async backups(pid, folder) {
    let files = [];
    try {
      files = await fsp.readdir(this.backupsDir(pid, folder));
    } catch {}
    const out = [];
    for (const f of files.filter((x) => x.endsWith('.json'))) {
      const m = await readJson(path.join(this.backupsDir(pid, folder), f));
      if (m && fs.existsSync(path.join(this.backupsDir(pid, folder), m.file))) out.push(m);
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * Согласованная копия. Если мир открыт сервером — save-off, save-all flush, ожидание «Saved the game», save-on.
   * Если в мире сейчас идёт одиночная игра (sessionWorld совпадает) — отказ: живую папку не копируем.
   */
  async backup(pid, folder, { reason = 'manual', reasonText = 'Вручную', server = null, playingFolder = null } = {}) {
    const dir = this.dir(pid, folder);
    if (!fs.existsSync(path.join(dir, 'level.dat'))) return null;
    if (playingFolder === folder) throw Object.assign(new Error('В этом мире сейчас идёт игра. Выйди в главное меню Minecraft и повтори.'), { code: 'WORLD_IN_USE' });
    const serverOwns = server && server.state === 'running' && server.worldKey === `${pid}/${folder}`;
    if (serverOwns) {
      server.command('save-off');
      const saved = server.waitForLine(/Saved the game|Сохранение игры завершено/, 60000);
      server.command('save-all flush');
      await saved;
    }
    try {
      const bdir = this.backupsDir(pid, folder);
      await fsp.mkdir(bdir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const file = `${stamp}-${reason}.zip`;
      const tmp = path.join(bdir, file + '.part');
      await archiveWorker('backup', dir, tmp);
      await retryFs(() => fsp.rename(tmp, path.join(bdir, file)));
      const meta = { id: stamp, file, reason, reasonText, createdAt: new Date().toISOString(), size: fs.statSync(path.join(bdir, file)).size };
      await writeJson(path.join(bdir, file.replace(/\.zip$/, '.json')), meta);
      const list = await this.backups(pid, folder);
      for (const b of list.slice(10)) {
        await fsp.rm(path.join(bdir, b.file), { force: true });
        await fsp.rm(path.join(bdir, b.file.replace(/\.zip$/, '.json')), { force: true });
      }
      return meta;
    } finally {
      if (serverOwns) {
        try {
          server.command('save-on');
        } catch {}
      }
    }
  }

  async restore(pid, folder, backupId, { playingFolder = null } = {}) {
    const b = (await this.backups(pid, folder)).find((x) => x.id === backupId);
    if (!b) throw new Error('Резервная копия не найдена.');
    if (await this.holder(pid, folder)) throw new Error('Сначала заверши сессию с друзьями в этом мире.');
    await this.backup(pid, folder, { reason: 'before-restore', reasonText: 'Перед восстановлением', playingFolder });
    const dir = this.dir(pid, folder);
    const staging = dir + '.restore';
    await fsp.rm(staging, { recursive: true, force: true });
    await archiveWorker('restore', path.join(this.backupsDir(pid, folder), b.file), staging);
    const old = dir + '.old';
    await fsp.rm(old, { recursive: true, force: true });
    if (fs.existsSync(dir)) await retryFs(() => fsp.rename(dir, old), 'папка мира');
    await retryFs(() => fsp.rename(path.join(staging, 'world'), dir), 'папка мира');
    await fsp.rm(staging, { recursive: true, force: true });
    await fsp.rm(old, { recursive: true, force: true });
    return b;
  }

  /** Удаление: сначала копия, затем папка. Подтверждение — точным названием мира. */
  async remove(pid, folder, confirmName, opts = {}) {
    const w = await this.get(pid, folder);
    if (String(confirmName).trim() !== w.name) throw new Error('Для удаления введи точное название мира.');
    if (await this.holder(pid, folder)) throw new Error('Сначала заверши сессию с друзьями в этом мире.');
    await this.backup(pid, folder, { reason: 'before-delete', reasonText: 'Перед удалением', ...opts });
    await retryFs(() => fsp.rm(this.dir(pid, folder), { recursive: true, force: true }), 'папка мира');
    const meta = await this.meta(pid);
    delete meta[folder];
    await this.saveMeta(pid, meta);
  }

  /** Свободное имя папки для нового мира. */
  async freeFolder(pid, name) {
    const base = String(name || 'Новый мир').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim().slice(0, 60) || 'Новый мир';
    let f = base;
    for (let i = 2; fs.existsSync(path.join(this.savesDir(pid), f)); i++) f = `${base} (${i})`;
    return f;
  }

  /**
   * Перенос миров из прежней схемы (worlds/<id>/world) в saves их сборок. Исходник удаляется
   * только после успешного переноса; копии остаются в backups/<id>.
   */
  async migrateLegacy() {
    const legacy = this.store.worldsDir;
    let ids = [];
    try {
      ids = await fsp.readdir(legacy);
    } catch {
      return [];
    }
    const moved = [];
    for (const id of ids) {
      const meta = await readJson(path.join(legacy, id, 'meta.json'));
      const src = path.join(legacy, id, 'world');
      if (!meta?.profileId) continue;
      try {
        await this.store.getProfile(meta.profileId);
      } catch {
        continue;
      }
      if (!fs.existsSync(path.join(src, 'level.dat'))) {
        await fsp.rm(path.join(legacy, id), { recursive: true, force: true });
        continue;
      }
      const folder = await this.freeFolder(meta.profileId, meta.name);
      await fsp.mkdir(this.savesDir(meta.profileId), { recursive: true });
      const link = path.join(this.savesDir(meta.profileId), id);
      try {
        const st = await fsp.lstat(link);
        if (st.isSymbolicLink()) await fsp.unlink(link);
      } catch {}
      await retryFs(() => fsp.rename(src, path.join(this.savesDir(meta.profileId), folder)), meta.name);
      await fsp.rm(path.join(legacy, id), { recursive: true, force: true });
      moved.push({ id, profileId: meta.profileId, folder });
    }
    return moved;
  }
}

/** Последний скриншот сборки (папка screenshots принадлежит только ей). */
async function latestScreenshot(store, pid) {
  const dir = path.join(store.gameDir(pid), 'screenshots');
  let files = [];
  try {
    files = await fsp.readdir(dir);
  } catch {
    return null;
  }
  let best = null;
  for (const f of files.filter((x) => IMG_RE.test(x))) {
    const st = await fsp.stat(path.join(dir, f));
    if (!best || st.mtimeMs > best.t) best = { file: path.join(dir, f), t: st.mtimeMs };
  }
  return best ? best.file : null;
}

module.exports = { Worlds, latestScreenshot, checkFolder };
