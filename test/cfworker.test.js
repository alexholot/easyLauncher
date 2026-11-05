'use strict';
// Прокси CurseForge для Cloudflare Workers: запускается в Node через переходник Request/Response,
// CurseForge заменён заглушкой. Проверяется контракт «лаунчер ↔ прокси».
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const path = require('path');
const { pathToFileURL } = require('url');
const { CurseForgeProvider } = require('../core/catalog/curseforge');

let worker;
let srv;
let base;
const seen = [];
const realFetch = globalThis.fetch;

test.before(async () => {
  worker = (await import(pathToFileURL(path.join(__dirname, '..', 'cf-worker', 'worker.js')).href)).default;
  // «CurseForge»: отвечает только с правильным ключом
  globalThis.fetch = async (url, init = {}) => {
    if (!String(url).startsWith('https://api.curseforge.com')) return realFetch(url, init);
    seen.push({ url: String(url), key: init.headers['x-api-key'] });
    if (init.headers['x-api-key'] !== 'SECRET') return new Response('Forbidden', { status: 403 });
    return new Response(JSON.stringify({ data: [{ id: 238222, name: 'Just Enough Items', slug: 'jei', summary: 'x', authors: [], links: {}, categories: [], latestFilesIndexes: [] }], pagination: { totalCount: 1 } }), { status: 200 });
  };
  const env = { CF_API_KEY: 'SECRET' };
  srv = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const r = await worker.fetch(new Request('http://worker' + req.url, { method: req.method, body }), env, {});
    res.writeHead(r.status, Object.fromEntries(r.headers));
    res.end(await r.text());
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.address().port}`;
});
test.after(() => {
  globalThis.fetch = realFetch;
  srv.close();
});

test('лаунчер ищет моды CurseForge через прокси, ключ добавляет только прокси', async () => {
  const cf = new CurseForgeProvider({ backend: base, apiKey: '' });
  const r = await cf.search({ query: 'jei', minecraft: '1.21.1', loader: 'fabric' });
  assert.equal(r.hits[0].name, 'Just Enough Items');
  assert.equal(seen.at(-1).key, 'SECRET');
  assert.match(seen.at(-1).url, /\/v1\/mods\/search\?gameId=432/);
});

test('прокси пропускает только чтение каталога Minecraft', async () => {
  const get = (p, method = 'GET') => worker.fetch(new Request('http://w' + p, { method }), { CF_API_KEY: 'SECRET' }, {});
  assert.equal((await get('/health')).status, 200);
  assert.equal((await get('/cf/v1/mods/1/files/2/download-url')).status, 404);
  assert.equal((await get('/cf/v1/mods/search?gameId=1')).status, 400, 'другие игры закрыты');
  assert.equal((await get('/cf/v1/mods/search?gameId=432', 'POST')).status, 404);
  const noKey = await worker.fetch(new Request('http://w/cf/v1/mods/1'), {}, {});
  assert.equal(noKey.status, 503);
  const body = await (await get('/cf/v1/mods/238222')).text();
  assert.ok(!body.includes('SECRET'), 'ключ не уходит клиенту');
  const bad = await worker.fetch(new Request('http://w/cf/v1/mods/238222'), { CF_API_KEY: 'wrong' }, {});
  assert.equal(bad.status, 502, 'ошибка ключа на стороне CurseForge не выдаётся за ошибку лаунчера');
});

test('прокси: пакетные POST — только списки чисел, к CurseForge уходит только нужное поле', async () => {
  const post = (p, body) => worker.fetch(new Request('http://w' + p, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }), { CF_API_KEY: 'SECRET' }, {});
  const sent = [];
  const prev = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    sent.push({ url: String(url), body: init.body, method: init.method, key: init.headers['x-api-key'] });
    return new Response(JSON.stringify({ data: { exactMatches: [] } }), { status: 200 });
  };
  try {
    assert.equal((await post('/cf/v1/fingerprints/432', { fingerprints: [1, 2], extra: 'x' })).status, 200);
    assert.deepStrictEqual(JSON.parse(sent.at(-1).body), { fingerprints: [1, 2] }, 'лишние поля не пересылаются');
    assert.equal(sent.at(-1).method, 'POST');
    assert.equal(sent.at(-1).key, 'SECRET');
    assert.equal((await post('/cf/v1/mods', { modIds: [238222] })).status, 200);
    assert.equal((await post('/cf/v1/fingerprints/1', { fingerprints: [1] })).status, 404, 'отпечатки — только Minecraft');
    assert.equal((await post('/cf/v1/fingerprints/432', { fingerprints: ['x'] })).status, 400);
    assert.equal((await post('/cf/v1/fingerprints/432', { fingerprints: [] })).status, 400);
    assert.equal((await post('/cf/v1/fingerprints/432', { fingerprints: Array.from({ length: 501 }, (_, i) => i) })).status, 400);
    assert.equal((await post('/cf/v1/fingerprints/432', '{oops')).status, 400);
    assert.equal((await post('/cf/v1/mods/search', { modIds: [1] })).status, 404, 'остальное — только чтение');
  } finally {
    globalThis.fetch = prev;
  }
});

test('лаунчер: поиск файлов по отпечаткам; старый прокси без POST — без ошибки, пустой ответ', async () => {
  const cf = new CurseForgeProvider({ backend: base, apiKey: '' });
  const prev = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).startsWith('https://api.curseforge.com/v1/fingerprints/432'))
      return new Response(JSON.stringify({ data: { exactMatches: [{ id: 238222, file: { id: 4001, modId: 238222, fileFingerprint: 12345 } }] } }), { status: 200 });
    return prev(url, init);
  };
  try {
    assert.deepStrictEqual(await cf.byFingerprints([12345, 999]), { 12345: { projectId: '238222', fileId: '4001' } });
  } finally {
    globalThis.fetch = prev;
  }
  const old = new CurseForgeProvider({ backend: 'http://old', apiKey: '' });
  const prev2 = globalThis.fetch;
  globalThis.fetch = async () => new Response('{"error":"not found"}', { status: 404 });
  try {
    assert.deepStrictEqual(await old.byFingerprints([1]), {});
  } finally {
    globalThis.fetch = prev2;
  }
});
