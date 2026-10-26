'use strict';
// Настройки, вшитые в сборку разработчиком (package.json → "easylauncher"), чтобы игроку ничего не настраивать:
//   backend    — сервер комнат (приглашения, прямое соединение, relay)
//   cfProxy    — прокси каталога CurseForge (например, Cloudflare Worker)
//   msClientId — Client ID приложения Azure для входа через Microsoft
let pkg = {};
try {
  pkg = require('../package.json').easylauncher || {};
} catch {}

const DEFAULTS = {
  backend: process.env.EASYLAUNCHER_BACKEND || pkg.backend || '',
  cfProxy: process.env.EASYLAUNCHER_CF_PROXY || pkg.cfProxy || '',
  msClientId: process.env.EASYLAUNCHER_MS_CLIENT_ID || pkg.msClientId || '',
};

module.exports = { DEFAULTS };
