// openrouter adapter 单测（fixture 内联，不联网）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import openrouter from '../../src/standalone/providers/openrouter.js';
import { QuotaError } from '../../src/standalone/providers/http.js';

test('openrouter: 正常解析 credits（余额 = total_credits - total_usage）', () => {
  const r = openrouter.parseResponse(200, JSON.stringify({ data: { total_credits: 100.5, total_usage: 25.75 } }));
  assert.equal(r.plan, null);
  assert.deepEqual(r.windows, []);
  assert.deepEqual(r.balance, { currency: 'USD', total: 74.75, granted: null, paid: null, used: 25.75 });
  assert.equal(r.error, null);
});

test('openrouter: usage 超过 credits → upstream_changed（不伪造负余额）', () => {
  assert.throws(
    () => openrouter.parseResponse(200, JSON.stringify({ data: { total_credits: 10, total_usage: 20 } })),
    (e) => e.kind === 'upstream_changed',
  );
});

test('openrouter: 结构变异/缺字段 → upstream_changed', () => {
  assert.throws(() => openrouter.parseResponse(200, '{}'), (e) => e.kind === 'upstream_changed');
  assert.throws(() => openrouter.parseResponse(200, '{"data":{}}'), (e) => e.kind === 'upstream_changed');
  assert.throws(() => openrouter.parseResponse(200, 'oops'), (e) => e.kind === 'upstream_changed');
  assert.throws(
    () => openrouter.parseResponse(200, JSON.stringify({ data: { total_credits: 'abc', total_usage: 1 } })),
    (e) => e.kind === 'upstream_changed',
  );
});

test('openrouter: http 状态映射 / buildRequest 白名单', () => {
  assert.throws(() => openrouter.parseResponse(401, '{}'), (e) => e.kind === 'auth_expired');
  assert.throws(() => openrouter.parseResponse(429, '{}'), (e) => e.kind === 'rate_limited');
  assert.equal(openrouter.kind, 'balance');
  const req = openrouter.buildRequest({ apiKey: 'sk-or-v1-test' });
  const url = new URL(req.url);
  assert.equal(url.host, 'openrouter.ai');
  assert.equal(url.pathname, '/api/v1/credits');
  assert.equal(req.headers.authorization, 'Bearer sk-or-v1-test');
  assert.equal(req.method, 'GET');
});
