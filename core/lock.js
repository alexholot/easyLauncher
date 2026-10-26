'use strict';
// Lock-файл сборки, стороны установки, манифест комнаты и сравнение сборок.
//
// Запись мода в lock (format easylauncher.lock/2):
// {
//   key: "modrinth:AANobbMI" | "curseforge:238222",   // источник + ID проекта
//   source, projectId, slug, name, versionId, version,
//   side: { client: "required"|"optional"|"unsupported", server: ... },
//   file: { filename, url|null, size, hashes: { sha1, sha512? } },
//   dependencies: [{ key, kind: "required"|"optional"|"incompatible"|"embedded" }],
//   pinned: bool, addedBy: "user"|"dependency",
//   enabled?: false — мод выключен игроком: остаётся в сборке, но не кладётся в папку mods
// }
const SIDES = ['required', 'optional', 'unsupported'];

function keyOf(source, projectId) {
  return `${source}:${projectId}`;
}

/** Сторона по полям Modrinth client_side / server_side. */
function sideFromModrinth(client, server) {
  const norm = (v) => (SIDES.includes(v) ? v : 'unknown');
  return { client: norm(client), server: norm(server) };
}

/** Сторона по fabric.mod.json "environment". */
function sideFromEnvironment(env) {
  if (env === 'client') return { client: 'required', server: 'unsupported' };
  if (env === 'server') return { client: 'unsupported', server: 'required' };
  if (env === '*') return { client: 'required', server: 'required' };
  return { client: 'unknown', server: 'unknown' };
}

/** Нужен ли мод на клиенте / на выделенном сервере. Неизвестная сторона — ставим, но предупреждаем. */
function onClient(e) {
  return e.side?.client !== 'unsupported';
}
function onServer(e) {
  return e.side?.server !== 'unsupported';
}
/** Общий мод: обязателен и у сервера, и у клиента — должен точно совпадать у всех участников. */
function isShared(e) {
  return e.side?.client === 'required' && e.side?.server === 'required';
}

function validateEntry(e) {
  const errs = [];
  if (!/^(modrinth|curseforge|local):[A-Za-z0-9_-]+$/.test(e.key || '')) errs.push('ключ');
  if (!e.versionId) errs.push('versionId');
  if (!e.file?.filename || !/^[0-9a-f]{40}$/i.test(e.file?.hashes?.sha1 || '')) errs.push('файл/sha1');
  if (!e.side || !('client' in e.side) || !('server' in e.side)) errs.push('сторона');
  return errs;
}

function validateLock(lock) {
  if (!lock || lock.format !== 'easylauncher.lock/2') throw new Error('Неизвестный формат состава сборки.');
  // любые версии из манифеста Mojang: 1.21.1, 26.1, 24w14a, b1.7.3, a1.2.6, rd-132211, «1.14 Pre-Release 1»
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,47}$/.test(lock.minecraft || '') || /\.\./.test(lock.minecraft)) throw new Error('В составе не указана версия Minecraft.');
  if (!['vanilla', 'fabric', 'quilt', 'forge', 'neoforge'].includes(lock.loader)) throw new Error('Неизвестный загрузчик.');
  if (!Array.isArray(lock.mods)) throw new Error('В составе нет списка модов.');
  if (lock.loader === 'vanilla' && lock.mods.length) throw new Error('В Vanilla-профиле не может быть модов.');
  const seen = new Set();
  for (const e of lock.mods) {
    const errs = validateEntry(e);
    if (errs.length) throw new Error(`Запись мода ${e.name || e.key || '?'} неполная: ${errs.join(', ')}.`);
    if (seen.has(e.key)) throw new Error(`Мод ${e.name} указан дважды.`);
    seen.add(e.key);
  }
  return lock;
}

/**
 * Манифест для друзей: какие файлы ставить и откуда. JAR не пересылаются —
 * каждый участник скачивает их сам из разрешённого источника и сверяет хеши.
 * Серверные моды гостю не нужны; клиентские моды хозяина — необязательные.
 */
