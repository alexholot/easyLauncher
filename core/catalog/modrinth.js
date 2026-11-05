'use strict';
// Modrinth API v2 (https://api.modrinth.com/v2). Чтение публичное, ключ не нужен.
const { api } = require('../http');
const { keyOf } = require('../lock');

const BASE = 'https://api.modrinth.com/v2';
const SORTS = { relevance: 'relevance', downloads: 'downloads', updated: 'updated', newest: 'newest', follows: 'follows' };

/** Поле environment у новых релизов Modrinth → стороны установки. */
const ENV_SIDES = {
  client_only: ['required', 'unsupported'],
  singleplayer_only: ['required', 'unsupported'],
  server_only: ['unsupported', 'required'],
  dedicated_server_only: ['unsupported', 'required', true],
  client_and_server: ['required', 'required'],
  server_only_client_optional: ['optional', 'required'],
  client_only_server_optional: ['required', 'optional'],
  client_or_server: ['optional', 'optional'],
  client_or_server_prefers_both: ['optional', 'optional'],
};
function sideOf(env, project) {
  // dedicated: мод работает только на выделенном сервере — в одиночную игру его не кладём
  if (ENV_SIDES[env]) return ENV_SIDES[env][2] ? { client: ENV_SIDES[env][0], server: ENV_SIDES[env][1], dedicated: true } : { client: ENV_SIDES[env][0], server: ENV_SIDES[env][1] };
  const norm = (v) => (['required', 'optional', 'unsupported'].includes(v) ? v : 'unknown');
  return { client: norm(project?.client_side), server: norm(project?.server_side) };
}

function normProject(p) {
  const id = p.project_id || p.id;
  return {
    key: keyOf('modrinth', id),
    source: 'modrinth',
    id,
    slug: p.slug,
    name: p.title,
    author: p.author || null,
    summary: p.description || '',
    iconUrl: p.icon_url || null,
    url: `https://modrinth.com/${p.project_type || 'mod'}/${p.slug || id}`,
    categories: p.display_categories || p.categories || [],
    downloads: p.downloads || 0,
    updated: p.date_modified || p.updated || null,
    gameVersions: p.versions || p.game_versions || [],
    loaders: p.loaders || null,
    side: sideOf(null, p),
    distribution: 'allowed',
  };
}

function normVersion(v, project) {
  return {
    source: 'modrinth',
    projectId: v.project_id,
    key: keyOf('modrinth', v.project_id),
    id: v.id,
    name: v.name,
    number: v.version_number,
    type: v.version_type, // release | beta | alpha
    minecraft: v.game_versions || [],
    loaders: v.loaders || [],
    published: v.date_published,
    side: sideOf(v.environment, project),
    files: (v.files || []).map((f) => ({
      filename: f.filename,
      url: f.url,
      size: f.size,
      primary: !!f.primary,
      hashes: { sha1: f.hashes?.sha1, sha512: f.hashes?.sha512 },
    })),
    deps: (v.dependencies || []).map((d) => ({
      key: d.project_id ? keyOf('modrinth', d.project_id) : null,
      projectId: d.project_id || null,
      versionId: d.version_id || null,
      kind: d.dependency_type, // required | optional | incompatible | embedded
    })),
    blocked: false,
  };
}

class ModrinthProvider {
  constructor({ base = BASE } = {}) {
    this.base = base;
    this.name = 'Modrinth';
    this.id = 'modrinth';
    this.cache = new Map();
  }

  async get(path, params) {
    const url = this.base + path + (params ? '?' + new URLSearchParams(params) : '');
    const hit = this.cache.get(url);
    if (hit && hit.until > Date.now()) return hit.data;
    let data;
    try {
      data = await api(url);
    } catch (e) {
      if (e.status === 404) throw Object.assign(new Error('Проект не найден на Modrinth.'), { code: 'NOT_FOUND' });
      if (e.status === 429) throw Object.assign(new Error('Modrinth ограничил частоту запросов. Подожди минуту.'), { code: 'RATE_LIMIT' });
      throw Object.assign(new Error('Modrinth недоступен: ' + e.message), { code: 'NETWORK' });
    }
    this.cache.set(url, { data, until: Date.now() + 5 * 60 * 1000 });
    return data;
  }

  status() {
    return { available: true };
  }

