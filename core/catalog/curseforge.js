'use strict';
// CurseForge API (https://api.curseforge.com) — только через сервер easyLauncher.
//
// Доступ к API выдаётся разработчику по заявке (ключ x-api-key, условия 3rd Party API Terms).
// Ключ, встроенный в распространяемый клиент, секретным сделать нельзя, поэтому клиент ходит
// через прокси разработчика (server/ в этом репозитории), который добавляет ключ на своей стороне.
// Для локальной разработки можно задать EASYLAUNCHER_CF_API_KEY — такой ключ в сборку не попадает.
//
// Автор мода может запретить распространение через сторонние приложения: тогда у файла нет downloadUrl
// (allowModDistribution = false). Ссылку по шаблону CDN не восстанавливаем — пользователь скачивает
// файл на официальной странице и импортирует, лаунчер сверяет SHA-1.
const { api } = require('../http');
const { keyOf } = require('../lock');

const GAME_MINECRAFT = 432;
const CLASS_MODS = 6;
const LOADERS = { forge: 1, fabric: 4, quilt: 5, neoforge: 6 };
const LOADER_NAMES = { Forge: 'forge', Fabric: 'fabric', Quilt: 'quilt', NeoForge: 'neoforge' };
const SORTS = { relevance: 1, downloads: 6, updated: 3, newest: 11, name: 4 };
const RELEASE = { 1: 'release', 2: 'beta', 3: 'alpha' };
const RELATION = { 1: 'embedded', 2: 'optional', 3: 'required', 4: 'tool', 5: 'incompatible', 6: 'include' };

/**
 * Отпечаток файла CurseForge: MurmurHash2 (seed 1) по байтам файла без пробельных символов (9, 10, 13, 32).
 * По нему CurseForge находит точный файл мода (POST /v1/fingerprints).
 */
function fingerprint(buf) {
  let n = 0;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b !== 9 && b !== 10 && b !== 13 && b !== 32) n++;
  }
  const d = Buffer.allocUnsafe(n);
  for (let i = 0, j = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b !== 9 && b !== 10 && b !== 13 && b !== 32) d[j++] = b;
  }
  const m = 0x5bd1e995;
  let h = (1 ^ n) >>> 0;
  let i = 0;
  for (; i + 4 <= n; i += 4) {
    let k = d[i] | (d[i + 1] << 8) | (d[i + 2] << 16) | (d[i + 3] << 24);
    k = Math.imul(k, m);
    k ^= k >>> 24;
    k = Math.imul(k, m);
    h = Math.imul(h, m) ^ k;
  }
  switch (n & 3) {
    case 3:
      h ^= d[i + 2] << 16;
    // falls through
    case 2:
      h ^= d[i + 1] << 8;
    // falls through
    case 1:
      h ^= d[i];
      h = Math.imul(h, m);
  }
  h ^= h >>> 13;
  h = Math.imul(h, m);
  h ^= h >>> 15;
  return h >>> 0;
}

function normProject(m) {
  return {
    key: keyOf('curseforge', m.id),
    source: 'curseforge',
    id: String(m.id),
    slug: m.slug,
    name: m.name,
    author: m.authors?.[0]?.name || null,
    summary: m.summary || '',
    iconUrl: m.logo?.thumbnailUrl || null,
    url: m.links?.websiteUrl || `https://www.curseforge.com/minecraft/mc-mods/${m.slug}`,
    categories: (m.categories || []).map((c) => c.name),
    downloads: m.downloadCount || 0,
    updated: m.dateModified || null,
    gameVersions: [...new Set((m.latestFilesIndexes || []).map((i) => i.gameVersion))],
    loaders: null,
    // CurseForge не публикует стороны установки; уточняются по fabric.mod.json после скачивания
    side: { client: 'unknown', server: 'unknown' },
    distribution: m.allowModDistribution === false ? 'blocked' : 'allowed',
  };
}

