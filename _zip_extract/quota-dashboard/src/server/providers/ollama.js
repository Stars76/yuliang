import { QuotaError } from './http.js';

const ENDPOINT = 'https://ollama.com/api/usage';
const SESSION_PATHS = [
  ['session_usage', '5小时'],
  ['session', '5小时'],
  ['rolling_usage', '5小时'],
  ['rolling', '5小时'],
  ['usage.session_usage', '5小时'],
  ['usage.session', '5小时'],
  ['usage.rolling', '5小时'],
  ['usage.rolling_usage', '5小时'],
];
const WEEKLY_PATHS = [
  ['weekly_usage', '每周'],
  ['weekly', '每周'],
  ['7d', '每周'],
  ['seven_day', '每周'],
  ['usage.weekly_usage', '每周'],
  ['usage.weekly', '每周'],
  ['usage.7d', '每周'],
  ['usage.seven_day', '每周'],
];
const MONTHLY_PATHS = [
  ['monthly_usage', '每月'],
  ['monthly', '每月'],
  ['included_usage', '每月'],
  ['included', '每月'],
  ['usage.monthly_usage', '每月'],
  ['usage.monthly', '每月'],
  ['usage.included_usage', '每月'],
  ['usage.included', '每月'],
];

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

function valueAt(json, path) {
  return path.split('.').reduce((value, key) => (value && typeof value === 'object' ? value[key] : undefined), json);
}

function firstNumber(object, keys) {
  if (!object || typeof object !== 'object' || Array.isArray(object)) return null;
  for (const key of keys) {
    const n = numberValue(object[key]);
    if (n != null) return n;
  }
  return null;
}

function firstValue(object, keys) {
  if (!object || typeof object !== 'object' || Array.isArray(object)) return undefined;
  for (const key of keys) if (object[key] !== undefined && object[key] !== null) return object[key];
  return undefined;
}

function parseWindow(source, name) {
  if (source == null) return null;
  if (typeof source === 'number' || typeof source === 'string') {
    const percent = numberValue(source);
    if (percent == null) throw new QuotaError('upstream_changed', `ollama: ${name} percent invalid`);
    return { name, usedPercent: clampPercent(percent), used: null, total: null, unit: null, resetAt: null };
  }
  if (typeof source !== 'object' || Array.isArray(source)) {
    throw new QuotaError('upstream_changed', `ollama: ${name} window invalid`);
  }
  const used = firstNumber(source, ['used', 'usage', 'used_amount', 'usedAmount', 'consumed', 'used_credits']);
  const total = firstNumber(source, ['total', 'limit', 'included', 'allowance', 'quota', 'total_amount', 'totalAmount']);
  const remaining = firstNumber(source, ['remaining', 'left', 'available']);
  let resolvedTotal = total;
  let resolvedUsed = used;
  if (resolvedTotal == null && resolvedUsed != null && remaining != null) resolvedTotal = resolvedUsed + remaining;
  if (resolvedUsed == null && resolvedTotal != null && remaining != null) resolvedUsed = resolvedTotal - remaining;
  if (resolvedTotal != null && resolvedTotal <= 0) throw new QuotaError('upstream_changed', `ollama: ${name} total invalid`);
  if (resolvedUsed != null && resolvedUsed < 0) throw new QuotaError('upstream_changed', `ollama: ${name} used invalid`);
  const explicitPercent = firstNumber(source, ['percent', 'percentage', 'used_percent', 'usedPercent', 'pct']);
  if (explicitPercent == null && resolvedUsed == null && resolvedTotal == null) {
    throw new QuotaError('upstream_changed', `ollama: ${name} usage fields missing`);
  }
  const usedPercent = explicitPercent != null
    ? clampPercent(explicitPercent)
    : resolvedUsed != null && resolvedTotal > 0
      ? clampPercent((resolvedUsed / resolvedTotal) * 100)
      : null;
  return {
    name,
    usedPercent,
    used: resolvedUsed,
    total: resolvedTotal,
    unit: firstValue(source, ['unit', 'currency']) == null ? null : String(firstValue(source, ['unit', 'currency'])),
    resetAt: parseResetAt(firstValue(source, ['reset_at', 'resets_at', 'resetAt', 'resetsAt', 'reset'])),
  };
}

function firstWindow(json, paths) {
  for (const [path, name] of paths) {
    const source = valueAt(json, path);
    if (source === undefined || source === null) continue;
    try {
      return parseWindow(source, name);
    } catch (error) {
      if (!(error instanceof QuotaError) || error.kind !== 'upstream_changed') throw error;
    }
  }
  return null;
}

function firstString(json, paths) {
  for (const path of paths) {
    const value = valueAt(json, path);
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
    if (value && typeof value === 'object') {
      for (const key of ['type', 'name', 'label']) {
        if (typeof value[key] === 'string' && value[key].trim() !== '') return value[key].trim();
      }
    }
  }
  return null;
}

export function parseUsage(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    throw new QuotaError('upstream_changed', 'ollama: usage payload not an object');
  }
  const windows = [];
  for (const paths of [SESSION_PATHS, WEEKLY_PATHS, MONTHLY_PATHS]) {
    const window = firstWindow(json, paths);
    if (window) windows.push(window);
  }
  if (windows.length === 0) throw new QuotaError('upstream_changed', 'ollama: no recognizable usage windows');
  return {
    plan: firstString(json, ['plan', 'plan_name', 'planName', 'plan_data']),
    windows,
    error: null,
  };
}

export default {
  id: 'ollama',
  displayName: 'Ollama Cloud',
  kind: 'quota',
  credentialFields: [
    { key: 'apiKey', label: 'API Key', secret: true, required: true, placeholder: 'Ollama Cloud API key' },
  ],
  allowed: [{ method: 'GET', host: 'ollama.com', pathPrefix: '/api/usage' }],
  buildRequest(cred) {
    return {
      method: 'GET',
      url: ENDPOINT,
      headers: { authorization: `Bearer ${cred.apiKey}`, accept: 'application/json' },
    };
  },
  parseResponse(status, bodyText) {
    if (status === 401 || status === 403) throw new QuotaError('auth_expired', `ollama http ${status}`);
    if (status === 429) throw new QuotaError('rate_limited', 'ollama http 429');
    if (status !== 200) throw new QuotaError('unavailable', `ollama http ${status}`);
    let json;
    try {
      json = JSON.parse(bodyText);
    } catch {
      throw new QuotaError('upstream_changed', 'ollama: body is not json');
    }
    return parseUsage(json);
  },
};
