// Kimi For Coding —— GET https://api.kimi.com/coding/v1/usages（Bearer 鉴权）
// 套餐名另取 GET /coding/v1/me 的 user_level_name（/usages 只有 LEVEL_* 内部枚举）
import { QuotaError } from './http.js';

const ENDPOINT = 'https://api.kimi.com/coding/v1/usages';
const ME_ENDPOINT = 'https://api.kimi.com/coding/v1/me';

// /me 不可用时的兜底：LEVEL_* 枚举 → 官方套餐名（音乐术语）
// 映射来源：onWatch docs/KIMI_SETUP.md（社区实测）；未知枚举降级为首字母大写的可读形式
const LEVEL_PLAN_NAMES = {
  LEVEL_FREE: 'Free',
  LEVEL_BASIC: 'Adagio',
  LEVEL_STANDARD: 'Moderato',
  LEVEL_INTERMEDIATE: 'Allegretto',
  LEVEL_ADVANCED: 'Allegro',
  LEVEL_PREMIUM: 'Vivace',
};

function humanizeLevel(level) {
  const body = level.replace(/^LEVEL_/, '');
  if (!body) return level;
  return body
    .split('_')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

function clampPct(n) {
  return Math.min(100, Math.max(0, n));
}

// resetTime 可能是 ISO 字符串、epoch 秒或 epoch 毫秒；无法识别则返回 null
function parseResetTime(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v;
  if (typeof v === 'string' && v.trim() !== '') {
    const t = Date.parse(v);
    if (!Number.isNaN(t)) return t;
    const n = Number(v);
    if (Number.isFinite(n)) return n < 1e12 ? n * 1000 : n;
  }
  return null;
}

function parseWindow(obj, name) {
  if (!obj || typeof obj !== 'object') {
    throw new QuotaError('upstream_changed', `kimi: ${name} window is not an object`);
  }
  // 实测 2026-09：limit/remaining/used 为数字字符串（如 "100"），需宽容转换
  const limit = Number(obj.limit);
  const remaining = Number(obj.remaining);
  if (!Number.isFinite(limit) || !(limit > 0) || !Number.isFinite(remaining) || remaining < 0) {
    throw new QuotaError('upstream_changed', `kimi: ${name} window limit/remaining invalid`);
  }
  return {
    name,
    usedPercent: clampPct(Math.round((1 - remaining / limit) * 100)),
    used: limit - remaining,
    total: limit,
    unit: null,
    resetAt: parseResetTime(obj.resetTime),
  };
}

export default {
  id: 'kimi',
  displayName: 'Kimi For Coding',
  kind: 'quota',
  credentialFields: [
    { key: 'apiKey', label: 'API Key', secret: true, required: true, placeholder: 'sk-...' },
  ],
  allowed: [
    { method: 'GET', host: 'api.kimi.com', pathPrefix: '/coding/v1/usages' },
    { method: 'GET', host: 'api.kimi.com', pathPrefix: '/coding/v1/me' },
  ],
  buildRequest(cred) {
    return {
      method: 'GET',
      url: ENDPOINT,
      headers: { authorization: `Bearer ${cred.apiKey}`, accept: 'application/json' },
    };
  },
  extraRequests(cred) {
    return [
      {
        id: 'me',
        method: 'GET',
        url: ME_ENDPOINT,
        headers: { authorization: `Bearer ${cred.apiKey}`, accept: 'application/json' },
      },
    ];
  },
  parseResponse(status, bodyText, extras) {
    if (status === 401 || status === 403) throw new QuotaError('auth_expired', `kimi http ${status}`);
    if (status === 429) throw new QuotaError('rate_limited', 'kimi http 429');
    if (status !== 200) throw new QuotaError('unavailable', `kimi http ${status}`);
    let data;
    try {
      data = JSON.parse(bodyText);
    } catch {
      throw new QuotaError('upstream_changed', 'kimi: body is not json');
    }
    if (!data || typeof data !== 'object' || !Array.isArray(data.limits)) {
      throw new QuotaError('upstream_changed', 'kimi: limits array missing');
    }
    const windows = [];
    for (const item of data.limits) {
      if (!item || typeof item !== 'object') continue;
      if (item.detail != null) windows.push(parseWindow(item.detail, '5小时'));
      if (item.usage != null) windows.push(parseWindow(item.usage, '每周'));
    }
    if (data.usage != null) windows.push(parseWindow(data.usage, '每周'));
    if (windows.length === 0) throw new QuotaError('upstream_changed', 'kimi: no recognizable windows');
    // 套餐名：优先 /me 的 user_level_name（订阅真实档位名，如 Allegretto）；
    // 取不到再兜底 /usages 的 LEVEL_* 枚举映射，未知枚举转可读形式
    const me = extras?.find((e) => e.id === 'me');
    let plan = null;
    if (me && me.status === 200 && me.bodyText) {
      try {
        const name = JSON.parse(me.bodyText)?.user_level_name;
        if (typeof name === 'string' && name.trim() !== '') plan = name.trim();
      } catch {
        // /me 非 JSON：忽略，走枚举兜底
      }
    }
    if (plan === null) {
      const level = data.user?.membership?.level;
      if (typeof level === 'string') plan = LEVEL_PLAN_NAMES[level] ?? humanizeLevel(level);
    }
    return { plan, windows, error: null };
  },
};
