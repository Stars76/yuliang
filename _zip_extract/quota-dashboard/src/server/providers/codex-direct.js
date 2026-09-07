// codex-direct：直连 ChatGPT（Codex）额度。凭证由 OAuth device-code 登录获取（accessToken + refreshToken + expiresAt + accountId），
// 面板只在登录/续期时调用 auth.openai.com，查额度只读 GET wham/usage（不产生模型用量）。
// 手动凭证（旧字段 accessToken + accountId，无 refreshToken）仍兼容：不刷新，直接查。
import { QuotaError } from './http.js';

const WHAM_URL = 'https://chatgpt.com/backend-api/wham/usage';
const USER_AGENT = 'codex_cli_rs/0.76.0 (Debian 13.0.0; x86_64) WindowsTerminal';

// ---- OAuth device-code 常量（Codex CLI 公共 client；端点已由 vicoop-codex-cli 源码确认）----
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const USERCODE_URL = 'https://auth.openai.com/api/accounts/deviceauth/usercode';
const DEVICE_TOKEN_URL = 'https://auth.openai.com/api/accounts/deviceauth/token';
const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const VERIFICATION_URL = 'https://auth.openai.com/codex/device';
const DEVICE_REDIRECT_URI = 'https://auth.openai.com/deviceauth/callback';
const ID_TOKEN_AUTH_CLAIM = 'https://api.openai.com/auth';
const SCOPE = 'openid profile email offline_access api.connectors.read api.connectors.invoke';
const DEVICE_AUTH_HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json',
  'user-agent': USER_AGENT,
  originator: 'codex_cli_rs',
};
const TIMEOUT_MS = 10_000;
/** Access token 剩余不足该值时提前续期。 */
const PREEMPT_MS = 5 * 60_000;

function numberValue(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function clampPercent(value) {
  return Math.min(100, Math.max(0, value));
}

export function parseResetAt(value) {
  const n = numberValue(value);
  if (n != null) return n <= 0 ? null : n < 1e12 ? n * 1000 : n;
  if (typeof value === 'string' && value.trim() !== '') {
    const t = Date.parse(value.replace(/(\.\d{3})\d+/, '$1'));
    return Number.isNaN(t) || t <= 0 ? null : t;
  }
  return null;
}

function windowName(window, fallback) {
  const seconds = numberValue(window.limit_window_seconds ?? window.window_seconds ?? window.windowSeconds);
  if (seconds === 18_000) return '5小时';
  if (seconds === 604_800) return '每周';
  return fallback;
}

export function parseWhamUsage(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    throw new QuotaError('upstream_changed', 'codex-direct: usage payload not an object');
  }
  const rateLimit = json.rate_limit;
  if (!rateLimit || typeof rateLimit !== 'object') {
    throw new QuotaError('upstream_changed', 'codex-direct: rate_limit missing');
  }
  const windows = [];
  for (const [key, fallback] of [['primary_window', '5小时'], ['secondary_window', '每周']]) {
    const source = rateLimit[key];
    if (source == null) continue;
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
      throw new QuotaError('upstream_changed', `codex-direct: ${key} invalid`);
    }
    const percent = numberValue(source.used_percent ?? source.usedPercent ?? source.percent ?? source.percentage);
    if (percent == null) throw new QuotaError('upstream_changed', `codex-direct: ${key} percent invalid`);
    windows.push({
      name: windowName(source, fallback),
      usedPercent: clampPercent(percent),
      used: null,
      total: null,
      unit: null,
      resetAt: parseResetAt(source.reset_at ?? source.resets_at ?? source.resetAt ?? source.resetsAt ?? source.reset),
    });
  }
  if (windows.length === 0) {
    throw new QuotaError('upstream_changed', 'codex-direct: rate_limit windows missing');
  }
  return { plan: typeof json.plan_type === 'string' ? json.plan_type : null, windows, error: null };
}

// ---- OAuth 辅助（纯函数，便于测试）----

/** 解码 JWT payload（不验签，仅读取 id_token 中的 account 声明）。 */
export function decodeJwtPayload(token) {
  const parts = String(token ?? '').split('.');
  if (parts.length < 2) return undefined;
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined;
}

/** 从 id_token 的 `https://api.openai.com/auth`.chatgpt_account_id 取 account id。 */
export function accountIdOf(idToken) {
  const payload = idToken === undefined ? undefined : decodeJwtPayload(idToken);
  const auth = payload?.[ID_TOKEN_AUTH_CLAIM];
  const accountId = auth && typeof auth === 'object' ? auth.chatgpt_account_id : undefined;
  if (typeof accountId !== 'string' || accountId.length === 0) {
    throw new QuotaError('upstream_changed', 'codex-direct: 登录未返回 chatgpt account id');
  }
  return accountId;
}

