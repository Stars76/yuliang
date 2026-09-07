import { QuotaError } from './http.js';

const MAIN_ENDPOINT = 'https://api.commandcode.ai/alpha/billing/credits';
const EXTRA_ENDPOINTS = [
  ['usage-summary', 'https://api.commandcode.ai/alpha/usage/summary'],
  ['subscriptions', 'https://api.commandcode.ai/alpha/billing/subscriptions'],
  ['whoami', 'https://api.commandcode.ai/alpha/whoami'],
];
const WINDOW_PATHS = {
  '5小时': ['rolling', 'rolling_usage', 'session', 'session_usage', '5h', 'five_hour', 'fiveHour', 'usage.rolling', 'usage.session'],
  每周: ['weekly', 'weekly_usage', '7d', 'seven_day', 'sevenDay', 'usage.weekly', 'usage.7d'],
  每月: ['monthly', 'monthly_usage', 'included', 'included_usage', 'usage.monthly', 'usage.included'],
};
// credits 接口把滚动窗口（5小时/每周）放在顶层 windowLimits 里，与 credits 平级：
// { windowLimits: { fiveHour: { used, cap, resetAt }, weekly: { used, cap, resetAt } } }
// credits 只给“当月剩余”（monthlyCredits），窗口的 realtime 用量在这里，必须先于月度余额读取。
const WINDOW_LIMIT_KEYS = { '5小时': ['fiveHour', 'five_hour', 'fivehour', 'rolling', 'session'], 每周: ['weekly', 'weeklyUsage', 'weekly_usage', '7d', 'seven_day'] };
const PLAN_LABELS = {
  'individual-goat': 'GOAT',
  'individual-pro': 'Pro',
  'individual-go': 'Go',
  'individual-max-10x': 'Max 10×',
  'individual-max-20x': 'Max 20×',
  'team-pro': 'Team Pro',
  goat: 'GOAT',
  pro: 'Pro',
  go: 'Go',
};

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

function collectObjects(value, out = [], depth = 0) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 5) return out;
  out.push(value);
  for (const child of Object.values(value)) collectObjects(child, out, depth + 1);
  return out;
}

function fieldEntry(objects, keys) {
  for (const object of objects) {
    for (const key of keys) {
      if (object[key] !== undefined && object[key] !== null) return { value: object[key], object };
    }
  }
  return null;
}

function fieldNumber(objects, keys) {
  for (const object of objects) {
    for (const key of keys) {
      const n = numberValue(object[key]);
      if (n != null) return n;
    }
  }
  return null;
}

function fieldString(objects, keys) {
  for (const object of objects) {
    for (const key of keys) {
      const value = object[key];
      if (typeof value === 'string' && value.trim() !== '') return value.trim();
      if (value && typeof value === 'object') {
        for (const nested of ['type', 'name', 'label']) {
          if (typeof value[nested] === 'string' && value[nested].trim() !== '') return value[nested].trim();
        }
      }
    }
  }
  return null;
}

function parseWindowValue(source, name, objects = collectObjects(source)) {
  if (source == null) return null;
  if (typeof source === 'number' || typeof source === 'string') {
    const percent = numberValue(source);
    if (percent == null) throw new QuotaError('upstream_changed', `command-code: ${name} percent invalid`);
    return { name, usedPercent: clampPercent(percent), used: null, total: null, unit: null, resetAt: null };
  }
  if (typeof source !== 'object' || Array.isArray(source)) {
    throw new QuotaError('upstream_changed', `command-code: ${name} window invalid`);
  }
  const sourceObjects = objects.length ? objects : collectObjects(source);
  const used = fieldNumber(sourceObjects, ['used', 'usage', 'usedCredits', 'used_credits', 'consumed', 'monthlyUsed', 'monthly_used']);
  const total = fieldNumber(sourceObjects, ['total', 'limit', 'quota', 'allowance', 'included', 'monthlyCredits', 'monthly_credits', 'credits', 'cap']);
  const remaining = fieldNumber(sourceObjects, ['remaining', 'remainingCredits', 'remaining_credits', 'left', 'available']);
  let resolvedTotal = total;
  let resolvedUsed = used;
  if (resolvedTotal == null && resolvedUsed != null && remaining != null) resolvedTotal = resolvedUsed + remaining;
  if (resolvedUsed == null && resolvedTotal != null && remaining != null) resolvedUsed = resolvedTotal - remaining;
  if (resolvedTotal != null && resolvedTotal <= 0) throw new QuotaError('upstream_changed', `command-code: ${name} total invalid`);
  if (resolvedUsed != null && resolvedUsed < 0) throw new QuotaError('upstream_changed', `command-code: ${name} used invalid`);
  const explicitPercent = fieldNumber(sourceObjects, ['percent', 'percentage', 'used_percent', 'usedPercent', 'pct']);
  if (explicitPercent == null && resolvedUsed == null && resolvedTotal == null) return null;
  const usedPercent = explicitPercent != null
    ? clampPercent(explicitPercent)
    : resolvedTotal > 0 && resolvedUsed != null
      ? clampPercent((resolvedUsed / resolvedTotal) * 100)
      : null;
  const reset = fieldEntry(sourceObjects, ['reset_at', 'resets_at', 'resetAt', 'resetsAt', 'reset']);
  const unit = fieldString(sourceObjects, ['unit', 'currency']) ?? 'USD';
  const round2 = (n) => (n == null ? null : Math.round(n * 100) / 100);
  return { name, usedPercent, used: round2(resolvedUsed), total: round2(resolvedTotal), unit, resetAt: parseResetAt(reset?.value) };
}

