#!/usr/bin/env node
'use strict';
// Проверка ключа CurseForge: node check-curseforge.js (ключ берётся из .env или CF_API_KEY).
// Печатает подробности ответа, чтобы отличить неверный ключ от блокировки сети. Сам ключ не выводится.
const { loadEnv } = require('./index');

loadEnv();
const key = process.env.CF_API_KEY || '';
if (!key) {
  console.log('✗ Ключ не найден. Запусти «1-ввести-ключ.bat».');
  process.exit(1);
}

const mask = (k) => (k.length > 12 ? `${k.slice(0, 7)}…${k.slice(-3)}` : '(слишком короткий)');
console.log(`Ключ из .env: ${mask(key)}, длина ${key.length}`);
if (/\s|["']/.test(key)) console.log('! В ключе есть пробелы или кавычки — скопируй его заново.');
if (key.startsWith('cfc_pat_')) console.log('! Это личный токен (cfc_pat_), а нужен ключ со страницы API keys (начинается с $2a$10$).');
else if (!key.startsWith('$2a$')) console.log('! Обычно ключ API начинается с $2a$10$ — проверь, что скопирован нужный.');
if (key.startsWith('$2a$') && key.length !== 60) console.log('! Ключ $2a$ обычно длиной 60 символов — похоже, скопирован не целиком.');

async function attempt(label, url, headers) {
  try {
    const r = await fetch(url, { headers: { Accept: 'application/json', 'x-api-key': key, ...headers } });
    const body = (await r.text()).replace(/\s+/g, ' ').slice(0, 200);
    const server = r.headers.get('server') || '-';
    const ray = r.headers.get('cf-ray') ? ' cf-ray' : '';
    console.log(`${label}: ${r.status} (server: ${server}${ray})${r.ok ? '' : ' ответ: ' + (body || '(пусто)')}`);
    return { ok: r.ok, status: r.status, body };
  } catch (e) {
    console.log(`${label}: нет связи — ${e.message}`);
    return { ok: false, status: 0 };
  }
}

(async () => {
  const ua = { 'User-Agent': 'easyLauncher/2.0 (minecraft launcher)' };
  const MC = 'https://api.curseforge.com/v1';
  const games = await attempt('Список игр, твой ключ      ', `${MC}/games`, ua);
  // контроль: отвечает ли этот адрес вообще без настоящего ключа
  const fake = await attemptWith('Список игр, поддельный ключ', `${MC}/games`, '$2a$10$' + 'x'.repeat(53), ua);
  const cats = await attempt('Категории Minecraft        ', `${MC}/categories?gameId=432&classId=6`, ua);
  const mod = await attempt('Мод JEI (id 238222)        ', `${MC}/mods/238222`, ua);
  const search = await attempt('Поиск модов                ', `${MC}/mods/search?gameId=432&classId=6&searchFilter=jei&pageSize=3`, ua);
  console.log('');
  if (search.ok && mod.ok) {
    console.log('✓ Ключ работает: поиск и моды Minecraft доступны.');
    process.exit(0);
  }
  if ([games, cats, mod, search].every((r) => r.status === 0)) {
    console.log('✗ Нет связи с api.curseforge.com — проверь интернет, VPN или антивирус.');
    process.exit(1);
  }
  if (fake.ok) console.log('• Список игр открывается даже с поддельным ключом — по нему нельзя судить, принят ли ключ.');
  if (!mod.ok && !search.ok && !cats.ok)
    console.log('✗ Ключ не принимается для данных Minecraft. Проверь в console.curseforge.com → API keys, что ключ скопирован после последнего Regenerate (старый перестаёт работать сразу). Если ключ свежий — новые ключи иногда начинают работать не сразу: повтори через 15–30 минут. Если не заработает — напиши в поддержку через «Contact us».');
  else if (!search.ok) console.log('✗ Часть запросов проходит, а поиск — нет. Пришли скриншот этого окна.');
  else console.log('✗ Пришли скриншот этого окна.');
  process.exit(1);
})();

async function attemptWith(label, url, k, headers) {
  try {
    const r = await fetch(url, { headers: { Accept: 'application/json', 'x-api-key': k, ...headers } });
    console.log(`${label}: ${r.status}`);
    return { ok: r.ok, status: r.status };
  } catch (e) {
    console.log(`${label}: нет связи — ${e.message}`);
    return { ok: false, status: 0 };
  }
}
