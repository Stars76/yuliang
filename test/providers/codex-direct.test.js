import { test } from 'node:test';
import assert from 'node:assert/strict';
import adapter, { parseResetAt, parseWhamUsage } from '../../src/standalone/providers/codex-direct.js';
import { QuotaError } from '../../src/standalone/providers/http.js';

const FIXTURE = {
  plan_type: 'plus',
  rate_limit: {
    primary_window: { used_percent: '37.5', reset_at: 1757498400, limit_window_seconds: 18000 },
    secondary_window: { used_percent: 8, reset_at: '1757808000000', limit_window_seconds: 604800 },
  },
};

test('codex-direct: 解析套餐、5 小时和每周窗口，兼容数字字符串时间', () => {
  const result = adapter.parseResponse(200, JSON.stringify(FIXTURE));
  assert.equal(result.plan, 'plus');
  assert.deepEqual(
    result.windows.map((w) => [w.name, w.usedPercent, w.resetAt]),
    [
      ['5小时', 37.5, 1757498400 * 1000],
      ['每周', 8, 1757808000000],
    ],
  );
});

test('codex-direct: 未知窗口回退到主/次窗口名称，ISO reset 兼容', () => {
  const result = parseWhamUsage({
    rate_limit: {
      primary_window: { percent: '101', resetAt: '2026-09-04T00:00:00Z', limit_window_seconds: 999 },
      secondary_window: { percentage: 0, reset: 1780000000000, limit_window_seconds: 999 },
    },
  });
  assert.deepEqual(result.windows.map((w) => w.name), ['5小时', '每周']);
  assert.equal(result.windows[0].usedPercent, 100);
  assert.equal(result.windows[0].resetAt, Date.parse('2026-09-04T00:00:00Z'));
  assert.equal(parseResetAt(1757498400), 1757498400000);
  assert.equal(parseResetAt(1757498400000), 1757498400000);
  assert.equal(parseResetAt(-1), null);
  assert.equal(parseResetAt('1970-01-01T00:00:00Z'), null);
});

test('codex-direct: 错误状态与坏结构统一映射', () => {
  assert.throws(() => adapter.parseResponse(401, '{}'), (e) => e instanceof QuotaError && e.kind === 'auth_expired');
  assert.throws(() => adapter.parseResponse(403, '{}'), (e) => e.kind === 'auth_expired');
  assert.throws(() => adapter.parseResponse(429, '{}'), (e) => e.kind === 'rate_limited');
  assert.throws(() => adapter.parseResponse(502, '{}'), (e) => e.kind === 'unavailable');
  assert.throws(() => adapter.parseResponse(200, 'not json'), (e) => e.kind === 'upstream_changed');
  assert.throws(() => adapter.parseResponse(200, JSON.stringify({ rate_limit: {} })), (e) => e.kind === 'upstream_changed');
});

test('codex-direct: 直连请求固定端点、账号头、UA 和单一 GET 白名单', () => {
  assert.equal(adapter.id, 'codex-direct');
  assert.deepEqual(adapter.credentialFields.map((f) => [f.key, f.secret]), [['accessToken', true], ['accountId', false]]);
  assert.deepEqual(adapter.allowed, [{ method: 'GET', host: 'chatgpt.com', pathPrefix: '/backend-api/wham/usage' }]);
  const req = adapter.buildRequest({ accessToken: 'access-token-fixture', accountId: 'account-fixture' });
  assert.equal(req.method, 'GET');
  assert.equal(req.url, 'https://chatgpt.com/backend-api/wham/usage');
  assert.equal(req.headers.authorization, 'Bearer access-token-fixture');
  assert.equal(req.headers['ChatGPT-Account-Id'], 'account-fixture');
  assert.match(req.headers['user-agent'], /^codex_cli_rs\//);
  assert.equal(adapter.extraRequests, undefined);
});
