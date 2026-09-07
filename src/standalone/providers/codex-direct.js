import { QuotaError } from './http.js';

const ENDPOINT = 'https://chatgpt.com/backend-api/wham/usage';
const USER_AGENT = 'codex_cli_rs/0.76.0 (Debian 13.0.0; x86_64) WindowsTerminal';

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

export default {
  id: 'codex-direct',
  displayName: 'Codex（直连）',
  kind: 'quota',
  credentialFields: [
    { key: 'accessToken', label: 'Access Token', secret: true, required: true, placeholder: 'ChatGPT access token' },
    { key: 'accountId', label: 'Account ID', secret: false, required: true, placeholder: 'ChatGPT account ID' },
  ],
  allowed: [{ method: 'GET', host: 'chatgpt.com', pathPrefix: '/backend-api/wham/usage' }],
  buildRequest(cred) {
    return {
      method: 'GET',
      url: ENDPOINT,
      headers: {
        authorization: `Bearer ${cred.accessToken}`,
        'ChatGPT-Account-Id': String(cred.accountId ?? ''),
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
