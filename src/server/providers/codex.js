// codex 特例（契约 §codex 特例）：凭证 = { managementKey }，alias 固定 "CLIProxyAPI"
// 走本机 CPA 管理口（白名单 http 特例），绝不调用 /v0/management/usage-queue
// 默认 http://127.0.0.1:8317；容器部署用 CPA_MGMT_URL 指向 docker 网关（compose 已配）
import { QuotaError } from './http.js';
import { env } from '../../standalone/env.js';

const MGMT = (env.cpaMgmtUrl || 'http://127.0.0.1:8317').replace(/\/+$/, '');
const MGMT_HOST = new URL(MGMT).host;
const TIMEOUT_MS = 10_000;
const CODEX_UA = 'codex_cli_rs/0.76.0 (Debian 13.0.0; x86_64) WindowsTerminal';
const WHAM_URL = 'https://chatgpt.com/backend-api/wham/usage';

// 校验 CPA 管理口地址：仅 https（或环回 http），不允许 userinfo/fragment；返回无尾斜杠 origin
export function parseMgmtUrl(raw) {
  let url;
  try {
    url = new URL(String(raw ?? '').trim());
  } catch {
    throw new QuotaError('upstream_changed', 'codex: 管理地址不是合法 URL');
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]', 'host.docker.internal'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new QuotaError('upstream_changed', 'codex: 管理地址必须是 https（本机环回允许 http）');
  }
  if (url.username || url.password || url.hash) {
    throw new QuotaError('upstream_changed', 'codex: 管理地址不允许携带凭证或 fragment');
  }
  return url.origin.replace(/\/+$/, '');
}

// 从凭证取 base URL：cred.baseUrl（单机/安卓手填）或 cred.mgmtUrl（网页版字段）优先，其次默认管理口
export function mgmtBase(cred) {
  return parseMgmtUrl((cred?.baseUrl ?? cred?.mgmtUrl) || MGMT);
}

function maskEmail(email) {
  const str = String(email ?? '');
  const at = str.indexOf('@');
  if (at < 1) return '***';
  const domain = str.slice(at + 1);
  const dot = domain.lastIndexOf('.');
  const tld = dot > 0 ? domain.slice(dot + 1) : '';
  return `${str[0]}***@${domain[0]}***${tld ? `.${tld}` : ''}`;
}

function clampPct(n) {
  return Math.min(100, Math.max(0, n));
}