function roomManifest(lock, room) {
  validateLock(lock);
  return {
    format: 'easylauncher.room-manifest/1',
    room: { name: room.name, minecraft: lock.minecraft, loader: lock.loader, loaderVersion: lock.loaderVersion || null },
    mods: lock.mods
      .filter((e) => e.enabled !== false && onClient(e))
      .map((e) => ({
        key: e.key,
        source: e.source,
        projectId: e.projectId,
        name: e.name,
        versionId: e.versionId,
        version: e.version,
        side: e.side,
        file: e.file,
        dependencies: e.dependencies || [],
        // гостю обязателен мод, который нужен и серверу, и клиенту (или сторона неизвестна);
        // чисто клиентские моды хозяина (графика, интерфейс) для гостя необязательны
        requiredForGuest: (e.side.client === 'required' || e.side.client === 'unknown') && e.side.server !== 'unsupported',
      })),
  };
}

/** Lock для профиля гостя по манифесту комнаты. optionalKeys — какие необязательные моды он выбрал. */
function lockFromManifest(manifest, optionalKeys = null) {
  if (manifest?.format !== 'easylauncher.room-manifest/1') throw new Error('Неизвестный формат приглашения.');
  const mods = manifest.mods
    .filter((m) => m.requiredForGuest || !optionalKeys || optionalKeys.includes(m.key))
    .map((m) => ({
      key: m.key,
      source: m.source,
      projectId: m.projectId,
      slug: m.slug || null,
      name: m.name,
      versionId: m.versionId,
      version: m.version,
      side: m.side,
      file: m.file,
      dependencies: m.dependencies || [],
      pinned: true,
      addedBy: 'room',
    }));
  return validateLock({
    format: 'easylauncher.lock/2',
    minecraft: manifest.room.minecraft,
    loader: manifest.room.loader,
    loaderVersion: manifest.room.loaderVersion,
    mods,
    updatedAt: new Date().toISOString(),
  });
}

/**
 * Сравнение сборки гостя со сборкой комнаты перед подключением.
 * errors — подключение невозможно; warnings — допустимые различия.
 */
function compare(hostManifest, guestLock) {
  const errors = [];
  const warnings = [];
  const r = hostManifest.room;
  if (r.minecraft !== guestLock.minecraft) errors.push(`Версия Minecraft: у комнаты ${r.minecraft}, у тебя ${guestLock.minecraft}.`);
  if (r.loader !== guestLock.loader) errors.push(`Загрузчик: у комнаты ${r.loader}, у тебя ${guestLock.loader}.`);
  else if (r.loaderVersion && guestLock.loaderVersion && r.loaderVersion !== guestLock.loaderVersion)
    warnings.push(`Версия ${r.loader} отличается: ${r.loaderVersion} и ${guestLock.loaderVersion}. Лаунчер поставит версию комнаты.`);
  const guest = new Map(guestLock.mods.map((m) => [m.key, m]));
  const bySha = new Map(guestLock.mods.map((m) => [m.file.hashes.sha1, m]));
  for (const m of hostManifest.mods) {
    const g = guest.get(m.key) || bySha.get(m.file.hashes.sha1);
    if (!g) {
      if (m.requiredForGuest) errors.push(`Нет обязательного мода ${m.name} ${m.version}.`);
      continue;
    }
    if (g.file.hashes.sha1 !== m.file.hashes.sha1) {
      if (m.requiredForGuest) errors.push(`${m.name}: нужна версия ${m.version}, у тебя ${g.version}.`);
      else warnings.push(`${m.name}: версия отличается (${g.version} вместо ${m.version}), мод только клиентский.`);
    }
  }
  const hostKeys = new Set(hostManifest.mods.map((m) => m.key));
  for (const g of guestLock.mods) {
    if (hostKeys.has(g.key)) continue;
    if (g.side.server === 'required' && g.side.client === 'required')
      errors.push(`Мод ${g.name} есть только у тебя и нужен серверу — с ним подключиться нельзя.`);
    else if (g.side.client !== 'unsupported') warnings.push(`Мод ${g.name} есть только у тебя (клиентский).`);
  }
  return { ok: errors.length === 0, errors, warnings };
}

module.exports = {
  keyOf,
  sideFromModrinth,
  sideFromEnvironment,
  onClient,
  onServer,
  isShared,
  validateLock,
  roomManifest,
  lockFromManifest,
  compare,
};
