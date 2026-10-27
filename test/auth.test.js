'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const http = require('../core/http');
const auth = require('../core/auth');
const { Accounts } = require('../core/accounts');

const CID = '11111111-2222-3333-4444-555555555555';
const plainVault = { available: true, encrypt: (t) => Buffer.from(t).reverse(), decrypt: (b) => Buffer.from(b).reverse().toString() };

function mockFetch(routes, log = []) {
  http.setFetch(async (url, init = {}) => {
    log.push({ url, init });
    const h = routes[url.split('?')[0]];
    const [status, body] = h ? h(init) : [404, {}];
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  });
  return log;
}

const goodRoutes = (counter = {}) => ({
  'https://login.microsoftonline.com/consumers/oauth2/v2.0/token': (init) => {
    const p = new URLSearchParams(init.body);
    counter[p.get('grant_type')] = (counter[p.get('grant_type')] || 0) + 1;
    return [200, { access_token: 'ms-at', refresh_token: 'ms-rt-' + p.get('grant_type') }];
  },
  'https://user.auth.xboxlive.com/user/authenticate': (init) => {
    assert.equal(JSON.parse(init.body).Properties.RpsTicket, 'd=ms-at');
    return [200, { Token: 'xbl', DisplayClaims: { xui: [{ uhs: 'UHS' }] } }];
  },
  'https://xsts.auth.xboxlive.com/xsts/authorize': () => [200, { Token: 'xsts', DisplayClaims: { xui: [{ uhs: 'UHS' }] } }],
  'https://api.minecraftservices.com/authentication/login_with_xbox': (init) => {
    assert.equal(JSON.parse(init.body).identityToken, 'XBL3.0 x=UHS;xsts');
    return [200, { access_token: 'mc-token', expires_in: 86400 }];
  },
  'https://api.minecraftservices.com/minecraft/profile': (init) => {
    assert.equal(init.headers.Authorization, 'Bearer mc-token');
    return [200, { id: 'abcdef0123456789abcdef0123456789', name: 'RealPlayer', skins: [] }];
  },
});

test('PKCE-ссылка и разбор redirect', () => {
  const r = auth.createLoginRequest(CID);
  const u = new URL(r.url);
  assert.equal(u.searchParams.get('client_id'), CID);
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  const expected = crypto.createHash('sha256').update(r.verifier).digest('base64url');
  assert.equal(u.searchParams.get('code_challenge'), expected);
  assert.equal(auth.parseRedirect('https://login.live.com/other', r.state), null);
  assert.equal(auth.parseRedirect(`${r.redirectUri}?code=XYZ&state=${r.state}`, r.state), 'XYZ');
  assert.throws(() => auth.parseRedirect(`${r.redirectUri}?code=XYZ&state=bad`, r.state), /state/);
  assert.throws(() => auth.parseRedirect(`${r.redirectUri}?error=access_denied`, r.state), /отменён/);
  assert.throws(() => auth.createLoginRequest(''), /Client ID/);
});

test('цепочка Microsoft → Xbox → XSTS → Minecraft', async () => {
  mockFetch(goodRoutes());
  const mc = await auth.minecraftLogin('ms-at');
  assert.equal(mc.name, 'RealPlayer');
  assert.equal(mc.accessToken, 'mc-token');
  assert.ok(mc.expiresAt > Date.now());
});

test('понятные ошибки: нет Xbox-профиля, нет игры, неодобренный Client ID', async () => {
  const routes = goodRoutes();
  routes['https://xsts.auth.xboxlive.com/xsts/authorize'] = () => [401, { XErr: 2148916233 }];
  mockFetch(routes);
  await assert.rejects(auth.minecraftLogin('ms-at'), /профиля Xbox/);
  const r2 = goodRoutes();
  r2['https://api.minecraftservices.com/minecraft/profile'] = () => [404, { error: 'NOT_FOUND' }];
  mockFetch(r2);
  await assert.rejects(auth.minecraftLogin('ms-at'), /нет Minecraft/);
  const r3 = goodRoutes();
  r3['https://api.minecraftservices.com/authentication/login_with_xbox'] = () => [403, {}];
  mockFetch(r3);
  await assert.rejects(auth.minecraftLogin('ms-at'), (e) => e.code === 'APP_NOT_APPROVED' && /не одобрил/.test(e.message) && /Играть без входа/.test(e.action));
});

test('аккаунт: вход, шифрованное хранение, обновление токена, выход', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-acc-'));
  const counter = {};
  mockFetch(goodRoutes(counter));
  const acc = new Accounts(root, plainVault);
  acc.setClientId(CID);
  assert.throws(() => acc.setClientId('nope'), /GUID/);
  const st = await acc.completeLogin('CODE', 'verifier');
  assert.equal(st.account.name, 'RealPlayer');
  const disk = fs.readFileSync(path.join(root, 'accounts.json'), 'utf8');
  assert.ok(!disk.includes('mc-token') && !disk.includes('ms-rt'), 'токены не лежат на диске открытым текстом');

  // Перезапуск лаунчера: аккаунт читается, токен ещё свежий
  const again = new Accounts(root, plainVault);
  let la = await again.launchAuth();
  assert.equal(la.accessToken, 'mc-token');
  assert.equal(la.uuid, 'abcdef0123456789abcdef0123456789');
  assert.equal(counter.refresh_token || 0, 0);

  // Токен истёк → обновление через refresh_token
  again.secret.expiresAt = Date.now();
  la = await again.launchAuth();
  assert.equal(counter.refresh_token, 1);
  assert.equal(again.secret.refreshToken, 'ms-rt-refresh_token');

  again.logout();
  assert.equal(await again.launchAuth(), null);
  assert.equal(new Accounts(root, plainVault).status().account, null);
});

test('аргументы запуска с аккаунтом Microsoft', () => {
  const { buildClientArgs } = require('../core/mojang');
  const v = {
    id: '1.21.1', mainClass: 'M',
    arguments: { game: ['--username', '${auth_player_name}', '--uuid', '${auth_uuid}', '--accessToken', '${auth_access_token}', '--userType', '${user_type}', '--clientId', '${clientid}'], jvm: [] },
  };
  const args = buildClientArgs(v, {
    gameDir: '/g', assetsDir: '/a', assetIndex: '17', classpath: [], nativesDir: '/n', librariesDir: '/l', username: 'ignored', ram: 4,
    auth: { name: 'RealPlayer', uuid: 'abc', accessToken: 'mc-token', xuid: '', clientId: CID },
  }, { os: 'linux' });
  const val = (k) => args[args.indexOf(k) + 1];
  assert.equal(val('--username'), 'RealPlayer');
  assert.equal(val('--uuid'), 'abc');
  assert.equal(val('--accessToken'), 'mc-token');
  assert.equal(val('--userType'), 'msa');
  assert.equal(val('--clientId'), CID);
});
