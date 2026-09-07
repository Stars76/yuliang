// sub2api adapter 单测（fixture 按 gateway_handler.go 的 Usage() 响应契约构造，不联网）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import sub2api, { parseUsage, parseInstanceUrl } from '../../src/server/providers/sub2api.js';

const QUOTA_LIMITED = {
  mode: 'quota_limited',
  isValid: true,
  status: 'active',
  quota: { limit: 50, used: 12.5, remaining: 37.5, unit: 'USD' },
  rate_limits: [
    { window: '5h', limit: 10, used: 2.5, remaining: 7.5, reset_at: '2026-09-03T20:00:00Z' },
    { window: '1d', limit: 20, used: 5, remaining: 15 },
    { window: '7d', limit: 100, used: 80, remaining: 20, reset_at: '2026-09-07T00:00:00Z' },
  ],
  expires_at: '2026-10-01T00:00:00Z',
};

const SUBSCRIPTION = {
  mode: 'unrestricted',
  isValid: true,
  planName: 'Claude Pro 拼车',
  unit: 'USD',
  remaining: 30,
  subscription: {
    daily_usage_usd: 1.5,
    weekly_usage_usd: 9,
    monthly_usage_usd: 20,
    daily_limit_usd: 5,
    weekly_limit_usd: 30,
    monthly_limit_usd: 100,
    expires_at: '2026-10-01T00:00:00Z',
  },
};

const WALLET = { mode: 'unrestricted', isValid: true, planName: '钱包余额', remaining: 8.35, unit: 'USD', balance: 8.35 };

test('sub2api: quota_limited → 总额度 + 5小时/每日/每周窗口', () => {
  const r = parseUsage(QUOTA_LIMITED);
  assert.deepEqual(
    r.windows.map((w) => [w.name, w.usedPercent, w.used, w.total, w.unit]),
    [
      ['总额度', 25, 12.5, 50, 'USD'],
      ['5小时', 25, 2.5, 10, 'USD'],
      ['每日', 25, 5, 20, 'USD'],
      ['每周', 80, 80, 100, 'USD'],
    ],
  );
  assert.equal(r.windows[1].resetAt, Date.parse('2026-09-03T20:00:00Z'));
  assert.equal(r.windows[2].resetAt, null); // 窗口未开始/已过期时无 reset_at
});

test('sub2api: 订阅模式 → 每日/每周/每月窗口 + plan', () => {
  const r = parseUsage(SUBSCRIPTION);
  assert.equal(r.plan, 'Claude Pro 拼车');
  assert.deepEqual(
    r.windows.map((w) => [w.name, w.usedPercent]),
    [
      ['每日', 30],
      ['每周', 30],
      ['每月', 20],
    ],
  );
});

test('sub2api: 钱包模式 → balance，无 plan 标签', () => {
  const r = parseUsage(WALLET);
  assert.deepEqual(r.balance, { currency: 'USD', total: 8.35, granted: 0, paid: 8.35 });
  assert.equal(r.windows.length, 0);
  assert.equal(r.plan, null);
});

test('sub2api: 结构变异 → upstream_changed', () => {
  assert.throws(() => parseUsage({ mode: 'quota_limited' }), (e) => e.kind === 'upstream_changed');
  assert.throws(() => parseUsage(null), (e) => e.kind === 'upstream_changed');
  assert.throws(() => parseUsage({ hello: 1 }), (e) => e.kind === 'upstream_changed');
});

test('sub2api: parseResponse 状态映射', () => {
  assert.throws(() => sub2api.parseResponse(401, '{}'), (e) => e.kind === 'auth_expired');
  assert.throws(() => sub2api.parseResponse(429, '{}'), (e) => e.kind === 'rate_limited');
  assert.throws(() => sub2api.parseResponse(500, '{}'), (e) => e.kind === 'unavailable');
  assert.throws(() => sub2api.parseResponse(200, 'not json'), (e) => e.kind === 'upstream_changed');
  const ok = sub2api.parseResponse(200, JSON.stringify(QUOTA_LIMITED));
  assert.equal(ok.windows.length, 4);
});

test('sub2api: instanceUrl 校验（仅 https / 环回 http，禁 userinfo）', () => {
  assert.equal(parseInstanceUrl('https://s2a.example.com/'), 'https://s2a.example.com');
  assert.equal(parseInstanceUrl('http://127.0.0.1:8080'), 'http://127.0.0.1:8080');
  assert.throws(() => parseInstanceUrl('http://s2a.example.com'), (e) => e.kind === 'upstream_changed');
  assert.throws(() => parseInstanceUrl('https://user:pass@s2a.example.com'), (e) => e.kind === 'upstream_changed');
  assert.throws(() => parseInstanceUrl('not a url'), (e) => e.kind === 'upstream_changed');
});

test('sub2api: buildRequest 命中通配白名单', () => {
  const cred = { instanceUrl: 'https://s2a.example.com/', apiKey: 'sk-abcd1234wxyz' };
  const req = sub2api.buildRequest(cred);
  assert.equal(req.url, 'https://s2a.example.com/v1/usage');
  assert.equal(req.headers.authorization, 'Bearer sk-abcd1234wxyz');
  assert.deepEqual(sub2api.allowed, [{ method: 'GET', host: '*', pathPrefix: '/v1/usage' }]);
});
