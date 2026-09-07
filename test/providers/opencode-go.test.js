// opencode-go adapter 单测（fixture 内联脱敏，不联网）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import adapter, { isZenEntitlement } from '../../src/standalone/providers/opencode-go.js';
import { QuotaError } from '../../src/standalone/providers/http.js';

const ZEN_MESSAGE = '已识别为 OpenCode Zen；当前没有公开的 API Key 余额查询接口';

test('opencode-go: 新形态 usage.{rolling,weekly,monthly} 和响应套餐', () => {
  const body = {
    plan_type: 'go',
    planName: 'Go Pro',
    usage: {
      rolling: { status: 'ok', percent: 12.6, resetsAt: '2026-09-03T15:00:00Z' },
      weekly: { status: 'ok', percent: 45, resetsAt: '2026-09-07T00:00:00Z' },
      monthly: { status: 'rate-limited', percent: 100, resetsAt: '2026-10-01T00:00:00Z' },
    },
  };
  const r = adapter.parseResponse(200, JSON.stringify(body));
  assert.equal(r.plan, 'Go Pro');
  assert.deepEqual(r.windows.map((w) => w.name), ['5小时', '每周', '每月']);
  assert.equal(r.windows[0].usedPercent, 13);
  assert.equal(r.windows[0].resetAt, Date.parse('2026-09-03T15:00:00Z'));
  assert.equal(r.windows[2].usedPercent, 100);
});

test('opencode-go: 无响应套餐时确认 Go 并兼容旧形态', () => {
  const before = Date.now();
  const body = {
    rollingUsage: { usagePercent: 5.4, resetInSec: 3600 },
    weeklyUsage: { usagePercent: 20, resetInSec: 86400 },
  };
  const r = adapter.parseResponse(200, JSON.stringify(body));
  assert.equal(r.plan, 'Go');
  assert.deepEqual(r.windows.map((w) => w.name), ['5小时', '每周']);
  assert.equal(r.windows[0].usedPercent, 5);
  assert.ok(Math.abs(r.windows[0].resetAt - (before + 3600_000)) < 5000);
  assert.ok(Math.abs(r.windows[1].resetAt - (before + 86400_000)) < 5000);
});

test('opencode-go: 明确 entitlement 403 → Zen 部分结果', () => {
  const body = { error: { name: 'EntitlementError', message: 'Go entitlement required' } };
  const r = adapter.parseResponse(403, JSON.stringify(body));
  assert.deepEqual(r, {
    plan: 'Zen',
    windows: [],
    balance: null,
    error: { kind: 'unavailable', message: ZEN_MESSAGE },
  });
});

test('opencode-go: 文本 no Go subscription → Zen 部分结果', () => {
  const r = adapter.parseResponse(403, 'No Go subscription is active for this key');
  assert.equal(r.plan, 'Zen');
  assert.deepEqual(r.windows, []);
  assert.equal(r.balance, null);
  assert.deepEqual(r.error, { kind: 'unavailable', message: ZEN_MESSAGE });
});

test('opencode-go: 仅明确权益缺失信号识别 Zen', () => {
  assert.equal(isZenEntitlement(403, 'entitlement missing'), true);
  assert.equal(isZenEntitlement(403, 'Go subscription required'), true);
  assert.equal(isZenEntitlement(403, 'forbidden'), false);
  assert.equal(isZenEntitlement(401, 'EntitlementError'), false);
});

test('opencode-go: 两种形态都不匹配 → upstream_changed', () => {
  assert.throws(
    () => adapter.parseResponse(200, JSON.stringify({ quota: { left: 3 } })),
    (e) => e instanceof QuotaError && e.kind === 'upstream_changed',
  );
  assert.throws(
    () => adapter.parseResponse(200, JSON.stringify({ usage: { rolling: { percent: 'high' } } })),
    (e) => e.kind === 'upstream_changed',
  );
  assert.throws(() => adapter.parseResponse(200, '[]'), (e) => e.kind === 'upstream_changed');
});

test('opencode-go: 普通 403/401、429 和其他状态映射', () => {
  assert.throws(() => adapter.parseResponse(403, '{"error":"forbidden"}'), (e) => e.kind === 'auth_expired');
  assert.throws(() => adapter.parseResponse(401, '{}'), (e) => e.kind === 'auth_expired');
  assert.throws(() => adapter.parseResponse(429, '{}'), (e) => e.kind === 'rate_limited');
  assert.throws(() => adapter.parseResponse(502, '{}'), (e) => e.kind === 'unavailable');
});

test('opencode-go: 必须 Bearer + 单一 GET usage 白名单，不探测模型', () => {
  assert.equal(adapter.id, 'opencode-go');
  assert.equal(adapter.displayName, 'OpenCode（自动识别 Go / Zen）');
  assert.deepEqual(adapter.allowed, [{ method: 'GET', host: 'opencode.ai', pathPrefix: '/zen/go/v1/usage' }]);
  assert.equal(adapter.extraRequests, undefined);
  const req = adapter.buildRequest({ apiKey: 'oc-key-12345678' });
  const url = new URL(req.url);
  assert.equal(req.method, 'GET');
  assert.equal(url.host, 'opencode.ai');
  assert.equal(url.pathname, '/zen/go/v1/usage');
  assert.equal(req.headers.authorization, 'Bearer oc-key-12345678');
  for (const path of ['/chat/completions', '/messages', '/responses']) {
    assert.ok(!adapter.allowed.some((entry) => entry.pathPrefix.includes(path)));
  }
});