function sideFromGameVersions(list) {
  const c = list.includes('Client');
  const s = list.includes('Server');
  if (c && !s) return { client: 'required', server: 'unsupported' };
  if (s && !c) return { client: 'unsupported', server: 'required' };
  if (c && s) return { client: 'required', server: 'required' };
  return { client: 'unknown', server: 'unknown' };
}

function normFile(f, mod) {
  const sha1 = f.hashes?.find((h) => h.algo === 1)?.value;
  const md5 = f.hashes?.find((h) => h.algo === 2)?.value;
  const blocked = !f.downloadUrl || mod?.allowModDistribution === false;
  const gv = f.gameVersions || [];
  return {
    source: 'curseforge',
    projectId: String(f.modId),
    key: keyOf('curseforge', f.modId),
    id: String(f.id),
    name: f.displayName,
    number: f.displayName,
    type: RELEASE[f.releaseType] || 'release',
    minecraft: gv.filter((v) => /^\d+\.\d+(\.\d+)?$/.test(v)),
    loaders: gv.map((v) => LOADER_NAMES[v]).filter(Boolean),
    published: f.fileDate,
    side: sideFromGameVersions(gv),
    files: [{ filename: f.fileName, url: blocked ? null : f.downloadUrl, size: f.fileLength, primary: true, hashes: { sha1, md5 } }],
    deps: (f.dependencies || []).map((d) => ({
      key: keyOf('curseforge', d.modId),
      projectId: String(d.modId),
      versionId: null,
      kind: RELATION[d.relationType] || 'optional',
    })),
    blocked,
    available: f.isAvailable !== false,
  };
}

class CurseForgeProvider {
  /** backend — адрес сервера easyLauncher (прокси добавляет ключ), apiKey — только для разработки. */
  constructor({ backend = '', apiKey = process.env.EASYLAUNCHER_CF_API_KEY || '' } = {}) {
    this.id = 'curseforge';
    this.name = 'CurseForge';
    this.direct = !!apiKey;
    this.apiKey = apiKey;
    this.base = apiKey ? 'https://api.curseforge.com' : backend ? backend.replace(/\/$/, '') + '/cf' : '';
    this.cache = new Map();
    this.mods = new Map();
  }

  status() {
    if (!this.base)
      return { available: false, reason: 'CurseForge подключается через сервер easyLauncher, а он не настроен.' };
    return { available: true };
  }

  async get(path, params, { method = 'GET', json } = {}) {
    const st = this.status();
    if (!st.available) throw Object.assign(new Error(st.reason), { code: 'NOT_CONFIGURED' });
    const url = this.base + path + (params ? '?' + new URLSearchParams(params) : '');
    const cacheKey = method + url + (json ? JSON.stringify(json) : '');
    const hit = this.cache.get(cacheKey);
    if (hit && hit.until > Date.now()) return hit.data;
    let data;
    try {
      // сеть иногда обрывается на полпути (большие сборки — сотни запросов): до двух повторов, кроме ответов «нет»/«нельзя»
      for (let i = 0; ; i++) {
        try {
          data = await api(url, { method, json, headers: this.direct ? { 'x-api-key': this.apiKey } : {} });
          break;
        } catch (e) {
          if (i >= 2 || (e.status && e.status !== 429 && e.status < 500)) throw e;
          await new Promise((r) => setTimeout(r, 600 * (i + 1)));
        }
      }
    } catch (e) {
      if (e.status === 401 || e.status === 403)
        throw Object.assign(new Error('CurseForge отклонил доступ (ошибка авторизации API). Это настройка сервера easyLauncher, а не твоя.'), { code: 'AUTH' });
      if (e.status === 404) throw Object.assign(new Error('Не найдено на CurseForge.'), { code: 'NOT_FOUND' });
      if (e.status === 429) throw Object.assign(new Error('CurseForge ограничил частоту запросов. Подожди минуту.'), { code: 'RATE_LIMIT' });
      throw Object.assign(new Error('CurseForge недоступен: ' + e.message), { code: 'NETWORK' });
    }
    this.cache.set(cacheKey, { data, until: Date.now() + 5 * 60 * 1000 });
    return data;
  }

