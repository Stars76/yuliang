// newapi adapter 单测（fixture 内联脱敏，不联网）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import newapi, { parseInstanceUrl, QUOTA_PER_USD } from '../../src/standalone/providers/newapi.js';
import { QuotaError } from '../../src/standalone/providers/http.js';

const FIXTURE = {
  success: true,
  data: {
    id: 1,
    username: 'tester',
    quota: 5_000_000, // $10 剩余
    used_quota: 2_500_000, // $5 已用
  },
};

test('newapi: 正常解析 balance（quota 单位 500000 = 1 USD）', () => {
  const r = newapi.parseResponse(200, JSON.stringify(FIXTURE));
  assert.equal(r.plan, 'tester');
  assert.deepEqual(r.windows, []);
  assert.equal(r.balance.currency, 'USD');
  assert.equal(r.balance.total, 10);
  assert.equal(r.balance.used, 5);
  assert.equal(r.balance.granted, null);
  assert.equal(r.balance.paid, null);
  assert.equal(r.error, null);
});

test('newapi: success=false → auth_expired（令牌或用户 ID 无效）', () => {
  assert.throws(
    () => newapi.parseResponse(200, JSON.stringify({ success: false, message: '无权访问' })),
    (e) => e instanceof QuotaError && e.kind === 'auth_expired',
  );
});

test('newapi: 结构变异 → upstream_changed', () => {
  assert.throws(() => newapi.parseResponse(200, 'oops'), (e) => e.kind === 'upstream_changed');
  assert.throws(
    () => newapi.parseResponse(200, JSON.stringify({ success: true })),
    (e) => e.kind === 'auth_expired',
  );
  assert.throws(
    () => newapi.parseResponse(200, JSON.stringify({ success: true, data: { quota: 'abc', used_quota: 0 } })),
    (e) => e.kind === 'upstream_changed',
  );
  assert.throws(
    () => newapi.parseResponse(200, JSON.stringify({ success: true, data: { quota: -1, used_quota: 0 } })),
    (e) => e.kind === 'upstream_changed',
  );
});

test('newapi: http 状态映射', () => {
  assert.throws(() => newapi.parseResponse(401, '{}'), (e) => e.kind === 'auth_expired');
  assert.throws(() => newapi.parseResponse(403, '{}'), (e) => e.kind === 'auth_expired');
  assert.throws(() => newapi.parseResponse(429, '{}'), (e) => e.kind === 'rate_limited');
  assert.throws(() => newapi.parseResponse(500, '{}'), (e) => e.kind === 'unavailable');
});

test('newapi: buildRequest 头与路径固定，host 由凭证提供', () => {
  assert.equal(newapi.kind, 'balance');
  const req = newapi.buildRequest({
    instanceUrl: 'https://api.example.com/',
    userId: 1,
    accessToken: 'token-001122',
  });
  const url = new URL(req.url);
  assert.equal(url.host, 'api.example.com');
  assert.equal(url.pathname, '/api/user/self');
  assert.equal(req.headers.authorization, 'Bearer token-001122');
  assert.equal(req.headers['new-api-user'], '1');
});

test('newapi: parseInstanceUrl 校验（https 强制 / 环回 http / userinfo 拒绝）', () => {
  assert.equal(parseInstanceUrl('https://api.example.com'), 'https://api.example.com');
  assert.equal(parseInstanceUrl('http://127.0.0.1:3000'), 'http://127.0.0.1:3000');
  assert.throws(() => parseInstanceUrl('http://api.example.com'), (e) => e.kind === 'upstream_changed');
  assert.throws(
    () => parseInstanceUrl('https://user:pass@api.example.com'),
    (e) => e.kind === 'upstream_changed',
  );
  assert.throws(() => parseInstanceUrl('not a url'), (e) => e.kind === 'upstream_changed');
});

test('newapi: QUOTA_PER_USD 常量固定为 500000', () => {
  assert.equal(QUOTA_PER_USD, 500000);
});