  async categories() {
    const list = await this.get('/tag/category');
    return list.filter((c) => c.project_type === 'mod' && c.header === 'categories').map((c) => ({ id: c.name, name: c.name }));
  }

  /** Поиск. По умолчанию — только моды под версию и загрузчик профиля. */
  async search({ query = '', minecraft, loader, category, sort = 'relevance', offset = 0, limit = 20, anyVersion = false }) {
    const facets = [['project_type:mod']];
    if (!anyVersion && minecraft) facets.push([`versions:${minecraft}`]);
    // Quilt запускает и моды Fabric — ищем оба
    if (!anyVersion && loader && loader !== 'vanilla') facets.push(loader === 'quilt' ? ['categories:quilt', 'categories:fabric'] : [`categories:${loader}`]);
    if (category) facets.push([`categories:${category}`]);
    const r = await this.get('/search', {
      query,
      facets: JSON.stringify(facets),
      index: SORTS[sort] || 'relevance',
      offset: String(offset),
      limit: String(Math.min(limit, 100)),
    });
    return { total: r.total_hits, hits: r.hits.map(normProject) };
  }

  async project(id) {
    const p = await this.get(`/project/${encodeURIComponent(id)}`);
    return { ...normProject({ ...p, project_id: p.id, versions: p.game_versions }), body: (p.body || '').slice(0, 4000) };
  }

  /**
   * Несколько проектов одним запросом (по id или slug); неизвестные просто отсутствуют в ответе.
   * Каждый ответ кладётся в кэш как /project/{id} и /project/{slug}: план потом не запрашивает их заново.
   */
  async projects(ids) {
    const out = [];
    for (let i = 0; i < ids.length; i += 80) {
      const list = await this.get('/projects', { ids: JSON.stringify(ids.slice(i, i + 80)) });
      const until = Date.now() + 5 * 60 * 1000;
      for (const p of list || []) {
        for (const k of [p.id, p.slug]) if (k) this.cache.set(`${this.base}/project/${encodeURIComponent(k)}`, { data: p, until });
        out.push({ ...normProject({ ...p, project_id: p.id, versions: p.game_versions }), loaders: p.loaders || [] });
      }
    }
    return out;
  }

  /**
   * Релизы пачкой (GET /versions?ids=…) — кладутся в кэш как /version/{id}: план большой сборки
   * потом не спрашивает каждый релиз отдельно (иначе сотни запросов и ограничение частоты).
   */
  async warmVersions(ids) {
    const list = [...new Set(ids.filter(Boolean))];
    for (let i = 0; i < list.length; i += 100) {
      const r = await this.get('/versions', { ids: JSON.stringify(list.slice(i, i + 100)) });
      const until = Date.now() + 5 * 60 * 1000;
      for (const v of r || []) this.cache.set(`${this.base}/version/${encodeURIComponent(v.id)}`, { data: v, until });
    }
  }

  /** Релизы проекта. all=true — без фильтра по версии/загрузчику (для просмотра несовместимых). */
  async versions(id, { minecraft, loader, all = false } = {}) {
    const params = {};
    if (!all && minecraft) params.game_versions = JSON.stringify([minecraft]);
    if (!all && loader && loader !== 'vanilla') params.loaders = JSON.stringify(loader === 'quilt' ? ['quilt', 'fabric'] : [loader]);
    const [list, project] = await Promise.all([this.get(`/project/${encodeURIComponent(id)}/version`, params), this.get(`/project/${encodeURIComponent(id)}`)]);
    return list.map((v) => normVersion(v, project));
  }

  async version(projectId, versionId) {
    const v = await this.get(`/version/${encodeURIComponent(versionId)}`);
    const project = await this.get(`/project/${encodeURIComponent(projectId || v.project_id)}`);
    return normVersion(v, project);
  }

  /** Поиск релизов по SHA-1 файлов: сопоставление по проверенным данным, а не по названию. */
  async byHashes(sha1s) {
    if (!sha1s.length) return {};
    const r = await api(this.base + '/version_files', { method: 'POST', json: { hashes: sha1s, algorithm: 'sha1' } });
    const out = {};
    for (const [hash, v] of Object.entries(r || {})) out[hash] = { key: keyOf('modrinth', v.project_id), projectId: v.project_id, versionId: v.id };
    return out;
  }
}

module.exports = { ModrinthProvider, sideOf, normVersion, normProject };