  async categories() {
    const r = await this.get('/v1/categories', { gameId: String(GAME_MINECRAFT), classId: String(CLASS_MODS) });
    return r.data.map((c) => ({ id: String(c.id), name: c.name }));
  }

  async search({ query = '', minecraft, loader, category, sort = 'relevance', offset = 0, limit = 20, anyVersion = false }) {
    const params = {
      gameId: String(GAME_MINECRAFT),
      classId: String(CLASS_MODS),
      searchFilter: query,
      sortField: String(SORTS[sort] || 1),
      sortOrder: 'desc',
      index: String(offset),
      pageSize: String(Math.min(limit, 50)),
    };
    if (!anyVersion && minecraft) params.gameVersion = minecraft;
    if (!anyVersion && LOADERS[loader]) params.modLoaderType = String(LOADERS[loader]);
    if (category) params.categoryId = String(category);
    const r = await this.get('/v1/mods/search', params);
    for (const m of r.data) this.mods.set(String(m.id), m);
    return { total: r.pagination?.totalCount ?? r.data.length, hits: r.data.map(normProject) };
  }

  async rawMod(id) {
    if (this.mods.has(String(id))) return this.mods.get(String(id));
    const r = await this.get(`/v1/mods/${encodeURIComponent(id)}`);
    this.mods.set(String(id), r.data);
    return r.data;
  }

  async project(id) {
    return normProject(await this.rawMod(id));
  }

  /** Несколько модов одним запросом (POST /v1/mods) — для картинок состава сборки. */
  async projects(ids) {
    const out = [];
    for (let i = 0; i < ids.length; i += 50) {
      const r = await this.get('/v1/mods', null, { method: 'POST', json: { modIds: ids.slice(i, i + 50).map(Number).filter(Number.isInteger) } });
      for (const m of r.data || []) {
        this.mods.set(String(m.id), m);
        out.push(normProject(m));
      }
    }
    return out;
  }

  async versions(id, { minecraft, loader, all = false } = {}) {
    const mod = await this.rawMod(id);
    const params = { pageSize: '50' };
    if (!all && minecraft) params.gameVersion = minecraft;
    if (!all && LOADERS[loader]) params.modLoaderType = String(LOADERS[loader]);
    const r = await this.get(`/v1/mods/${encodeURIComponent(id)}/files`, params);
    return r.data.map((f) => normFile(f, mod));
  }

  async version(projectId, fileId) {
    const mod = await this.rawMod(projectId);
    const r = await this.get(`/v1/mods/${encodeURIComponent(projectId)}/files/${encodeURIComponent(fileId)}`);
    return normFile(r.data, mod);
  }

  async byHashes() {
    // CurseForge сопоставляет файлы по отпечатку (byFingerprints), а не по SHA-1
    return {};
  }

  /**
   * Точные файлы по отпечаткам: { [fingerprint]: { projectId, fileId } }. Нужен прокси с разрешённым
   * POST /v1/fingerprints/432 (cf-worker/worker.js) — старый прокси отвечает 404, тогда {} без ошибки.
   */
  async byFingerprints(fps) {
    const out = {};
    const list = [...new Set(fps.filter((x) => Number.isInteger(x) && x >= 0))];
    for (let i = 0; i < list.length; i += 500) {
      let r;
      try {
        r = await this.get(`/v1/fingerprints/${GAME_MINECRAFT}`, null, { method: 'POST', json: { fingerprints: list.slice(i, i + 500) } });
      } catch (e) {
        if (e.code === 'NOT_FOUND') return out;
        throw e;
      }
      for (const x of r.data?.exactMatches || []) {
        const fp = x.file?.fileFingerprint;
        if (Number.isInteger(fp)) out[fp] = { projectId: String(x.id ?? x.file.modId), fileId: String(x.file.id) };
      }
    }
    return out;
  }
}

module.exports = { CurseForgeProvider, normFile, normProject, fingerprint, LOADERS, GAME_MINECRAFT, CLASS_MODS };
