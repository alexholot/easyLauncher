'use strict';
// Хранилище сборок (игровых профилей).
//
// root/
//   profiles/<pid>/profile.json   название, версия, загрузчик, обложка, память сборки
//   profiles/<pid>/lock.json      lock-файл сборки (точные релизы и хеши)
//   profiles/<pid>/game/          папка клиента, как у обычного Minecraft: mods, config, saves/, screenshots/
//   profiles/<pid>/server/        серверный набор для игры с друзьями: свои mods, config, server.properties
//   profiles/<pid>/worlds.json    обложки миров и последние сессии (см. worlds.js)
//   backups/<pid>/<папка мира>/   резервные копии миров — вне папки сборки, переживают её удаление
//   worlds/                       прежняя схема (до 3.0), переносится в saves при запуске
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { retryFs } = require('./http');

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function newId(prefix) {
  return prefix + '-' + crypto.randomBytes(6).toString('hex');
}

function checkId(id) {
  if (!ID_RE.test(String(id))) throw new Error('Некорректный идентификатор.');
  return id;
}

async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** Атомарная запись JSON: временный файл + rename. */
async function writeJson(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2));
  await retryFs(() => fsp.rename(tmp, file), path.basename(file));
}

function cleanName(name, fallback) {
  const n = String(name || '').replace(/[\r\n\t]/g, ' ').trim().slice(0, 60);
  return n || fallback;
}

/** Пустой lock-файл сборки. */
function emptyLock(minecraft, loader, loaderVersion = null) {
  return { format: 'easylauncher.lock/2', minecraft, loader, loaderVersion, mods: [], updatedAt: new Date().toISOString() };
}

/** Хеш состава: меняется при смене версии, загрузчика или любого релиза мода. */
function lockHash(lock) {
  const parts = [lock.minecraft, lock.loader, lock.loaderVersion || ''];
  for (const m of [...(lock.mods || [])].sort((a, b) => a.key.localeCompare(b.key)))
    parts.push(m.key + '@' + m.versionId + '#' + (m.file?.hashes?.sha1 || m.file?.hashes?.sha512 || ''));
  return crypto.createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 16);
}

class Store {
  constructor(root) {
    this.root = root;
    this.profilesDir = path.join(root, 'profiles');
    this.worldsDir = path.join(root, 'worlds');
    this.backupsDir = path.join(root, 'backups');
  }

  // ---------- профили ----------
  profileDir(pid) {
    return path.join(this.profilesDir, checkId(pid));
  }
  gameDir(pid) {
    return path.join(this.profileDir(pid), 'game');
  }
  serverDir(pid) {
    return path.join(this.profileDir(pid), 'server');
  }

  async listProfiles() {
    let ids = [];
    try {
      ids = await fsp.readdir(this.profilesDir);
    } catch {}
    const out = [];
    for (const id of ids) {
      if (!ID_RE.test(id)) continue;
      const p = await readJson(path.join(this.profilesDir, id, 'profile.json'));
      if (p) out.push(p);
    }
    return out.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  }

  async getProfile(pid) {
    const p = await readJson(path.join(this.profileDir(pid), 'profile.json'));
    if (!p) throw new Error('Игровой профиль не найден.');
    return p;
  }

  async getLock(pid) {
    const p = await this.getProfile(pid);
    return (await readJson(path.join(this.profileDir(pid), 'lock.json'))) || emptyLock(p.minecraft, p.loader);
  }

  async saveLock(pid, lock) {
    lock.updatedAt = new Date().toISOString();
    await writeJson(path.join(this.profileDir(pid), 'lock.json'), lock);
    await this.updateProfile(pid, { minecraft: lock.minecraft, loader: lock.loader, loaderVersion: lock.loaderVersion || null });
  }

  /** kind: personal — своя сборка; room — сборка чужой комнаты (у гостя), не смешивается с личной. */
  async createProfile({ name, minecraft, loader = 'vanilla', loaderVersion = null, kind = 'personal', room = null, id = null }) {
    // любые версии из манифеста Mojang: 1.21.1, 26.1, 24w14a, 1.21-pre1, b1.7.3, a1.2.6, rd-132211, «1.14 Pre-Release 1»
    if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,47}$/.test(minecraft || '') || /\.\./.test(minecraft)) throw new Error('Укажи версию Minecraft.');
    if (!['vanilla', 'fabric', 'quilt', 'forge', 'neoforge'].includes(loader)) throw new Error('Неизвестный загрузчик.');
    const pid = id ? checkId(id) : newId(kind === 'room' ? 'room' : 'p');
    const now = new Date().toISOString();
    const profile = {
      id: pid,
      name: cleanName(name, loader === 'vanilla' ? `Minecraft ${minecraft}` : `${loader} ${minecraft}`),
      minecraft,
      loader,
      loaderVersion: loader === 'vanilla' ? null : loaderVersion || null,
      kind,
      room,
      createdAt: now,
      updatedAt: now,
    };
    await fsp.mkdir(path.join(this.profileDir(pid), 'game', 'mods'), { recursive: true });
    await fsp.mkdir(path.join(this.profileDir(pid), 'server'), { recursive: true });
    await writeJson(path.join(this.profileDir(pid), 'profile.json'), profile);
    await writeJson(path.join(this.profileDir(pid), 'lock.json'), emptyLock(minecraft, loader, loader === 'vanilla' ? null : loaderVersion || null));
    return profile;
  }

  async updateProfile(pid, patch) {
    const p = await this.getProfile(pid);
    const next = { ...p, ...patch, id: p.id, updatedAt: new Date().toISOString() };
    if (patch.name !== undefined) next.name = cleanName(patch.name, p.name);
    await writeJson(path.join(this.profileDir(pid), 'profile.json'), next);
    return next;
  }

  /** Удаление папки сборки. Копии миров делает вызывающий код до удаления (они лежат в backups/, вне сборки). */
  async deleteProfile(pid) {
    await retryFs(() => fsp.rm(this.profileDir(pid), { recursive: true, force: true }), 'папка сборки');
  }
}

module.exports = { Store, emptyLock, lockHash, readJson, writeJson, newId, checkId };