function findWindow(json, keys, name) {
  const objects = collectObjects(json);
  for (const key of keys) {
    const entry = fieldEntry(objects, [key]);
    if (entry) return parseWindowValue(entry.value, name);
  }
  return null;
}

// credits 响应顶层 windowLimits：{ fiveHour:{used,cap,resetAt}, weekly:{used,cap,resetAt} }
// 这个结构给出了 5小时/每周 的实时用量 + 上限 + 重置时间（CLI /usage 同源数据），
// 而 credits.monthlyCredits 只给“当月剩余”。必须解析它，否则面板永远只有每月。
function parseWindowLimits(json) {
  const limits = json?.windowLimits;
  if (!limits || typeof limits !== 'object' || Array.isArray(limits)) return [];
  const out = [];
  for (const [name, keys] of Object.entries(WINDOW_LIMIT_KEYS)) {
    const window = findWindow(limits, keys, name);
    if (window) out.push(window);
  }
  return out;
}

const CREDIT_SIGNAL_KEYS = [
  'monthlyCredits', 'monthly_credits', 'purchasedCredits', 'purchased_credits', 'freeCredits', 'free_credits',
  'remainingCredits', 'remaining_credits', 'monthlyUsed', 'monthly_used',
];
const CREDIT_USED_KEYS = ['used', 'usage', 'usedCredits', 'used_credits', 'consumed', 'monthlyUsed', 'monthly_used'];
const CREDIT_TOTAL_KEYS = ['total', 'limit', 'quota', 'allowance', 'included', 'credits'];
const CREDIT_REMAINING_KEYS = ['remaining', 'remainingCredits', 'remaining_credits', 'left', 'available'];
const CREDIT_PERCENT_KEYS = ['percent', 'percentage', 'used_percent', 'usedPercent', 'pct'];
const RESET_KEYS = ['reset_at', 'resets_at', 'resetAt', 'resetsAt', 'reset', 'currentPeriodEnd', 'current_period_end'];

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function hasCreditSignal(object) {
  return CREDIT_SIGNAL_KEYS.some((key) => hasOwn(object, key));
}

function findCreditsNode(json) {
  function visit(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    if (hasOwn(value, 'credits')) {
      return value.credits && typeof value.credits === 'object' && !Array.isArray(value.credits)
        ? { node: value.credits, metadata: value }
        : { node: value, metadata: null };
    }
    if (hasCreditSignal(value)) return { node: value, metadata: null };
    for (const child of Object.values(value)) {
      const result = visit(child);
      if (result) return result;
    }
    return null;
  }
  return visit(json);
}

