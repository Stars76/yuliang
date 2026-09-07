// zai / bigmodel adapter 单测（fixture 内联脱敏，不联网）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import zai, { bigmodel } from '../../src/server/providers/zhipu.js';
import { QuotaError } from '../../src/server/providers/http.js';

const FIXTURE = {
  code: 200,
  msg: 'ok',
  data: {
    level: 'pro',
    limits: [
      { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 42.4, nextResetTime: 1757498400000 },
      { type: 'TOKENS_LIMIT', unit: 6, number: 7, percentage: 10.6, nextResetTime: 1757808000000 },
      { type: 'TIME_LIMIT', unit: 1, number: 30, percentage: 0 },
    ],
  },
};

test('zai: 按 unit/type 分类，percentage 为已用百分比', () => {
  const r = zai.parseResponse(200, JSON.stringify(FIXTURE));
  assert.equal(r.plan, 'pro');
  assert.equal(r.windows.length, 3);
  const [w5h, wWeek, mcp] = r.windows;
  assert.equal(w5h.name, '5小时');
  assert.equal(w5h.usedPercent, 42);
  assert.equal(w5h.resetAt, 1757498400000);
  assert.equal(wWeek.name, '每周');
  assert.equal(wWeek.usedPercent, 11);
  assert.equal(mcp.name, 'MCP(月)');
  assert.equal(mcp.usedPercent, 0);
  assert.equal(mcp.resetAt, null); // 0% 时无 nextResetTime
});

test('zai: number=5 兜底分类为 5小时', () => {
  const body = { data: { limits: [{ type: 'TOKENS_LIMIT', number: 5, percentage: 7 }] } };
  const r = zai.parseResponse(200, JSON.stringify(body));
  assert.equal(r.windows[0].name, '5小时');
});

test('zai: 结构变异 → upstream_changed', () => {
  assert.throws(() => zai.parseResponse(200, JSON.stringify({ data: {} })), (e) => e.kind === 'upstream_changed');
  assert.throws(
    () => zai.parseResponse(200, JSON.stringify({ data: { limits: [{ unit: 3, percentage: 'high' }] } })),
    (e) => e.kind === 'upstream_changed',
  );
  assert.throws(
    () => zai.parseResponse(200, JSON.stringify({ data: { limits: [{ unit: 99, percentage: 1 }] } })),
    (e) => e.kind === 'upstream_changed', // 无已知窗口
  );
  assert.throws(() => zai.parseResponse(200, 'x'), (e) => e.kind === 'upstream_changed');
});

test('zai/bigmodel: 端点与裸 key 鉴权', () => {
  for (const [adapter, host] of [[zai, 'api.z.ai'], [bigmodel, 'open.bigmodel.cn']]) {
    const req = adapter.buildRequest({ apiKey: 'abc.key' });
    const url = new URL(req.url);
    assert.equal(url.host, host);
    assert.ok(url.pathname.startsWith('/api/monitor/usage/quota/limit'));
    assert.equal(req.headers.authorization, 'abc.key'); // 无 Bearer 前缀
  }
  assert.equal(zai.id, 'zai');
  assert.equal(bigmodel.id, 'bigmodel');
});

test('zai: http 状态映射', () => {
  assert.throws(() => zai.parseResponse(403, '{}'), (e) => e.kind === 'auth_expired');
  assert.throws(() => zai.parseResponse(429, '{}'), (e) => e.kind === 'rate_limited');
  assert.throws(() => zai.parseResponse(502, '{}'), (e) => e.kind === 'unavailable');
});