function str(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function parseJson(text) {
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** auth.openai.com 在 Cloudflare 后面，非浏览器 POST 可能被 bot challenge（403 + cf-mitigated 或 HTML）。 */
function isCloudflareChallenge(status, headers, text) {
  if (headers.get?.('cf-mitigated')) return true;
  const contentType = headers.get?.('content-type') ?? '';
  if (contentType.includes('text/html')) return true;
  const head = String(text).slice(0, 64).toLowerCase();
  return head.includes('<!doctype html') || head.includes('<html');
}

async function postJson(url, body) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: DEVICE_AUTH_HEADERS,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new QuotaError('unavailable', 'codex-direct: 设备码请求网络错误');
  }
  return { status: res.status, headers: res.headers, text: await res.text() };
}

function checkOAuth(res, label) {
  if (res.status === 401 || res.status === 403) throw new QuotaError('auth_expired', `codex-direct: ${label} http ${res.status}`);
  if (res.status === 429) throw new QuotaError('rate_limited', `codex-direct: ${label} http 429`);
  if (res.status !== 200) throw new QuotaError('unavailable', `codex-direct: ${label} http ${res.status}`);
}

/** 步骤 1：向 OpenAI 设备码端点申请一次性 user code。 */
export async function requestDeviceCode() {
  const res = await postJson(USERCODE_URL, { client_id: CLIENT_ID });
  if (res.status === 404) {
    throw new QuotaError('upstream_changed', 'codex-direct: 该账号不支持设备码登录');
  }
  if (isCloudflareChallenge(res.status, res.headers, res.text)) {
    throw new QuotaError('unavailable', 'codex-direct: 设备码请求被 Cloudflare 拦截，请稍后再试');
  }
  const json = parseJson(res.text);
  if (json?.error === 'unauthorized_client' || json?.error === 'invalid_client') {
    throw new QuotaError('upstream_changed', 'codex-direct: 该账号不支持设备码登录');
  }
  if (res.status < 200 || res.status >= 300 || !json) {
    throw new QuotaError('unavailable', `codex-direct: 设备码请求失败 http ${res.status}`);
  }
  const deviceAuthId = str(json.device_auth_id ?? json.deviceAuthId);
  const userCode = str(json.user_code ?? json.usercode ?? json.userCode);
  if (!deviceAuthId || !userCode) {
    throw new QuotaError('upstream_changed', 'codex-direct: 设备码响应缺少 device_auth_id/user_code');
  }
  const intervalRaw = Number(json.interval);
  const intervalSeconds = Number.isFinite(intervalRaw) && intervalRaw > 0 ? intervalRaw : 5;
  return { deviceAuthId, userCode, intervalSeconds, verificationUrl: VERIFICATION_URL };
}

/** 步骤 2：轮询设备码 token 端点；返回 null 表示仍在等待（403/404 = pending）。 */
export async function pollDeviceCode(device) {
  const res = await postJson(DEVICE_TOKEN_URL, {
    device_auth_id: device.deviceAuthId,
    user_code: device.userCode,
  });
  if (res.status >= 200 && res.status < 300) {
    const json = parseJson(res.text);
    const authorizationCode = str(json?.authorization_code ?? json?.authorizationCode);
    const codeVerifier = str(json?.code_verifier ?? json?.codeVerifier);
    if (!authorizationCode || !codeVerifier) {
      throw new QuotaError('upstream_changed', 'codex-direct: 设备码响应缺少 authorization_code/code_verifier');
    }
    return { authorizationCode, codeVerifier };
  }
  if (res.status === 403 || res.status === 404) return null;
  throw new QuotaError('unavailable', `codex-direct: 设备码轮询失败 http ${res.status}`);
}

function codexSessionFromTokens(tokens, fallback = null) {
  const accessToken = typeof tokens.access_token === 'string' ? tokens.access_token : '';
  if (accessToken.length === 0) throw new QuotaError('auth_expired', 'codex-direct: token 响应缺少 access_token');
  const refreshToken = tokens.refresh_token ?? fallback?.refreshToken;
  if (refreshToken === undefined) throw new QuotaError('auth_expired', 'codex-direct: token 响应缺少 refresh_token');
  let expiresAt = Date.now();
  if (Number.isFinite(tokens.expires_in) && tokens.expires_in > 0) {
    expiresAt = Date.now() + tokens.expires_in * 1000;
  } else {
    const exp = decodeJwtPayload(accessToken)?.exp;
    if (typeof exp === 'number' && exp > 0) expiresAt = exp * 1000;
  }
  let accountId = fallback?.accountId;
  if (tokens.id_token !== undefined) accountId = accountIdOf(tokens.id_token);
  return { accessToken, refreshToken, expiresAt, accountId: accountId ?? '', idToken: tokens.id_token ?? fallback?.idToken };
}

