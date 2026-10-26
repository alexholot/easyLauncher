'use strict';
// Планировщик изменений сборки: подбор релизов, зависимости, конфликты, дубликаты.
// Результат — план, который показывается пользователю до любых изменений на диске.
const { keyOf } = require('./lock');

const clone = (x) => JSON.parse(JSON.stringify(x));

function loaderOk(version, loader) {
  if (loader === 'vanilla') return false;
  const l = version.loaders || [];
  return l.includes(loader) || (loader === 'quilt' && l.includes('fabric'));
}

function compatible(version, target) {
  return (version.minecraft || []).includes(target.minecraft) && loaderOk(version, target.loader);
}

function why(version, target) {
  const reasons = [];
  if (!(version.minecraft || []).includes(target.minecraft)) reasons.push(`нет версии для Minecraft ${target.minecraft}`);
  if (!loaderOk(version, target.loader)) reasons.push(`не поддерживает ${target.loader}`);
  return reasons.join(', ');
}

function primary(v) {
  return v.files.find((f) => f.primary) || v.files[0] || null;
}

function toEntry(project, version, { addedBy, pinned = false }) {
  const f = primary(version);
  return {
    key: version.key,
    source: version.source,
    projectId: version.projectId,
    slug: project?.slug || null,
    name: project?.name || version.name,
    versionId: version.id,
    version: version.number,
    minecraft: version.minecraft,
    loaders: version.loaders,
    side: version.side,
    file: { filename: f.filename, url: f.url, size: f.size, hashes: { sha1: f.hashes.sha1, sha512: f.hashes.sha512 || undefined } },
    dependencies: version.deps.filter((d) => d.key).map((d) => ({ key: d.key, kind: d.kind })),
    pinned,
    addedBy,
    blocked: !!version.blocked,
    pageUrl: project?.url || null,
  };
}

function normName(n) {
  return String(n || '')
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, '')
    .replace(/[^a-zа-я0-9]+/g, '');
}

/**
 * request: {
 *   add: [{source, projectId, versionId?}],  remove: [key], update: [key] | 'all',
 *   allowPrerelease: bool, choices: { [newKey]: 'keep-both' | 'skip' } — ответы на возможные дубликаты
 * }
 * providers: { modrinth, curseforge }
 */
