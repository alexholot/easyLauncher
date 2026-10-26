#!/usr/bin/env node
'use strict';
// Какие запросы каталога CurseForge доступны ключу. Положи рядом с index.js и запусти через node.
const { loadEnv } = require('./index');
loadEnv();
const key = process.env.CF_API_KEY || '';
const H = { Accept: 'application/json', 'Content-Type': 'application/json', 'x-api-key': key, 'User-Agent': 'easyLauncher/2.0' };
const B = 'https://api.curseforge.com/v1';
const tests = [
  ['Поиск: только игра', 'GET', '/mods/search?gameId=432'],
  ['Поиск: игра + моды', 'GET', '/mods/search?gameId=432&classId=6'],
  ['Поиск: по тексту', 'GET', '/mods/search?gameId=432&searchFilter=jei'],
  ['Поиск: по slug', 'GET', '/mods/search?gameId=432&classId=6&slug=jei'],
  ['Поиск: сортировка', 'GET', '/mods/search?gameId=432&classId=6&sortField=2&sortOrder=desc&pageSize=5'],
  ['Моды по ID (POST)', 'POST', '/mods', { modIds: [238222, 306612] }],
  ['Файлы мода', 'GET', '/mods/238222/files?pageSize=3'],
  ['Описание мода', 'GET', '/mods/238222/description'],
  ['Избранные (POST)', 'POST', '/mods/featured', { gameId: 432, excludedModIds: [] }],
  ['Версии игры', 'GET', '/games/432/versions'],
];
(async () => {
  for (const [name, method, path, body] of tests) {
    try {
      const r = await fetch(B + path, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
      const t = (await r.text()).replace(/\s+/g, ' ');
      console.log(`${r.ok ? '✓' : '✗'} ${name.padEnd(22)} ${r.status} ${r.headers.get('server') || ''} ${r.ok ? '' : t.slice(0, 80)}`);
    } catch (e) {
      console.log(`✗ ${name.padEnd(22)} нет связи: ${e.message}`);
    }
  }
})();
