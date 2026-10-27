'use strict';
// Вход через Microsoft: OAuth 2.0 (PKCE) → Xbox Live → XSTS → Minecraft Services.
const crypto = require('crypto');
const { api } = require('./http');

const AUTHORITY = 'https://login.microsoftonline.com/consumers/oauth2/v2.0';
const REDIRECT_URI = 'https://login.microsoftonline.com/common/oauth2/nativeclient';
const SCOPE = 'XboxLive.signin offline_access';

const XERR = {
  2148916233: 'У этого аккаунта Microsoft нет профиля Xbox. Зайди на xbox.com, создай профиль и попробуй снова.',
  2148916235: 'Xbox Live недоступен в твоей стране.',
  2148916236: 'Для аккаунта нужно подтверждение взрослого на xbox.com.',
  2148916237: 'Для аккаунта нужно подтверждение взрослого на xbox.com.',
  2148916238: 'Это детский аккаунт: взрослый должен добавить его в семейную группу Microsoft.',
};

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Ссылка на страницу входа Microsoft и данные PKCE для обмена кода. */
function createLoginRequest(clientId) {
  if (!clientId) throw new Error('Не указан Client ID приложения Azure (Настройки → Аккаунт Microsoft).');
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  const state = base64url(crypto.randomBytes(16));
  const q = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: SCOPE,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    prompt: 'select_account',
  });
  return { url: `${AUTHORITY}/authorize?${q}`, verifier, state, redirectUri: REDIRECT_URI };
}

/** Разбор адреса, на который Microsoft вернул пользователя. null — это ещё не наш адрес. */
function parseRedirect(url, state) {
  if (!url.startsWith(REDIRECT_URI)) return null;
  const u = new URL(url);
  const p = u.searchParams;
  if (p.get('error')) {
    const e = new Error(
      p.get('error') === 'access_denied' ? 'Вход отменён.' : p.get('error_description') || p.get('error'),
    );
    e.code = p.get('error');
    throw e;
  }
  if (p.get('state') !== state) throw new Error('Ответ Microsoft не прошёл проверку (state). Попробуй ещё раз.');
  const code = p.get('code');
  if (!code) throw new Error('Microsoft не вернул код авторизации.');
  return code;
}

function msError(e) {
  const d = e.data || {};
  if (d.error === 'invalid_grant') return Object.assign(new Error('Сессия Microsoft истекла. Войди снова.'), { relogin: true });
  if (d.error === 'unauthorized_client' || d.error === 'invalid_client')
    return new Error('Client ID не подходит: проверь регистрацию приложения в Azure (тип «Personal Microsoft accounts», redirect nativeclient).');
  return new Error('Microsoft: ' + (d.error_description || d.error || e.message));
}

async function exchangeCode(clientId, code, verifier) {
  try {
    return await api(`${AUTHORITY}/token`, {
      method: 'POST',
      form: { client_id: clientId, grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, code_verifier: verifier, scope: SCOPE },
    });
  } catch (e) {
    throw msError(e);
  }
}

async function refreshMs(clientId, refreshToken) {
  try {
    return await api(`${AUTHORITY}/token`, {
      method: 'POST',
      form: { client_id: clientId, grant_type: 'refresh_token', refresh_token: refreshToken, redirect_uri: REDIRECT_URI, scope: SCOPE },
    });
  } catch (e) {
    throw msError(e);
  }
}

/** Токен Microsoft → профиль и токен Minecraft. */
async function minecraftLogin(msAccessToken) {
  const xbl = await api('https://user.auth.xboxlive.com/user/authenticate', {
    method: 'POST',
    json: {
      Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: 'd=' + msAccessToken },
      RelyingParty: 'http://auth.xboxlive.com',
      TokenType: 'JWT',
    },
  }).catch((e) => {
    throw new Error('Xbox Live не принял вход: ' + e.message);
  });
  let xsts;
  try {
    xsts = await api('https://xsts.auth.xboxlive.com/xsts/authorize', {
      method: 'POST',
      json: {
        Properties: { SandboxId: 'RETAIL', UserTokens: [xbl.Token] },
        RelyingParty: 'rp://api.minecraftservices.com/',
        TokenType: 'JWT',
      },
    });
  } catch (e) {
    throw new Error(XERR[e.data?.XErr] || 'Xbox Live (XSTS): ' + e.message);
  }
  const uhs = xsts.DisplayClaims?.xui?.[0]?.uhs;
  const xid = xbl.DisplayClaims?.xui?.[0]?.xid || '';
  let mc;
  try {
    mc = await api('https://api.minecraftservices.com/authentication/login_with_xbox', {
      method: 'POST',
      json: { identityToken: `XBL3.0 x=${uhs};${xsts.Token}` },
    });
  } catch (e) {
    // Mojang ещё не одобрил лаунчер для входа: это не ошибка игрока — объясняем и предлагаем играть без входа
    if (e.status === 403)
      throw Object.assign(new Error('Вход через Microsoft пока недоступен: Mojang ещё не одобрил easyLauncher для входа. Твой аккаунт в порядке.'), {
        code: 'APP_NOT_APPROVED',
        action: 'Нажми «Играть без входа» — одиночная игра и игра по локальной сети работают. Вход заработает в одном из следующих обновлений.',
      });
    throw new Error('Minecraft Services: ' + e.message);
  }
  let profile;
  try {
    profile = await api('https://api.minecraftservices.com/minecraft/profile', {
      headers: { Authorization: 'Bearer ' + mc.access_token },
    });
  } catch (e) {
    if (e.status === 404) throw new Error('На этом аккаунте нет Minecraft Java Edition. Купить игру можно на minecraft.net.');
    throw new Error('Профиль Minecraft: ' + e.message);
  }
  return {
    name: profile.name,
    uuid: profile.id,
    xuid: xid,
    accessToken: mc.access_token,
    expiresAt: Date.now() + (mc.expires_in || 86400) * 1000,
    skin: profile.skins?.find((s) => s.state === 'ACTIVE')?.url || null,
  };
}

module.exports = { createLoginRequest, parseRedirect, exchangeCode, refreshMs, minecraftLogin, REDIRECT_URI };