async function mgmtFetch(cred, method, path, body) {
  let res;
  try {
    res = await fetch(`${mgmtBase(cred)}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${cred.managementKey}`,
        accept: 'application/json',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new QuotaError('unavailable', 'codex: management api network error');
  }
  return { status: res.status, text: await res.text() };
}

function checkHttp(status, label) {
  if (status === 401 || status === 403) throw new QuotaError('auth_expired', `codex: ${label} http ${status}`);
  if (status === 429) throw new QuotaError('rate_limited', `codex: ${label} http 429`);
  if (status !== 200) throw new QuotaError('unavailable', `codex: ${label} http ${status}`);
}

// auth-files 响应解析（纯函数，便于测试）
export function parseAuthFiles(json) {
  const list = Array.isArray(json) ? json : (json?.files ?? json?.items ?? json?.accounts);
  if (!Array.isArray(list)) throw new QuotaError('upstream_changed', 'codex: auth-files list missing');
  return list.map((item) => ({
    authIndex: item?.auth_index ?? item?.authIndex ?? item?.name ?? null,
    maskedEmail: maskEmail(item?.email),
    disabled: Boolean(item?.disabled),
    status: typeof item?.status === 'string' ? item.status : null,
  }));
}

// api-call 响应解包：兼容 CPA 包装 {status, body}（body 可为 JSON 字符串）与上游原文直出
export function parseApiCallResponse(httpStatus, bodyText) {
  checkHttp(httpStatus, 'api-call');
  let json;
  try {
    json = JSON.parse(bodyText);
  } catch {
    throw new QuotaError('upstream_changed', 'codex: api-call body is not json');
  }
  if (json && typeof json === 'object' && typeof json.status === 'number' && 'body' in json) {
    checkHttp(json.status, 'wham/usage');
    let inner = json.body;
    if (typeof inner === 'string') {
      try {
        inner = JSON.parse(inner);
      } catch {
        throw new QuotaError('upstream_changed', 'codex: wrapped body is not json');
      }
    }
    return inner;
  }
  return json;
}

// wham/usage 载荷 → { plan, windows }；limit_window_seconds 18000=5h / 604800=7d
export function parseWhamUsage(json) {
  if (!json || typeof json !== 'object') {
    throw new QuotaError('upstream_changed', 'codex: usage payload not an object');
  }
  const rl = json.rate_limit;
  const windows = [];
  if (rl && typeof rl === 'object') {
    if (rl.primary_window != null) windows.push(parseWhamWindow(rl.primary_window, '5小时', 18000));
    if (rl.secondary_window != null) windows.push(parseWhamWindow(rl.secondary_window, '每周', 604800));
  }
  if (windows.length === 0) {
    throw new QuotaError('upstream_changed', 'codex: rate_limit windows missing');
  }
  return { plan: typeof json.plan_type === 'string' ? json.plan_type : null, windows };
}

function parseWhamWindow(w, fallbackName, fallbackSeconds) {
  if (!w || typeof w !== 'object' || typeof w.used_percent !== 'number' || !Number.isFinite(w.used_percent)) {
    throw new QuotaError('upstream_changed', 'codex: window used_percent invalid');
  }
  const secs = typeof w.limit_window_seconds === 'number' ? w.limit_window_seconds : fallbackSeconds;
  const name = secs === 18000 ? '5小时' : secs === 604800 ? '每周' : fallbackName;
  return {
    name,
    usedPercent: clampPct(Math.round(w.used_percent)),
    used: null,
    total: null,
    unit: null,
    resetAt: typeof w.reset_at === 'number' ? w.reset_at * 1000 : null,
  };
}

// ISO 时间兼容纳秒（插件快照带 9 位小数，Date.parse 不一定吃得下，截到毫秒）
function parseTime(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v * 1000;
  if (typeof v === 'string') {
    const t = Date.parse(v.replace(/(\.\d{3})\d+/, '$1'));
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

function windowName(minutes, fallback) {
  if (minutes === 300) return '5小时';
  if (minutes === 10080) return '每周';
  return fallback;
}

// cpa-account-config-manager 缓存快照：entry.id === authIndex，快照在 entry.usage.codex
// （实测 2026-09：reset_at 为 ISO 字符串，窗口含 window_minutes 300/10080）
export function extractCacheSnapshot(json, authIndex) {
  const list = Array.isArray(json) ? json : (json?.accounts ?? json?.items ?? json?.data);
  if (!Array.isArray(list)) return null;
  const entry = list.find(
    (e) => e && typeof e === 'object' && String(e.id ?? e.auth_index ?? e.authIndex) === String(authIndex),
  );
  const snap = entry?.usage?.codex ?? entry?.codex;
  if (!snap || typeof snap !== 'object') return null;
  const windows = [];
  const push = (w, fallbackName) => {
    if (!w || typeof w !== 'object' || typeof w.used_percent !== 'number' || !Number.isFinite(w.used_percent)) {
      return;
    }
    windows.push({
      name: windowName(w.window_minutes, fallbackName),
      usedPercent: clampPct(Math.round(w.used_percent)),
      used: null,
      total: null,
      unit: null,
      resetAt: parseTime(w.reset_at),
    });
  };
  push(snap.five_hour, '5小时');
  push(snap.seven_day, '每周');
  if (windows.length === 0) return null;
  const plan =
    typeof snap.plan_type === 'string'
      ? snap.plan_type
      : typeof entry.plan_type === 'string'
        ? entry.plan_type
        : null;
  return { plan, windows };
}

// auth-files 的 quota.signals（X-Codex-* 响应头被动信号）：账号近期有真实流量时权威且新鲜
export function extractSignalsQuota(json, authIndex) {
  const list = Array.isArray(json) ? json : (json?.files ?? json?.items ?? json?.accounts);
  if (!Array.isArray(list)) return null;
  const entry = list.find(
    (e) => e && typeof e === 'object' && String(e.auth_index ?? e.id) === String(authIndex),
  );
  const signals = entry?.quota?.signals;
  if (!signals || typeof signals !== 'object' || Object.keys(signals).length === 0) return null;
  const num = (k) => {
    const n = Number(signals[k]);
    return Number.isFinite(n) ? n : null;
  };
  const windows = [];
  const push = (prefix, fallbackName) => {
    const minutes = num(`X-Codex-${prefix}-Window-Minutes`);
    const used = num(`X-Codex-${prefix}-Used-Percent`);
    if (used == null || !minutes) return;
    windows.push({
      name: windowName(minutes, fallbackName),
      usedPercent: clampPct(Math.round(used)),
      used: null,
      total: null,
      unit: null,
      resetAt: parseTime(num(`X-Codex-${prefix}-Reset-At`)),
    });
  };
  push('Primary', '5小时');
  push('Secondary', '每周');
  if (windows.length === 0) return null;
  const plan = typeof signals['X-Codex-Plan-Type'] === 'string' ? signals['X-Codex-Plan-Type'] : null;
  return { plan, windows };
}

export async function listAccounts(cred) {
  const { status, text } = await mgmtFetch(cred, 'GET', '/v0/management/auth-files');
  checkHttp(status, 'auth-files');
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new QuotaError('upstream_changed', 'codex: auth-files body is not json');
  }
  return parseAuthFiles(json);
}

export async function fetchCodexQuota(cred, authIndex) {
  // 链路 1：实时 api-call → wham/usage（2026-09 实测对全部账号 404，保留以便上游恢复后自动生效）
  try {
    const { status, text } = await mgmtFetch(cred, 'POST', '/v0/management/api-call', {
      auth_index: authIndex,
      method: 'GET',
      url: WHAM_URL,
      header: {
        authorization: 'Bearer $TOKEN$',
        'user-agent': CODEX_UA,
        // Chatgpt-Account-Id 暂不加：CPA 的 $ACCOUNT_ID$ 占位支持未确认，加上可能原样透传占位符
      },
    });
    const usage = parseWhamUsage(parseApiCallResponse(status, text));
    return { ...usage, source: 'live', error: null };
  } catch {
    // 实时失败 → 走缓存链路
  }
  // 链路 2：插件 /accounts 缓存快照（被动信号驱动，有流量的账号当天新鲜）
  try {
    const { status, text } = await mgmtFetch(
      cred,
      'GET',
      '/v0/management/plugins/cpa-account-config-manager/accounts',
    );
    checkHttp(status, 'cache-accounts');
    const snap = extractCacheSnapshot(JSON.parse(text), authIndex);
    if (snap) return { ...snap, source: 'cache', error: null };
  } catch {
    // 继续回退
  }
  // 链路 3：auth-files quota.signals（X-Codex-* 被动信号）
  try {
    const { status, text } = await mgmtFetch(cred, 'GET', '/v0/management/auth-files');
    checkHttp(status, 'auth-files');
    const sig = extractSignalsQuota(JSON.parse(text), authIndex);
    if (sig) return { ...sig, source: 'cache', error: null };
  } catch {
    // 全部失败
  }
  throw new QuotaError('unavailable', 'codex: live and cache both failed');
}

export default {
  id: 'codex',
  displayName: 'Codex (ChatGPT via CLIProxyAPI)',
  kind: 'quota',
  listAccounts,
  fetchCodexQuota,
  credentialFields: [
    { key: 'managementKey', label: 'Management Key', secret: true, required: true, placeholder: 'CPA management key' },
  ],
  // CPA 管理口为契约允许的 http 特例（127.0.0.1 或 docker 网关）。codex 实际取数走
  // listAccounts()/fetchCodexQuota()（内部 mgmtFetch 用 cred.baseUrl/mgmtUrl，并经 parseMgmtUrl 校验），
  // 不走 executeAdapter 白名单；此处 allowed 反映默认管理口，供安全测试与声明用。
  allowed: [
    { method: 'GET', host: MGMT_HOST, pathPrefix: '/v0/management/auth-files' },
    { method: 'POST', host: MGMT_HOST, pathPrefix: '/v0/management/api-call' },
    { method: 'GET', host: MGMT_HOST, pathPrefix: '/v0/management/plugins/cpa-account-config-manager/accounts' },
  ],
  buildRequest(cred) {
    // 仅为满足 adapter 形状与白名单声明；实际取数走 listAccounts()/fetchCodexQuota()
    return {
      method: 'GET',
      url: `${mgmtBase(cred)}/v0/management/auth-files`,
      headers: { authorization: `Bearer ${cred.managementKey}`, accept: 'application/json' },
    };
  },
  parseResponse() {
    throw new QuotaError('unavailable', 'codex: use listAccounts()/fetchCodexQuota()');
  },
};
