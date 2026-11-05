// Прокси каталога CurseForge для easyLauncher на Cloudflare Workers (бесплатный тариф).
// Ключ хранится в секрете CF_API_KEY (Settings → Variables and Secrets), в коде и в лаунчере его нет.
// Пропускается только чтение каталога Minecraft: поиск, мод, файлы, категории — и три пакетных запроса
// с телом (POST): несколько модов сразу, несколько файлов сразу и поиск файла по отпечатку.

const UPSTREAM = 'https://api.curseforge.com';
const ALLOWED = [/^\/v1\/mods\/search$/, /^\/v1\/mods\/\d+$/, /^\/v1\/mods\/\d+\/files$/, /^\/v1\/mods\/\d+\/files\/\d+$/, /^\/v1\/categories$/];
// POST: путь → поле тела со списком чисел (не больше 500, тело не больше 64 КБ)
const POSTS = { '/v1/mods': 'modIds', '/v1/mods/files': 'fileIds', '/v1/fingerprints/432': 'fingerprints' };
const CACHE_SECONDS = 300;

function json(status, data) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // Лаунчер обращается к <адрес>/cf/v1/..., как к серверу комнат
    const path = url.pathname.replace(/^\/cf(?=\/)/, '');
    if (path === '/' || path === '/health') return json(200, { ok: true, curseforge: !!env.CF_API_KEY, post: Object.keys(POSTS) });
    if (request.method === 'POST' && POSTS[path]) return post(request, path, env);
    if (request.method !== 'GET' || !ALLOWED.some((re) => re.test(path))) return json(404, { error: 'not found' });
    if (!env.CF_API_KEY) return json(503, { error: 'CurseForge не настроен: добавь секрет CF_API_KEY' });
    // Поиск — только по Minecraft
    if (path === '/v1/mods/search' && url.searchParams.get('gameId') !== '432') return json(400, { error: 'only Minecraft' });
    if (path === '/v1/categories' && url.searchParams.get('gameId') !== '432') return json(400, { error: 'only Minecraft' });

    const upstream = UPSTREAM + path + url.search;
    const cache = typeof caches !== 'undefined' ? caches.default : null;
    const cacheKey = new Request(upstream, { method: 'GET' });
    if (cache) {
      const hit = await cache.match(cacheKey);
      if (hit) return hit;
    }
    const r = await fetch(upstream, { headers: { 'x-api-key': env.CF_API_KEY, Accept: 'application/json', 'User-Agent': 'easyLauncher-proxy/1.0' } });
    if (!r.ok) return json(r.status === 403 ? 502 : r.status, { error: 'upstream', status: r.status });
    const body = await r.text();
    const resp = new Response(body, { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': `public, max-age=${CACHE_SECONDS}` } });
    if (cache && ctx?.waitUntil) ctx.waitUntil(cache.put(cacheKey, resp.clone()));
    return resp;
  },
};

/** Пакетный запрос: тело — только {поле: [целые числа]}, ничего лишнего к CurseForge не уходит. */
async function post(request, path, env) {
  if (!env.CF_API_KEY) return json(503, { error: 'CurseForge не настроен: добавь секрет CF_API_KEY' });
  const text = await request.text();
  if (text.length > 64 * 1024) return json(413, { error: 'too large' });
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return json(400, { error: 'bad json' });
  }
  const field = POSTS[path];
  const list = body?.[field];
  if (!Array.isArray(list) || !list.length || list.length > 500 || !list.every((x) => Number.isInteger(x) && x >= 0)) return json(400, { error: `need ${field}: [numbers]` });
  const r = await fetch(UPSTREAM + path, {
    method: 'POST',
    headers: { 'x-api-key': env.CF_API_KEY, Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'easyLauncher-proxy/1.0' },
    body: JSON.stringify({ [field]: list }),
  });
  if (!r.ok) return json(r.status === 403 ? 502 : r.status, { error: 'upstream', status: r.status });
  return new Response(await r.text(), { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}
