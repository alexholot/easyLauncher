'use strict';
// Подготовка сквозного теста интерфейса: Mojang, Fabric, Modrinth и CurseForge заменены локальными
// имитациями, сервер комнат запускается на localhost. Подключается через EASYLAUNCHER_E2E_SETUP
// (только в неупакованном приложении). Установка игры идёт настоящим конвейером лаунчера.
const http = require('../../core/http');
const { createMock } = require('../mockapi');
const { createFakeMojang } = require('../fakemojang');
const { createServer } = require('../../server');

module.exports = async function setup({ svc, accounts }) {
  const fm = await createFakeMojang({ delayMs: Number(process.env.E2E_DELAY_MS || 25), oldVersions: !!process.env.E2E_OLD });
  http.setFetch((url, o) => fetch(fm.rewrite(url), o));
  const mock = await createMock();
  mock.mr.projects.P_CREATE.title = 'Create';
  // тест управляет имитациями из главного процесса (electronApp.evaluate)
  global.__e2e = { mock, fakeMojang: fm };
  svc.opts.catalogBase = { modrinth: mock.base() + '/mr', curseforgeBackend: mock.base() };
  // у хозяина и друга свои заглушки CDN (в жизни это один cdn.modrinth.com)
  svc.launcher.cache.allowHosts = [/^http:\/\/127\.0\.0\.1:\d+\/cdn\//];
  if (!process.env.E2E_NO_BACKEND) {
    const rooms = createServer({ stun: '' });
    const port = await rooms.listen(0, '127.0.0.1');
    await svc.saveSettings({ backend: process.env.E2E_BACKEND || `http://127.0.0.1:${port}` });
  }
  // Вход Microsoft имитируется: настоящий вход требует сети и аккаунта
  const player = process.env.E2E_PLAYER || 'HostPlayer';
  const fakeAuth = { type: 'msa', name: player, uuid: player.toLowerCase(), accessToken: 'token', xuid: '', clientId: '' };
  let loggedIn = !process.env.E2E_LOGGED_OUT;
  accounts.launchAuth = async () => (loggedIn ? fakeAuth : null);
  accounts.status = () => ({ clientId: '11111111-2222-3333-4444-555555555555', secure: true, account: loggedIn ? { type: 'msa', name: player, uuid: player.toLowerCase() } : null });
  accounts.logout = () => (loggedIn = false);
  process.env.FAKE_CLIENT_MS = process.env.FAKE_CLIENT_MS || '4000';
  return {
    microsoftLogin: async () => {
      await new Promise((r) => setTimeout(r, 300));
      return { code: 'e2e', verifier: 'e2e' };
    },
    completeLogin: async () => {
      loggedIn = true;
      return accounts.status();
    },
  };
};