function parseCreditsNode(node, metadata) {
  const monthlyEntry = fieldEntry([node], ['monthlyCredits', 'monthly_credits']);
  const monthlyNode = monthlyEntry?.value && typeof monthlyEntry.value === 'object' && !Array.isArray(monthlyEntry.value)
    ? monthlyEntry.value
    : null;
  const sources = monthlyNode ? [monthlyNode, node] : [node];
  const round2 = (n) => (n == null ? null : Math.round(n * 100) / 100);
  const monthlyTotal = monthlyEntry
    ? numberValue(monthlyEntry.value) ?? fieldNumber(monthlyNode ? [monthlyNode] : [], CREDIT_TOTAL_KEYS)
    : null;
  const purchased = fieldNumber([node], ['purchasedCredits', 'purchased_credits']);
  const free = fieldNumber([node], ['freeCredits', 'free_credits']);
  const total = monthlyTotal
    ?? fieldNumber([node], CREDIT_TOTAL_KEYS)
    ?? (purchased != null || free != null ? (purchased ?? 0) + (free ?? 0) : null);
  const used = fieldNumber(sources, CREDIT_USED_KEYS);
  const remaining = fieldNumber(sources, CREDIT_REMAINING_KEYS);
  let resolvedTotal = round2(total);
  let resolvedUsed = round2(used);
  if (resolvedTotal == null && resolvedUsed != null && remaining != null) resolvedTotal = round2(resolvedUsed + remaining);
  if (resolvedUsed == null && resolvedTotal != null && remaining != null) resolvedUsed = round2(resolvedTotal - remaining);
  if (resolvedTotal != null && resolvedTotal <= 0) throw new QuotaError('upstream_changed', 'command-code: monthly credits total invalid');
  if (resolvedUsed != null && resolvedUsed < 0) throw new QuotaError('upstream_changed', 'command-code: monthly credits used invalid');
  const explicitPercent = fieldNumber(sources, CREDIT_PERCENT_KEYS);
  if (explicitPercent == null && resolvedUsed == null && resolvedTotal == null) {
    throw new QuotaError('upstream_changed', 'command-code: monthly credits have no usable value');
  }
  const usedPercent = explicitPercent != null
    ? clampPercent(explicitPercent)
    : resolvedTotal > 0 && resolvedUsed != null
      ? clampPercent((resolvedUsed / resolvedTotal) * 100)
      : null;
  const metadataSources = metadata ? [metadata] : [];
  const reset = fieldEntry(sources, RESET_KEYS) ?? fieldEntry(metadataSources, RESET_KEYS);
  return {
    name: '每月',
    usedPercent,
    used: resolvedUsed,
    total: resolvedTotal,
    unit: fieldString(sources, ['unit', 'currency']) ?? fieldString(metadataSources, ['unit', 'currency']) ?? 'USD',
    resetAt: parseResetAt(reset?.value),
  };
}

function parseCredits(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    throw new QuotaError('upstream_changed', 'command-code: credits payload not an object');
  }
  const found = findCreditsNode(json);
  if (!found) throw new QuotaError('upstream_changed', 'command-code: credits fields missing');
  return parseCreditsNode(found.node, found.metadata);
}

const PLAN_KEYS = ['plan', 'plan_name', 'planName', 'plan_data', 'planData', 'subscription_plan', 'subscriptionPlan', 'planId', 'plan_id', 'billingPlan', 'billing_plan', 'plan_type', 'planType', 'tier', 'product', 'membership'];

function planString(value) {
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  if (value && typeof value === 'object') {
    for (const nested of ['type', 'name', 'label', 'id', 'slug', 'product']) {
      if (typeof value[nested] === 'string' && value[nested].trim() !== '') return value[nested].trim();
    }
  }
  return null;
}

function parsePlan(json) {
  if (!json || typeof json !== 'object') return null;
  const raw = fieldString(collectObjects(json), PLAN_KEYS) ?? planString(fieldEntry(collectObjects(json), PLAN_KEYS)?.value);
  if (raw == null) return null;
  const lc = raw.toLowerCase();
  return PLAN_LABELS[lc] ?? PLAN_LABELS[raw] ?? raw;
}

function parseExtraBody(extra) {
  if (!extra || extra.status !== 200 || !extra.bodyText) return null;
  try {
    return JSON.parse(extra.bodyText);
  } catch {
    return null;
  }
}

function mergeWindow(windows, window) {
  if (!window) return;
  const current = windows.find((item) => item.name === window.name);
  if (!current) {
    windows.push(window);
    return;
  }
  for (const key of ['usedPercent', 'used', 'total', 'unit', 'resetAt']) {
    if (current[key] == null && window[key] != null) current[key] = window[key];
  }
}

function fillReset(windows, name, resetAt) {
  if (resetAt == null) return;
  const window = windows.find((item) => item.name === name);
  if (window && window.resetAt == null) window.resetAt = resetAt;
}

export function parseUsageSummary(json) {
  const windows = [];
  for (const [name, keys] of Object.entries(WINDOW_PATHS)) mergeWindow(windows, findWindow(json, keys, name));
  return windows;
}

// GOAT 套餐（$10/月）的官方限额：5 小时 $14、每周 $35、每月 $70（见 commandcode.ai/docs/plans/goat）。
// 上游 credits 接口通常只还“当月剩余”或百分比，不给固定的 $70 总额，导致面板只能渲染成“限额数字”。
// 识别到 GOAT 时：把窗口总额硬编码为官方额度；若只有“剩余”没有“已用”，则按 剩余→已用=总额-剩余 反推，
// 让卡片成为从 0 随用量增长的限额进度（显式给出的 usedPercent 仍优先）。
const GOAT_LIMITS = { '5小时': 14, '每周': 35, '每月': 70 };