async function planChanges({ lock, request, providers }) {
  const target = { minecraft: lock.minecraft, loader: lock.loader };
  const next = new Map(lock.mods.map((m) => [m.key, clone(m)]));
  const before = new Map(lock.mods.map((m) => [m.key, m]));
  const errors = [];
  const warnings = [];
  const questions = [];
  const reasons = new Map(); // key → почему добавлен
  if (target.loader === 'vanilla' && (request.add || []).length) {
    errors.push({ code: 'VANILLA', message: 'В профиле Vanilla моды не устанавливаются. Создай профиль с Fabric.' });
    return finish();
  }

  // ---- удаление ----
  for (const key of request.remove || []) {
    if (!next.has(key)) continue;
    const dependents = [...next.values()].filter((m) => m.key !== key && m.dependencies?.some((d) => d.key === key && d.kind === 'required'));
    if (dependents.length && !(request.remove || []).includes(dependents[0].key)) {
      warnings.push({ code: 'DEPENDENT', key, message: `${next.get(key).name} нужен модам: ${dependents.map((d) => d.name).join(', ')}. Они тоже будут убраны.` });
      for (const d of dependents) next.delete(d.key);
    }
    next.delete(key);
  }

  // ---- добавление и зависимости ----
  const queue = (request.add || []).map((a) => ({ ...a, explicit: true }));
  const updates = request.update === 'all' ? [...next.values()].filter((m) => !m.pinned).map((m) => m.key) : request.update || [];
  for (const key of updates) {
    const m = next.get(key);
    if (!m) continue;
    if (m.pinned) {
      warnings.push({ code: 'PINNED', key, message: `${m.name}: версия закреплена, обновление пропущено.` });
      continue;
    }
    queue.push({ source: m.source, projectId: m.projectId, update: true });
  }
  const visited = new Set();
  while (queue.length) {
    const item = queue.shift();
    const provider = providers[item.source];
    const key = keyOf(item.source, item.projectId);
    if (visited.has(key + (item.update ? '#u' : ''))) continue;
    visited.add(key + (item.update ? '#u' : ''));
    if (!provider) {
      errors.push({ code: 'SOURCE', key, message: `Источник ${item.source} не поддерживается.` });
      continue;
    }
    const existing = next.get(key);
    if (existing && !item.update && !item.versionId) {
      if (item.explicit) warnings.push({ code: 'INSTALLED', key, message: `${existing.name} уже установлен.` });
      continue; // зависимость уже удовлетворена
    }
    if (existing?.pinned && !item.explicit) continue;
    let project = null;
    let version = null;
    try {
      project = await provider.project(item.projectId);
      if (item.versionId) {
        version = await provider.version(item.projectId, item.versionId);
        if (!compatible(version, target)) {
          errors.push({ code: 'INCOMPATIBLE', key, message: `${project.name} ${version.number}: ${why(version, target)}.` });
          continue;
        }
      } else {
        const list = (await provider.versions(item.projectId, target)).filter((v) => compatible(v, target) && v.available !== false);
        list.sort((a, b) => String(b.published).localeCompare(String(a.published)));
        version = list.find((v) => v.type === 'release') || null;
        // мод уже стоит на тестовой версии (игрок сам её разрешил) — обновляем в том же канале
        const onPrerelease = existing && item.update && list.some((v) => v.id === existing.versionId && v.type !== 'release');
        if (!version && list.length && item.update && existing && !onPrerelease && !request.allowPrerelease) continue; // стабильного обновления нет — оставляем как есть
        if (!version && list.length) {
          if (onPrerelease) version = list[0];
          else if (request.allowPrerelease) {
            version = list[0];
            warnings.push({ code: 'PRERELEASE', key, message: `${project.name}: доступна только ${list[0].type === 'beta' ? 'бета' : 'альфа'}-версия ${list[0].number}.` });
          } else {
            errors.push({ code: 'PRERELEASE_ONLY', key, message: `${project.name}: для Minecraft ${target.minecraft} есть только тестовые версии. Включи их явно, если готов рискнуть.` });
            continue;
          }
        }
        if (!version) {
          errors.push({ code: 'INCOMPATIBLE', key, message: `${project.name}: нет релиза для Minecraft ${target.minecraft} и ${target.loader}.` });
          continue;
        }
      }
    } catch (e) {
      errors.push({ code: e.code || 'NETWORK', key, message: `${item.name || key}: ${e.message}` });
      continue;
    }
    if (!primary(version)?.hashes?.sha1) {
      errors.push({ code: 'NO_HASH', key, message: `${project.name}: у файла нет SHA-1, установка без проверки невозможна.` });
      continue;
    }
    if (item.update && existing && existing.versionId === version.id) continue; // уже последняя
    const entry = toEntry(project, version, {
      addedBy: item.explicit ? 'user' : existing?.addedBy || 'dependency',
      pinned: existing?.pinned || false,
    });

    // Дубликат с другой площадки: тот же файл (SHA-1) — точно один мод; похожее название — спросить
    const sameFile = [...next.values()].find((m) => m.key !== key && m.file.hashes.sha1 === entry.file.hashes.sha1);
    if (sameFile) {
      warnings.push({ code: 'DUPLICATE', key, message: `${entry.name}: этот же файл уже установлен как ${sameFile.name} (${sameFile.source}). Повторно не ставим.` });
      continue;
    }
    const sameName = [...next.values()].find((m) => m.key !== key && m.source !== entry.source && normName(m.name) === normName(entry.name));
    if (sameName) {
      const choice = request.choices?.[key];
      if (choice === 'skip') continue;
      if (choice !== 'keep-both') {
        questions.push({ key, otherKey: sameName.key, message: `${entry.name} с ${entry.source} похож на уже установленный ${sameName.name} с ${sameName.source}. Одинаковое название не доказывает, что это один мод.`, options: ['skip', 'keep-both'] });
        continue;
      }
    }
    next.set(key, entry);
    if (item.requiredBy) reasons.set(key, item.requiredBy);
    if (entry.side.client === 'unknown' || entry.side.server === 'unknown')
      warnings.push({ code: 'SIDE_UNKNOWN', key, message: `${entry.name}: площадка не указывает сторону установки — уточним по файлу мода после скачивания.` });

    for (const d of version.deps) {
      if (d.kind === 'required') {
        let pid = d.projectId;
        if (!pid && d.versionId) {
          try {
            pid = (await provider.version(null, d.versionId)).projectId;
          } catch {}
        }
        if (!pid) {
          errors.push({ code: 'DEP_UNKNOWN', key, message: `${entry.name}: обязательная зависимость указана без проекта — проверь мод вручную.` });
          continue;
        }
        queue.push({ source: item.source, projectId: pid, versionId: d.versionId || null, requiredBy: entry.name });
      }
    }
  }

  // ---- объявленные несовместимости в итоговом составе ----
  for (const m of next.values()) {
    for (const d of m.dependencies || []) {
      if (d.kind === 'incompatible' && next.has(d.key))
        errors.push({ code: 'CONFLICT', key: m.key, message: `${m.name} несовместим с ${next.get(d.key).name} (так указал автор).` });
    }
  }
  // ---- зависимости, ставшие ненужными после удаления ----
  for (const m of [...next.values()]) {
    if (m.addedBy !== 'dependency') continue;
    const needed = [...next.values()].some((o) => o.key !== m.key && o.dependencies?.some((d) => d.key === m.key && d.kind === 'required'));
    if (!needed) next.delete(m.key);
  }
  return finish();

  function finish() {
    const changes = [];
    for (const m of next.values()) {
      const old = before.get(m.key);
      if (!old) changes.push({ type: 'add', key: m.key, name: m.name, to: m.version, dependencyOf: reasons.get(m.key) || null, manual: m.blocked });
      else if (old.versionId !== m.versionId) changes.push({ type: 'update', key: m.key, name: m.name, from: old.version, to: m.version, manual: m.blocked });
    }
    for (const old of before.values()) if (!next.has(old.key)) changes.push({ type: 'remove', key: old.key, name: old.name, from: old.version });
    const nextLock = { ...clone(lock), mods: [...next.values()] };
    return {
      ok: errors.length === 0 && questions.length === 0,
      target,
      changes,
      errors,
      warnings,
      questions,
      manual: nextLock.mods.filter((m) => m.blocked && changes.some((c) => c.key === m.key && c.type !== 'remove')),
      nextLock,
    };
  }
}

/** Состояние мода в каталоге для карточки: Установить / Установлен / Есть обновление / Несовместим. */
async function modState({ lock, provider, projectId, project }) {
  const key = keyOf(provider.id, projectId);
  const installed = lock.mods.find((m) => m.key === key);
  const target = { minecraft: lock.minecraft, loader: lock.loader };
  const list = await provider.versions(projectId, target);
  const best = list.filter((v) => compatible(v, target) && v.type === 'release').sort((a, b) => String(b.published).localeCompare(String(a.published)))[0];
  if (installed) {
    if (best && best.id !== installed.versionId && !installed.pinned) return { state: 'update', installed, best };
    return { state: 'installed', installed };
  }
  if (!best) return { state: 'incompatible', reason: `Нет стабильного релиза для Minecraft ${target.minecraft} и ${target.loader}.` };
  if (project?.distribution === 'blocked' || best.blocked) return { state: 'manual', best };
  return { state: 'install', best };
}

module.exports = { planChanges, modState, compatible, toEntry };
