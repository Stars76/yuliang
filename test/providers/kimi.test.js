// Kimi adapter 单测（fixture 内联脱敏，不联网）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import kimi from '../../src/standalone/providers/kimi.js';
import { QuotaError } from '../../src/standalone/providers/http.js';

const FIXTURE = {
  limits: [
    {
      detail: { limit: 100, remaining: 62, resetTime: '2026-09-03T10:00:00Z' },
      usage: { limit: 500, remaining: 500, resetTime: 1757808000000 },
    },
    { detail: { limit: 200, remaining: 40, resetTime: 1757498400 } },
  ],
};

test('kimi: 正常解析 detail(5小时,可多条) + usage(每周)', () => {
  const r = kimi.parseResponse(200, JSON.stringify(FIXTURE));
  assert.equal(r.plan, null);
  assert.equal(r.error, null);
  assert.equal(r.windows.length, 3);
  const [w5h, wWeek, w5h2] = r.windows;
  assert.equal(w5h.name, '5小时');
  assert.equal(w5h.usedPercent, 38); // round((1-62/100)*100)
  assert.equal(w5h.resetAt, Date.parse('2026-09-03T10:00:00Z'));
  assert.equal(wWeek.name, '每周');
  assert.equal(wWeek.usedPercent, 0);
  assert.equal(wWeek.resetAt, 1757808000000); // epoch 毫秒原样
  assert.equal(w5h2.name, '5小时');
  assert.equal(w5h2.usedPercent, 80);
  assert.equal(w5h2.resetAt, 1757498400 * 1000); // epoch 秒 → 毫秒
});

test('kimi: 结构变异 → upstream_changed', () => {
  assert.throws(
    () => kimi.parseResponse(200, JSON.stringify({ data: [] })),
    (e) => e instanceof QuotaError && e.kind === 'upstream_changed',
  );
  assert.throws(
    () => kimi.parseResponse(200, JSON.stringify({ limits: [{ detail: { limit: 0, remaining: 0 } }] })),
    (e) => e.kind === 'upstream_changed',
  );
  assert.throws(() => kimi.parseResponse(200, 'not json'), (e) => e.kind === 'upstream_changed');
  assert.throws(
    () => kimi.parseResponse(200, JSON.stringify({ limits: [] })),
    (e) => e.kind === 'upstream_changed',
  );
});

test('kimi: http 状态映射', () => {
  assert.throws(() => kimi.parseResponse(401, '{}'), (e) => e.kind === 'auth_expired');
  assert.throws(() => kimi.parseResponse(429, '{}'), (e) => e.kind === 'rate_limited');
  assert.throws(() => kimi.parseResponse(500, '{}'), (e) => e.kind === 'unavailable');
});

test('kimi: buildRequest 命中白名单且 Bearer', () => {
  const req = kimi.buildRequest({ apiKey: 'sk-x' });
  const url = new URL(req.url);
  assert.equal(url.protocol, 'https:');
  assert.equal(url.host, 'api.kimi.com');
  assert.ok(url.pathname.startsWith('/coding/v1/usages'));
  assert.equal(req.headers.authorization, 'Bearer sk-x');
});

const WITH_LEVEL = { ...FIXTURE, user: { membership: { level: 'LEVEL_INTERMEDIATE' } } };

test('kimi: 套餐名优先取 /me 的 user_level_name', () => {
  const extras = [{ id: 'me', status: 200, bodyText: JSON.stringify({ user_level_name: 'Allegro', email: 'x@y.z' }) }];
  const r = kimi.parseResponse(200, JSON.stringify(WITH_LEVEL), extras);
  assert.equal(r.plan, 'Allegro');
});

test('kimi: /me 不可用或缺字段时兜底 LEVEL_* 映射', () => {
  // /me 网络失败（status null）
  let r = kimi.parseResponse(200, JSON.stringify(WITH_LEVEL), [{ id: 'me', status: null, bodyText: null }]);
  assert.equal(r.plan, 'Allegretto');
  // /me 返回非 200
  r = kimi.parseResponse(200, JSON.stringify(WITH_LEVEL), [{ id: 'me', status: 401, bodyText: '{}' }]);
  assert.equal(r.plan, 'Allegretto');
  // /me 缺 user_level_name
  r = kimi.parseResponse(200, JSON.stringify(WITH_LEVEL), [{ id: 'me', status: 200, bodyText: '{"user_level":25}' }]);
  assert.equal(r.plan, 'Allegretto');
  // 无 extras（旧调用方式）
  r = kimi.parseResponse(200, JSON.stringify(WITH_LEVEL));
  assert.equal(r.plan, 'Allegretto');
});

test('kimi: 未知 LEVEL_* 枚举转可读形式，无 level 则 plan 为 null', () => {
  const unknown = { ...FIXTURE, user: { membership: { level: 'LEVEL_SUPER_ADVANCED' } } };
  assert.equal(kimi.parseResponse(200, JSON.stringify(unknown)).plan, 'Super Advanced');
  assert.equal(kimi.parseResponse(200, JSON.stringify(FIXTURE)).plan, null);
});

test('kimi: extraRequests 命中白名单且与主请求同鉴权', () => {
  const [me] = kimi.extraRequests({ apiKey: 'sk-x' });
  assert.equal(me.id, 'me');
  const url = new URL(me.url);
  assert.equal(url.protocol, 'https:');
  assert.equal(url.host, 'api.kimi.com');
  assert.equal(url.pathname, '/coding/v1/me');
  assert.equal(me.headers.authorization, 'Bearer sk-x');
  // 主请求与附加请求都在 allowed 白名单内
  for (const req of [kimi.buildRequest({ apiKey: 'sk-x' }), me]) {
    const u = new URL(req.url);
    assert.ok(
      kimi.allowed.some((a) => a.method === req.method && a.host === u.host && u.pathname.startsWith(a.pathPrefix)),
      `${u.pathname} 不在白名单`,
    );
  }
});