function applyPlanLimits(plan, windows) {
  if (!plan) return;
  const plc = String(plan).toLowerCase();
  // 只在明确的 GOAT 标识下硬编码，避免误伤其它套餐
  if (!/(^|_)goat($|_)|^goat\b|\bgoat\b/.test(plc)) return;
  for (const w of windows) {
    const hard = GOAT_LIMITS[w.name];
    if (hard == null) continue;
    const origTotal = w.total;
    w.total = hard;
    if (w.used != null && w.used > 0) {
      w.usedPercent = clampPercent((w.used / hard) * 100);
    } else if (w.used == null && origTotal > 0 && origTotal < hard) {
      const used = Math.max(0, hard - origTotal);
      w.used = used;
      w.usedPercent = clampPercent((used / hard) * 100);
    } else if (w.used == null && origTotal > 0 && origTotal > hard) {
      // 余额大于官方限额：说明 origTotal 不是“剩余”，可能是较大数字，用剩余=限额 不成立，保持限额但不伪造
      // （此时用户很可能还没用，剩余≈限额，百分比 0）
      if (w.usedPercent == null) w.usedPercent = 0;
      w.used = 0;
    }
  }
}

export default {
  id: 'command-code',
  displayName: 'Command Code',
  kind: 'quota',
  credentialFields: [
    { key: 'apiKey', label: 'API Key', secret: true, required: true, placeholder: 'Command Code API key' },
  ],
  allowed: [
    { method: 'GET', host: 'api.commandcode.ai', pathPrefix: '/alpha/billing/credits' },
    { method: 'GET', host: 'api.commandcode.ai', pathPrefix: '/alpha/usage/summary' },
    { method: 'GET', host: 'api.commandcode.ai', pathPrefix: '/alpha/billing/subscriptions' },
    { method: 'GET', host: 'api.commandcode.ai', pathPrefix: '/alpha/whoami' },
  ],
  buildRequest(cred) {
    return {
      method: 'GET',
      url: MAIN_ENDPOINT,
      headers: { authorization: `Bearer ${cred.apiKey}`, 'x-api-key': cred.apiKey, accept: 'application/json' },
    };
  },
  extraRequests(cred) {
    return EXTRA_ENDPOINTS.map(([id, url]) => ({
      id,
      method: 'GET',
      url,
      headers: { authorization: `Bearer ${cred.apiKey}`, 'x-api-key': cred.apiKey, accept: 'application/json' },
    }));
  },
  parseResponse(status, bodyText, extras) {
    if (status === 401 || status === 403) throw new QuotaError('auth_expired', `command-code http ${status}`);
    if (status === 429) throw new QuotaError('rate_limited', 'command-code http 429');
    if (status !== 200) throw new QuotaError('unavailable', `command-code http ${status}`);
    let main;
    try {
      main = JSON.parse(bodyText);
    } catch {
      throw new QuotaError('upstream_changed', 'command-code: credits body is not json');
    }
    const monthly = parseCredits(main);
    const windows = [];
    mergeWindow(windows, monthly);
    for (const window of parseWindowLimits(main)) mergeWindow(windows, window);
    let plan = parsePlan(main);
    let monthlyReset = monthly.resetAt;
    for (const extra of extras ?? []) {
      const body = parseExtraBody(extra);
      if (!body) continue;
      try {
        if (extra.id === 'usage-summary') {
          for (const window of parseUsageSummary(body)) mergeWindow(windows, window);
        } else if (extra.id === 'subscriptions') {
          plan ||= parsePlan(body);
          const subscriptionReset = parseResetAt(fieldEntry(collectObjects(body), ['reset_at', 'resets_at', 'resetAt', 'resetsAt', 'reset', 'currentPeriodEnd', 'current_period_end', 'currentPeriodEnd'])?.value);
          let subscriptionWindow = null;
          try {
            subscriptionWindow = findWindow(body, WINDOW_PATHS['每月'], '每月');
          } catch {
            // A subscription response may provide only plan/reset metadata.
          }
          if (subscriptionWindow) {
            if (subscriptionWindow.resetAt == null) subscriptionWindow.resetAt = subscriptionReset ?? monthlyReset;
            mergeWindow(windows, subscriptionWindow);
          } else if (monthlyReset == null && subscriptionReset != null) {
            monthlyReset = subscriptionReset;
            fillReset(windows, '每月', monthlyReset);
          }
        } else if (extra.id === 'whoami') {
          plan ||= parsePlan(body);
          if (monthlyReset == null) {
            monthlyReset = parseResetAt(fieldEntry(collectObjects(body), ['reset_at', 'resets_at', 'resetAt', 'resetsAt', 'reset'])?.value);
            fillReset(windows, '每月', monthlyReset);
          }
        }
      } catch {
        // Optional endpoints are best effort; the primary credits result remains authoritative.
      }
    }
    windows.sort((a, b) => ['5小时', '每周', '每月'].indexOf(a.name) - ['5小时', '每周', '每月'].indexOf(b.name));
    applyPlanLimits(plan, windows);
    return { plan, windows, error: null };
  },
};
