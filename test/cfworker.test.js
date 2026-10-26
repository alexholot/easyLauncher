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
    const r = await worker.fetch(new Request('http://worker' + req.url, { method: req.method }), env, {});
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