/** 步骤 3：用授权码 + PKCE verifier 换 token。 */
export async function exchangeDeviceCode(authorizationCode, codeVerifier) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: authorizationCode,
    redirect_uri: DEVICE_REDIRECT_URI,
    client_id: CLIENT_ID,
    code_verifier: codeVerifier,
  });
  let res;
  try {
    res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', 'user-agent': USER_AGENT },
      body: body.toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new QuotaError('unavailable', 'codex-direct: token 交换网络错误');
  }
  const text = await res.text();
  checkOAuth({ status: res.status }, 'token 交换');
  return codexSessionFromTokens(parseJson(text));
}

/** 续期：refresh_token 换新 access token（JSON grant）。 */
export async function refreshCodexSession(fields) {
  if (!fields.refreshToken) throw new QuotaError('auth_expired', 'codex-direct: 无 refresh token，请重新登录');
  let res;
  try {
    res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': USER_AGENT },
      body: JSON.stringify({ client_id: CLIENT_ID, grant_type: 'refresh_token', refresh_token: fields.refreshToken }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new QuotaError('unavailable', 'codex-direct: 续期网络错误');
  }
  const text = await res.text();
  checkOAuth({ status: res.status }, '续期');
  return codexSessionFromTokens(parseJson(text), fields);
}

function needsRefresh(fields) {
  const expiresAt = Number(fields.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) return false;
  return Date.now() >= expiresAt - PREEMPT_MS;
}

async function fetchWham(fields) {
  let res;
  try {
    res = await fetch(WHAM_URL, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${fields.accessToken}`,
        'ChatGPT-Account-Id': String(fields.accountId ?? ''),
        originator: 'codex_cli_rs',
        accept: 'application/json',
        'user-agent': USER_AGENT,
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new QuotaError('unavailable', 'codex-direct: wham 网络错误');
  }
  const text = await res.text();
  if (res.status === 401 || res.status === 403) throw new QuotaError('auth_expired', `codex-direct http ${res.status}`);
  if (res.status === 429) throw new QuotaError('rate_limited', 'codex-direct http 429');
  if (res.status !== 200) throw new QuotaError('unavailable', `codex-direct http ${res.status}`);
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new QuotaError('upstream_changed', 'codex-direct: body is not json');
  }
  return parseWhamUsage(json);
}

/** 取额度：临近过期先续期，再查 wham/usage。返回 partial + 刷新后的凭证字段（未刷新则 newFields=null）。 */
export async function fetchCodexDirect(fields) {
  if (!fields?.accessToken) throw new QuotaError('auth_expired', 'codex-direct: 未登录');
  let cur = { ...fields };
  let newFields = null;
  if (needsRefresh(cur)) {
    cur = await refreshCodexSession(cur);
    newFields = cur;
  }
  const usage = await fetchWham(cur);
  return { partial: { ...usage, source: 'live', error: null }, newFields };
}

export default {
  id: 'codex-direct',
  displayName: 'Codex（直连）',
  kind: 'quota',
  authMode: 'oauth',
  fetchCodexDirect,
  credentialFields: [],
  allowed: [{ method: 'GET', host: 'chatgpt.com', pathPrefix: '/backend-api/wham/usage' }],
  buildRequest(cred) {
    return {
      method: 'GET',
      url: WHAM_URL,
      headers: {
        authorization: `Bearer ${cred.accessToken}`,
        'ChatGPT-Account-Id': String(cred.accountId ?? ''),
        originator: 'codex_cli_rs',
        accept: 'application/json',
        'user-agent': USER_AGENT,
      },
    };
  },
  parseResponse(status, bodyText) {
    if (status === 401 || status === 403) throw new QuotaError('auth_expired', `codex-direct http ${status}`);
    if (status === 429) throw new QuotaError('rate_limited', 'codex-direct http 429');
    if (status !== 200) throw new QuotaError('unavailable', `codex-direct http ${status}`);
    let json;
    try {
      json = JSON.parse(bodyText);
    } catch {
      throw new QuotaError('upstream_changed', 'codex-direct: body is not json');
    }
    return parseWhamUsage(json);
  },
};
