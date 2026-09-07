import { test } from 'node:test';
import assert from 'node:assert/strict';
import adapter, { parseResetAt, parseUsageSummary } from '../../src/standalone/providers/command-code.js';
import { QuotaError } from '../../src/standalone/providers/http.js';

const CREDITS = {
  plan_name: 'pro',
  monthlyCredits: '100',
  purchasedCredits: '80',
  freeCredits: '20',
  used: '25',
  reset_at: 1757808000,
};

const EXTRAS = [
  {
    id: 'usage-summary',
    status: 200,
    bodyText: JSON.stringify({ usage: { session: { used: 2, total: 10 }, weekly: { percentage: '40' } } }),
  },
  {
    id: 'subscriptions',
    status: 200,
    bodyText: JSON.stringify({ plan: { name: 'Pro subscription' }, monthly: { resetAt: '2026-10-01T00:00:00Z' } }),
  },
  { id: 'whoami', status: 200, bodyText: JSON.stringify({ planName: 'Whoami plan' }) },
];

test('command-code: 主 credits 独立解析月度 used/total/unit USD，附加请求补充窗口和套餐', () => {
  const result = adapter.parseResponse(200, JSON.stringify(CREDITS), EXTRAS);
  assert.equal(result.plan, 'Pro');
  assert.deepEqual(result.windows.map((w) => [w.name, w.usedPercent]), [
    ['5小时', 20],
    ['每周', 40],
    ['每月', 25],
  ]);
  const monthly = result.windows.find((w) => w.name === '每月');
  assert.equal(monthly.used, 25);
  assert.equal(monthly.total, 100);
  assert.equal(monthly.unit, 'USD');
  assert.equal(monthly.resetAt, 1757808000 * 1000);
  assert.equal(parseResetAt('2026-10-01T00:00:00Z'), Date.parse('2026-10-01T00:00:00Z'));
});

test('command-code: monthlyCredits 仅有总量不伪造百分比；remaining + total 可算 used', () => {
  const totalOnly = adapter.parseResponse(200, JSON.stringify({ monthlyCredits: 250 }), []);
  assert.deepEqual(totalOnly.windows, [{ name: '每月', usedPercent: null, used: null, total: 250, unit: 'USD', resetAt: null }]);
  const remaining = adapter.parseResponse(200, JSON.stringify({ monthlyCredits: 100, remaining: '75' }), []);
  assert.equal(remaining.windows[0].used, 25);
  assert.equal(remaining.windows[0].usedPercent, 25);
  assert.equal(remaining.windows[0].total, 100);
});

test('command-code: 嵌套 usage 用量不能伪造成月度 credits，非正 reset 无效', () => {
  for (const payload of [
    { usage: { used: 25, total: 100 } },
    { usage: { rolling: { used: 25, total: 100 }, weekly: { percent: 30 } } },
  ]) {
    assert.throws(() => adapter.parseResponse(200, JSON.stringify(payload), []), (e) => e instanceof QuotaError && e.kind === 'upstream_changed');
  }
  assert.equal(parseResetAt(-1), null);
  assert.equal(parseResetAt('1970-01-01T00:00:00Z'), null);
});

test('command-code: 主 credits 成功不因 optional extras 失败而丢失', () => {
  const result = adapter.parseResponse(200, JSON.stringify({ purchasedCredits: 50, freeCredits: 50, used: 10 }), [
    { id: 'usage-summary', status: 500, bodyText: '{}' },
    { id: 'subscriptions', status: null, bodyText: null },
    { id: 'whoami', status: 200, bodyText: 'not-json' },
  ]);
  assert.equal(result.windows[0].name, '每月');
  assert.equal(result.windows[0].usedPercent, 10);
  assert.equal(result.plan, null);
});

test('command-code: subscription/whoami 可补充月度重置时间和套餐', () => {
  const result = adapter.parseResponse(200, JSON.stringify({ monthlyCredits: 100, used: 20 }), [
    { id: 'subscriptions', status: 200, bodyText: JSON.stringify({ resetAt: '2026-10-01T00:00:00Z' }) },
    { id: 'whoami', status: 200, bodyText: JSON.stringify({ planName: 'team' }) },
  ]);
  assert.equal(result.plan, 'team');
  assert.equal(result.windows[0].resetAt, Date.parse('2026-10-01T00:00:00Z'));
});

test('command-code: 解析 usage summary 窗口别名', () => {
  const windows = parseUsageSummary({ rolling: { used: 1, total: 4 }, '7d': { pct: '30' } });
  assert.deepEqual(windows.map((w) => [w.name, w.usedPercent]), [['5小时', 25], ['每周', 30]]);
});

