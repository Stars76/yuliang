import { test } from 'node:test';
import assert from 'node:assert/strict';
import adapter, { parseResetAt, parseUsage } from '../../src/server/providers/ollama.js';
import { QuotaError } from '../../src/server/providers/http.js';

const FIXTURE = {
  plan_data: { type: 'pro' },
  usage: {
    session: { percentage: '12.5', reset_at: 1757498400 },
    weekly: { used_percent: 42, resetAt: '2026-09-10T00:00:00Z' },
    included: { used: '25', total: '100', reset: 1757808000000, unit: 'USD' },
  },
};

test('ollama: 解析嵌套 session/weekly/included 窗口和套餐', () => {
  const result = adapter.parseResponse(200, JSON.stringify(FIXTURE));
  assert.equal(result.plan, 'pro');
  assert.deepEqual(result.windows.map((w) => [w.name, w.usedPercent]), [
    ['5小时', 12.5],
    ['每周', 42],
    ['每月', 25],
  ]);
  assert.equal(result.windows[0].resetAt, 1757498400 * 1000);
  assert.equal(result.windows[2].used, 25);
  assert.equal(result.windows[2].total, 100);
  assert.equal(result.windows[2].unit, 'USD');
});

test('ollama: 兼容扁平别名、数字字符串、used+remaining 和百分比限制', () => {
  const result = parseUsage({
    plan_name: 'team',
    session_usage: { used: '2', remaining: '8' },
    weekly_usage: { pct: '101', resets_at: '1757808000' },
    monthly_usage: { percentage: '0' },
  });
  assert.equal(result.plan, 'team');
  assert.deepEqual(result.windows.map((w) => [w.name, w.usedPercent]), [
    ['5小时', 20],
    ['每周', 100],
    ['每月', 0],
  ]);
  assert.equal(result.windows[1].resetAt, 1757808000000);
  assert.equal(parseResetAt('1757498400000'), 1757498400000);
});

test('ollama: total-only 窗口不伪造 0%，非正 reset 时间无效', () => {
  const result = parseUsage({ monthly: { total: 250, reset_at: -1 } });
  assert.equal(result.windows[0].used, null);
  assert.equal(result.windows[0].total, 250);
  assert.equal(result.windows[0].usedPercent, null);
  assert.equal(parseResetAt(-1), null);
  assert.equal(parseResetAt('1970-01-01T00:00:00Z'), null);
});

test('ollama: 状态映射和不可识别结构', () => {
  assert.throws(() => adapter.parseResponse(401, '{}'), (e) => e instanceof QuotaError && e.kind === 'auth_expired');
  assert.throws(() => adapter.parseResponse(403, '{}'), (e) => e.kind === 'auth_expired');
  assert.throws(() => adapter.parseResponse(429, '{}'), (e) => e.kind === 'rate_limited');
  assert.throws(() => adapter.parseResponse(500, '{}'), (e) => e.kind === 'unavailable');
  assert.throws(() => adapter.parseResponse(200, 'oops'), (e) => e.kind === 'upstream_changed');
  assert.throws(() => adapter.parseResponse(200, JSON.stringify({ usage: {} })), (e) => e.kind === 'upstream_changed');
});

test('ollama: 固定只读 GET usage 白名单，不触发模型接口', () => {
  assert.equal(adapter.id, 'ollama');
  assert.deepEqual(adapter.allowed, [{ method: 'GET', host: 'ollama.com', pathPrefix: '/api/usage' }]);
  const req = adapter.buildRequest({ apiKey: 'ollama-key-fixture' });
  assert.equal(req.method, 'GET');
  assert.equal(req.url, 'https://ollama.com/api/usage');
  assert.equal(req.headers.authorization, 'Bearer ollama-key-fixture');
  assert.equal(adapter.extraRequests, undefined);
});
