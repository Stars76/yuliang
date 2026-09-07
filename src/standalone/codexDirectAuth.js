// Codex 直连 OAuth（device-code 流程，非标准 RFC8628）。环境无关：网络走全局 fetch
// （Electron=Node，安卓=原生插件桥），凭证结构 {accessToken, refreshToken, expiresAt, accountId}。
// 端点边界：仅 auth.openai.com（登录/续期）+ chatgpt.com/backend-api/wham/usage（只读额度）。
import { QuotaError } from './providers/http.js';

export const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const USERCODE_URL = 'https://auth.openai.com/api/accounts/deviceauth/usercode';
export const DEVICE_TOKEN_URL = 'https://auth.openai.com/api/accounts/deviceauth/token';
export const TOKEN_URL = 'https://auth.openai.com/oauth/token';
export const VERIFICATION_URL = 'https://auth.openai.com/codex/device';
export const DEVICE_REDIRECT_URI = 'https://auth.openai.com/deviceauth/callback';
export const ID_TOKEN_AUTH_CLAIM = 'https://api.openai.com/auth';

const LOGIN_TTL_MS = 15 * 60_000;
const PREEMPT_MS = 5 * 60_000; // token 剩余不足 5 分钟就提前续期

function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomVerifier() {
  const b = new Uint8Array(32);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(b);
  else for (let i = 0; i < b.length; i++) b[i] = (Math.random() * 256) | 0;
  return b64url(b);
}

async function postJson(url, body, headers = {}) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
      body: JSON.stringify(body ?? {}),
    });
  } catch {
    throw new QuotaError('unavailable', 'codex-direct: network error');
  }
  return { status: res.status, text: await res.text() };
}

function jsonOf(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 1) 申请设备码（附带 PKCE verifier，轮询成功后原样用于换 token）→ { deviceAuthId, userCode, intervalSeconds, codeVerifier } */
export async function requestDeviceCode(codeVerifier) {
  const { status, text } = await postJson(USERCODE_URL, { client_id: CLIENT_ID }, { originator: 'codex_cli_rs' });
  const j = jsonOf(text);
  if (status === 404 || j?.error === 'unauthorized_client' || j?.error === 'invalid_client') {
    throw new QuotaError('upstream_changed', '该账号不支持设备码登录');
  }
  if (status === 403) {
    throw new QuotaError('unavailable', '被 Cloudflare 拦截，请稍后再试');
  }
  if (status !== 200 || !j || !j.device_auth_id || !j.user_code) {
    throw new QuotaError('upstream_changed', `codex-direct: device code http ${status}`);
  }
  return { deviceAuthId: j.device_auth_id, userCode: j.user_code, intervalSeconds: Number(j.interval) > 0 ? Number(j.interval) : 5, codeVerifier: codeVerifier ?? randomVerifier() };
}

/** 3) 轮询授权码：等待中返回 null；成功返回 { authorizationCode, codeVerifier } */
export async function pollDeviceCode(device) {
  const { status, text } = await postJson(DEVICE_TOKEN_URL, {
    device_auth_id: device.deviceAuthId,
    user_code: device.userCode,
  });
  if (status >= 200 && status < 300) {
    const j = jsonOf(text);
    if (!j?.authorization_code) throw new QuotaError('upstream_changed', 'codex-direct: device token body invalid');
    return { authorizationCode: j.authorization_code, codeVerifier: device.codeVerifier };
  }
  if (status === 403 || status === 404) return null; // 仍在等待用户授权
  throw new QuotaError('upstream_changed', `codex-direct: device poll http ${status}`);
}

/** 4) 授权码 + PKCE 换 token → { accessToken, refreshToken, expiresAt, idToken } */
export async function exchangeDeviceCode(authorizationCode, codeVerifier) {
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code: authorizationCode,
    code_verifier: codeVerifier,
    client_id: CLIENT_ID,
    redirect_uri: DEVICE_REDIRECT_URI,
  });
  let res;
  try {
    res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: form.toString(),
    });
  } catch {
    throw new QuotaError('unavailable', 'codex-direct: network error');
  }
  const j = jsonOf(await res.text());
  if (res.status !== 200 || !j?.access_token) {
    throw new QuotaError('upstream_changed', `codex-direct: exchange http ${res.status}`);
  }
  return {
    accessToken: j.access_token,
    refreshToken: j.refresh_token ?? null,
    expiresAt: Date.now() + (Number(j.expires_in) > 0 ? Number(j.expires_in) * 1000 : 3600_000),
    idToken: j.id_token ?? null,
  };
}

/** 5) 从 id_token（只解 payload 不验签）取 chatgpt_account_id */
export function accountIdOf(idToken) {
  try {
    const payload = JSON.parse(atob(String(idToken).split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    const id = payload?.[ID_TOKEN_AUTH_CLAIM]?.chatgpt_account_id;
    return typeof id === 'string' && id ? id : null;
  } catch {
    return null;
  }
}

/** 新 PKCE verifier + device 会话打包 */
export function newDeviceSession() {
  return { codeVerifier: randomVerifier() };
}

/** 用 refreshToken 续期 → 新的凭证 fields（保留 accountId；refreshToken 未发则沿用旧的） */
export async function refreshSession(fields) {
  if (!fields?.refreshToken) return null;
  const res = await postJson(TOKEN_URL, {
    client_id: CLIENT_ID,
    grant_type: 'refresh_token',
    refresh_token: fields.refreshToken,
  });
  const j = jsonOf(res.text);
  if (res.status !== 200 || !j?.access_token) {
    throw new QuotaError('auth_expired', 'codex-direct: refresh rejected');
  }
  const accountId = (j.id_token && accountIdOf(j.id_token)) || fields.accountId;
  return {
    accessToken: j.access_token,
    refreshToken: j.refresh_token ?? fields.refreshToken,
    expiresAt: Date.now() + (Number(j.expires_in) > 0 ? Number(j.expires_in) * 1000 : 3600_000),
    accountId,
  };
}

export function needsRefresh(fields, now = Date.now()) {
  return Boolean(fields?.refreshToken) && (!fields?.expiresAt || fields.expiresAt - now < PREEMPT_MS);
}