test('command-code: 解析 credits 顶层 windowLimits 的 5小时/每周 实时窗口，并把 individual-goat 映射为 GOAT', () => {
  // 真实的 credits 响应结构：credits.monthlyCredits 是“当月剩余”，windowLimits 含 5小时/每周 的 used+cap+resetAt
  const live = {
    credits: { monthlyCredits: 64.7086837626, purchasedCredits: 0, freeCredits: 0 },
    windowLimits: {
      limited: true,
      exceeded: null,
      fiveHour: { used: 5.29, cap: 14, exceeded: false, resetAt: 1788609928056 },
      weekly: { used: 5.29, cap: 35, exceeded: false, resetAt: 1789196728056 },
    },
  };
  const result = adapter.parseResponse(200, JSON.stringify(live), [
    { id: 'subscriptions', status: 200, bodyText: JSON.stringify({ data: { planId: 'individual-goat' } }) },
  ]);
  assert.equal(result.plan, 'GOAT');
  const five = result.windows.find((w) => w.name === '5小时');
  assert.ok(Math.abs(five.usedPercent - (100 * 5.29 / 14)) < 0.01);
  assert.equal(five.total, 14);
  assert.equal(five.resetAt, 1788609928056);
  assert.equal(five.unit, 'USD');

  // individual-goat / individual-pro 这样带前缀的套餐 id 应被映射成短名
  const sub = adapter.parseResponse(200, JSON.stringify({ monthlyCredits: 50, used: 0 }), [
    { id: 'whoami', status: 200, bodyText: JSON.stringify({ planId: 'individual-goat' }) },
  ]);
  assert.equal(sub.plan, 'GOAT');

  const unknownPlan = adapter.parseResponse(200, JSON.stringify({ plan: 'weird-99', monthlyCredits: 10, used: 5 }), []);
  assert.equal(unknownPlan.plan, 'weird-99');
});

test('command-code: GOAT 套餐硬编码官方限额并重算百分比（无总额 → 用官方 $70）', () => {
  // 只有“当月剩余”67.6 没有总额：认 GOAT 后应填满每月/$70，剩余 → 已用 2.4
  const goOnly = adapter.parseResponse(
    200,
    JSON.stringify({ plan: 'GOAT', monthlyCredits: 67.6 }),
    [],
  );
  const monthly = goOnly.windows.find((w) => w.name === '每月');
  assert.equal(monthly.total, 70);
  assert.ok(monthly.used != null, '应依据 70-剩余 反推已用');
  assert.ok(Math.abs(monthly.usedPercent - (100 * (70 - 67.6) / 70)) < 1e-6);

  // 有已用 + 总额：GOAT 强制总限额，已用/总额重算
  const goUsed = adapter.parseResponse(
    200,
    JSON.stringify({ plan: 'goat', monthlyCredits: 100, used: 25 }),
    [],
  );
  const m2 = goUsed.windows.find((w) => w.name === '每月');
  assert.equal(m2.total, 70);
  assert.ok(Math.abs(m2.usedPercent - (25 / 70) * 100) < 0.01);
});

test('command-code: 错误状态、坏主结构与固定额外白名单', () => {
  assert.throws(() => adapter.parseResponse(401, '{}'), (e) => e instanceof QuotaError && e.kind === 'auth_expired');
  assert.throws(() => adapter.parseResponse(403, '{}'), (e) => e.kind === 'auth_expired');
  assert.throws(() => adapter.parseResponse(429, '{}'), (e) => e.kind === 'rate_limited');
  assert.throws(() => adapter.parseResponse(502, '{}'), (e) => e.kind === 'unavailable');
  assert.throws(() => adapter.parseResponse(200, 'oops'), (e) => e.kind === 'upstream_changed');
  assert.throws(() => adapter.parseResponse(200, JSON.stringify({ hello: 1 })), (e) => e.kind === 'upstream_changed');
  assert.deepEqual(adapter.allowed, [
    { method: 'GET', host: 'api.commandcode.ai', pathPrefix: '/alpha/billing/credits' },
    { method: 'GET', host: 'api.commandcode.ai', pathPrefix: '/alpha/usage/summary' },
    { method: 'GET', host: 'api.commandcode.ai', pathPrefix: '/alpha/billing/subscriptions' },
    { method: 'GET', host: 'api.commandcode.ai', pathPrefix: '/alpha/whoami' },
  ]);
  const req = adapter.buildRequest({ apiKey: 'command-key-fixture' });
  assert.equal(req.url, 'https://api.commandcode.ai/alpha/billing/credits');
  assert.equal(req.headers.authorization, 'Bearer command-key-fixture');
  assert.equal(req.headers['x-api-key'], 'command-key-fixture');
  assert.deepEqual(adapter.extraRequests({ apiKey: 'command-key-fixture' }).map((r) => r.id), ['usage-summary', 'subscriptions', 'whoami']);
  assert.equal(new Set(adapter.extraRequests({ apiKey: 'x' }).map((r) => r.id)).size, 3);
  assert.ok(adapter.allowed.every((a) => !a.pathPrefix.includes('/generate') && !a.pathPrefix.includes('/chat/completions') && !a.pathPrefix.includes('/messages')));
});
