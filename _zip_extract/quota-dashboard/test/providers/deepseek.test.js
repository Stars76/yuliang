// deepseek adapter 单测（fixture 内联脱敏，不联网）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import deepseek from '../../src/server/providers/deepseek.js';
import { QuotaError } from '../../src/server/providers/http.js';

const FIXTURE = {
  is_available: true,
  balance_infos: [
    {
      currency: 'CNY',
      total_balance: '58.36',
      granted_balance: '10.00',
      topped_up_balance: '48.36',
    },
  ],
};

test('deepseek: 正常解析 balance（字符串金额 → parseFloat）', () => {
  const r = deepseek.parseResponse(200, JSON.stringify(FIXTURE));
  assert.equal(r.plan, null);
  assert.deepEqual(r.windows, []);
  assert.deepEqual(r.balance, { currency: 'CNY', total: 58.36, granted: 10, paid: 48.36 });
  assert.equal(r.error, null);
});

test('deepseek: is_available=false → unavailable', () => {
  const body = { is_available: false, balance_infos: FIXTURE.balance_infos };
  assert.throws(
    () => deepseek.parseResponse(200, JSON.stringify(body)),
    (e) => e instanceof QuotaError && e.kind === 'unavailable',
  );
});

test('deepseek: 结构变异 → upstream_changed', () => {
  assert.throws(
    () => deepseek.parseResponse(200, JSON.stringify({ is_available: true })),
    (e) => e.kind === 'upstream_changed',
  );
  assert.throws(
    () =>
      deepseek.parseResponse(
        200,
        JSON.stringify({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: 'abc' }] }),
      ),
    (e) => e.kind === 'upstream_changed',
  );
  assert.throws(() => deepseek.parseResponse(200, 'oops'), (e) => e.kind === 'upstream_changed');
});

test('deepseek: http 状态映射 / buildRequest', () => {
  assert.throws(() => deepseek.parseResponse(401, '{}'), (e) => e.kind === 'auth_expired');
  assert.throws(() => deepseek.parseResponse(429, '{}'), (e) => e.kind === 'rate_limited');
  assert.equal(deepseek.kind, 'balance');
  const req = deepseek.buildRequest({ apiKey: 'sk-deepseek-001122' });
  const url = new URL(req.url);
  assert.equal(url.host, 'api.deepseek.com');
  assert.ok(url.pathname.startsWith('/user/balance'));
  assert.equal(req.headers.authorization, 'Bearer sk-deepseek-001122');
});
