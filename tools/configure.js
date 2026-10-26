#!/usr/bin/env node
'use strict';
// Вшить настройки разработчика в сборку, чтобы игрокам ничего не настраивать:
//   node tools/configure.js --cf-proxy https://...workers.dev --ms-client-id <GUID> --backend https://rooms...
// Затем: npm run dist:win
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'package.json');
const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
const cfg = { backend: '', cfProxy: '', msClientId: '', ...(pkg.easylauncher || {}) };
const args = process.argv.slice(2);
process.on('uncaughtException', (e) => {
  console.log('✗ ' + e.message);
  process.exit(1);
});
const url = (v) => {
  const u = String(v || '').trim().replace(/\/+$/, '');
  if (u && !/^https:\/\/[\w.-]+(:\d+)?$/.test(u)) throw new Error('Адрес должен быть вида https://имя.домен (без пути): ' + v);
  return u;
};
for (let i = 0; i < args.length; i += 2) {
  const [k, v] = [args[i], args[i + 1]];
  if (k === '--cf-proxy') cfg.cfProxy = url(v);
  else if (k === '--backend') cfg.backend = url(v);
  else if (k === '--ms-client-id') {
    if (v && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) throw new Error('Client ID — GUID вида 00000000-0000-0000-0000-000000000000');
    cfg.msClientId = v || '';
  } else throw new Error('Неизвестный параметр ' + k);
}
pkg.easylauncher = cfg;
fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
console.log('Вшито в сборку:');
console.log('  Каталог CurseForge:', cfg.cfProxy || '— (только Modrinth)');
console.log('  Вход Microsoft    :', cfg.msClientId ? 'включён' : '— (только одиночная игра с никнеймом)');
console.log('  Сервер комнат     :', cfg.backend || '— (приглашения только в локальной сети)');
