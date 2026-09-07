// sub2api 自建实例 —— GET {instanceUrl}/v1/usage（Authorization: Bearer <apiKey>，只读，不产生用量）
// 响应契约见 backend/internal/handler/gateway_handler.go 的 Usage()：
//   mode=quota_limited：quota{limit,used,remaining,unit:USD} + rate_limits[]{window:5h|1d|7d, limit, used, remaining, reset_at?}
//   mode=unrestricted + 订阅分组：subscription.{daily,weekly,monthly}_{usage,limit}_usd + planName
//   mode=unrestricted + 钱包：balance（USD）
import { QuotaError } from './http.js';

function clampPct(n) {
  return Math.min(100, Math.max(0, n));
}

function parseTime(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v;
  if (typeof v === 'string') {
    const t = Date.parse(v.replace(/(\.\d{3})\d+/, '$1'));
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// 校验自建实例地址：仅 https（或环回 http），不允许 userinfo/fragment
export function parseInstanceUrl(raw) {
  let url;
  try {
    url = new URL(String(raw ?? '').trim());
  } catch {
    throw new QuotaError('upstream_changed', 'sub2api: instanceUrl 不是合法 URL');
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new QuotaError('upstream_changed', 'sub2api: instanceUrl 必须是 https（环回允许 http）');
  }
  if (url.username || url.password || url.hash) {
    throw new QuotaError('upstream_changed', 'sub2api: instanceUrl 不允许携带凭证或 fragment');
  }
  return url.origin;
}

const RATE_WINDOW_NAMES = { '5h': '5小时', '1d': '每日', '7d': '每周' };

export function parseUsage(json) {
  if (!json || typeof json !== 'object') {
    throw new QuotaError('upstream_changed', 'sub2api: usage payload not an object');
  }
  const windows = [];
  const push = (name, used, total, resetAt, unit = 'USD') => {
    if (used == null || total == null || !(total > 0)) return;
    windows.push({
      name,
      usedPercent: clampPct(Math.round((used / total) * 100)),
      used,
      total,
      unit,
      resetAt: parseTime(resetAt),
    });
  };

  if (json.mode === 'quota_limited') {
    if (json.quota && typeof json.quota === 'object') {
      push('总额度', num(json.quota.used), num(json.quota.limit), null);
    }
    if (Array.isArray(json.rate_limits)) {
      for (const rl of json.rate_limits) {
        if (!rl || typeof rl !== 'object') continue;
        push(RATE_WINDOW_NAMES[rl.window] ?? String(rl.window), num(rl.used), num(rl.limit), rl.reset_at);
      }
    }
  } else if (json.mode === 'unrestricted' && json.subscription && typeof json.subscription === 'object') {
    const s = json.subscription;
    push('每日', num(s.daily_usage_usd), num(s.daily_limit_usd), null);
    push('每周', num(s.weekly_usage_usd), num(s.weekly_limit_usd), null);
    push('每月', num(s.monthly_usage_usd), num(s.monthly_limit_usd), null);
  } else if (json.mode === 'unrestricted' && json.balance != null) {
    const b = num(json.balance);
    if (b == null) throw new QuotaError('upstream_changed', 'sub2api: balance invalid');
    return {
      plan: null,
      windows: [],
      balance: { currency: json.unit === 'USD' || json.unit == null ? 'USD' : String(json.unit), total: b, granted: 0, paid: b },
      error: null,
    };
  }

  if (windows.length === 0) {
    throw new QuotaError('upstream_changed', 'sub2api: no recognizable quota/rate/subscription fields');
  }
  const plan = typeof json.planName === 'string' ? json.planName : null;
  return { plan, windows, error: null };
}

export default {
  id: 'sub2api',
  displayName: 'sub2api 实例',
  kind: 'quota',
  credentialFields: [
    { key: 'instanceUrl', label: '实例地址', secret: false, required: true, placeholder: 'https://sub2api.example.com' },
    { key: 'apiKey', label: 'API Key', secret: true, required: true, placeholder: 'sk-...' },
  ],
  // host '*' = 自建实例：host 由凭证提供（强制 https/环回），方法与路径仍由代码固定
  allowed: [{ method: 'GET', host: '*', pathPrefix: '/v1/usage' }],
  buildRequest(cred) {
    return {
      method: 'GET',
      url: `${parseInstanceUrl(cred.instanceUrl)}/v1/usage`,
      headers: { authorization: `Bearer ${cred.apiKey}`, accept: 'application/json' },
    };
  },
  parseResponse(status, bodyText) {
    if (status === 401 || status === 403) throw new QuotaError('auth_expired', `sub2api http ${status}`);
    if (status === 429) throw new QuotaError('rate_limited', 'sub2api http 429');
    if (status !== 200) throw new QuotaError('unavailable', `sub2api http ${status}`);
    let json;
    try {
      json = JSON.parse(bodyText);
    } catch {
      throw new QuotaError('upstream_changed', 'sub2api: body is not json');
    }
    return parseUsage(json);
  },
};
