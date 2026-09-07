// OpenCode（自动识别 Go / Zen）—— GET https://opencode.ai/zen/go/v1/usage（必须 Bearer）
// 端点未文档化且改过形态：新形态 {"usage":{rolling|weekly|monthly:{status,percent,resetsAt}}}
// 旧形态扁平 {rollingUsage|weeklyUsage|monthlyUsage:{usagePercent,resetInSec}}，两种都解析
import { QuotaError } from './http.js';

const ENDPOINT = 'https://opencode.ai/zen/go/v1/usage';
const ZEN_UNAVAILABLE_MESSAGE = '已识别为 OpenCode Zen；当前没有公开的 API Key 余额查询接口';
const PLAN_KEYS = ['planName', 'plan_name', 'plan', 'plan_type', 'planType', 'subscriptionPlan', 'subscription_plan'];

function clampPct(n) {
  return Math.min(100, Math.max(0, n));
}

function parseIso(v) {
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

const NEW_WINDOWS = [
  ['rolling', '5小时'],
  ['weekly', '每周'],
  ['monthly', '每月'],
];

function parseNewShape(usage) {
  const windows = [];
  for (const [key, name] of NEW_WINDOWS) {
    const w = usage[key];
    if (w == null) continue;
    if (typeof w !== 'object' || typeof w.percent !== 'number' || !Number.isFinite(w.percent)) {
      throw new QuotaError('upstream_changed', `opencode-go: usage.${key} percent invalid`);
    }
    windows.push({
      name,
      usedPercent: clampPct(Math.round(w.percent)),
      used: null,
      total: null,
      unit: null,
      resetAt: parseIso(w.resetsAt),
    });
  }
  return windows;
}

const OLD_WINDOWS = [
  ['rollingUsage', '5小时'],
  ['weeklyUsage', '每周'],
  ['monthlyUsage', '每月'],
];

function parseOldShape(json, now) {
  const windows = [];
  for (const [key, name] of OLD_WINDOWS) {
    const w = json[key];
    if (w == null) continue;
    if (typeof w !== 'object' || typeof w.usagePercent !== 'number' || !Number.isFinite(w.usagePercent)) {
      throw new QuotaError('upstream_changed', `opencode-go: ${key} usagePercent invalid`);
    }
    windows.push({
      name,
      usedPercent: clampPct(Math.round(w.usagePercent)),
      used: null,
      total: null,
      unit: null,
      resetAt:
        typeof w.resetInSec === 'number' && Number.isFinite(w.resetInSec)
          ? now + w.resetInSec * 1000
          : null,
    });
  }
  return windows;
}

function objectSources(value) {
  const sources = [];
  function visit(node) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    sources.push(node);
    for (const child of Object.values(node)) visit(child);
  }
  visit(value);
  return sources;
}

function readablePlan(value) {
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  for (const key of ['name', 'label', 'type']) {
    if (typeof value[key] === 'string' && value[key].trim() !== '') return value[key].trim();
  }
  return null;
}

function parsePlan(json) {
  const sources = objectSources(json);
  for (const key of PLAN_KEYS) {
    for (const source of sources) {
      const plan = readablePlan(source[key]);
      if (plan) return plan;
    }
  }
  return null;
}

export function isZenEntitlement(status, bodyText) {
  if (status !== 403 || typeof bodyText !== 'string') return false;
  const text = bodyText.toLowerCase().replace(/[_-]+/g, ' ');
  if (/\bentitlement(?:[\s_-]*error)?\b/.test(text)) return true;
  return (
    /\b(?:no|without|missing)\s+(?:an?\s+)?go\s+subscription\b/.test(text) ||
    /\bgo\s+subscription\s+(?:(?:is|was|not)\s+)?(?:missing|required|absent|unavailable|disabled)\b/.test(text) ||
    /\bgo\s+subscription\s+not\s+(?:found|active|available)\b/.test(text)
  );
}

export default {
  id: 'opencode-go',
  displayName: 'OpenCode（自动识别 Go / Zen）',
  kind: 'quota',
  credentialFields: [
    { key: 'apiKey', label: 'API Key', secret: true, required: true, placeholder: 'API Key' },
  ],
  allowed: [{ method: 'GET', host: 'opencode.ai', pathPrefix: '/zen/go/v1/usage' }],
  buildRequest(cred) {
    return {
      method: 'GET',
      url: ENDPOINT,
      headers: { authorization: `Bearer ${cred.apiKey}`, accept: 'application/json' },
    };
  },
  parseResponse(status, bodyText) {
    if (status === 403 && isZenEntitlement(status, bodyText)) {
      return {
        plan: 'Zen',
        windows: [],
        balance: null,
        error: { kind: 'unavailable', message: ZEN_UNAVAILABLE_MESSAGE },
      };
    }
    if (status === 401 || status === 403) throw new QuotaError('auth_expired', `opencode-go http ${status}`);
    if (status === 429) throw new QuotaError('rate_limited', 'opencode-go http 429');
    if (status !== 200) throw new QuotaError('unavailable', `opencode-go http ${status}`);
    let json;
    try {
      json = JSON.parse(bodyText);
    } catch {
      throw new QuotaError('upstream_changed', 'opencode-go: body is not json');
    }
    if (!json || typeof json !== 'object' || Array.isArray(json)) {
      throw new QuotaError('upstream_changed', 'opencode-go: body is not an object');
    }
    let windows = [];
    if (json.usage && typeof json.usage === 'object' && !Array.isArray(json.usage)) windows = parseNewShape(json.usage);
    if (windows.length === 0) windows = parseOldShape(json, Date.now());
    if (windows.length === 0) {
      throw new QuotaError('upstream_changed', 'opencode-go: no recognizable usage shape');
    }
    return { plan: parsePlan(json) ?? 'Go', windows, error: null };
  },
};
