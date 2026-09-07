// codex adapter 解析函数单测（fixture 内联脱敏，不联网）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import codex, {
  parseAuthFiles,
  parseApiCallResponse,
  parseWhamUsage,
  extractCacheSnapshot,
  extractSignalsQuota,
} from '../../src/standalone/providers/codex.js';
import { QuotaError } from '../../src/standalone/providers/http.js';

const WHAM = {
  plan_type: 'plus',
  rate_limit: {
    primary_window: { used_percent: 37.5, reset_at: 1757498400, limit_window_seconds: 18000 },
    secondary_window: { used_percent: 8, reset_at: 1757808000, limit_window_seconds: 604800 },
  },
};

test('codex: parseWhamUsage 正常解析 → 5小时/每周', () => {
  const r = parseWhamUsage(WHAM);
  assert.equal(r.plan, 'plus');
  assert.equal(r.windows.length, 2);
  assert.deepEqual(
    r.windows.map((w) => [w.name, w.usedPercent, w.resetAt]),
    [
      ['5小时', 38, 1757498400 * 1000],
      ['每周', 8, 1757808000 * 1000],
    ],
  );
});

test('codex: parseWhamUsage 结构变异 → upstream_changed', () => {
  assert.throws(() => parseWhamUsage({ plan_type: 'plus' }), (e) => e.kind === 'upstream_changed');
  assert.throws(
    () => parseWhamUsage({ rate_limit: { primary_window: { used_percent: 'x' } } }),
    (e) => e.kind === 'upstream_changed',
  );
  assert.throws(() => parseWhamUsage(null), (e) => e.kind === 'upstream_changed');
});

test('codex: parseApiCallResponse 兼容 CPA 包装（body 字符串 / 对象）与上游原文直出', () => {
  // 包装 + body 为 JSON 字符串
  const wrapped = parseApiCallResponse(200, JSON.stringify({ status: 200, body: JSON.stringify(WHAM) }));
  assert.equal(wrapped.plan_type, 'plus');
  // 包装 + body 已是对象
  const wrappedObj = parseApiCallResponse(200, JSON.stringify({ status: 200, body: WHAM }));
  assert.equal(wrappedObj.plan_type, 'plus');
  // 上游原文直出
  const raw = parseApiCallResponse(200, JSON.stringify(WHAM));
  assert.equal(raw.plan_type, 'plus');
  // 包装内层状态映射
  assert.throws(
    () => parseApiCallResponse(200, JSON.stringify({ status: 401, body: {} })),
    (e) => e.kind === 'auth_expired',
  );
  assert.throws(
    () => parseApiCallResponse(200, JSON.stringify({ status: 500, body: {} })),
    (e) => e.kind === 'unavailable',
  );
  // 外层 http 状态映射
  assert.throws(() => parseApiCallResponse(403, '{}'), (e) => e.kind === 'auth_expired');
  assert.throws(() => parseApiCallResponse(200, 'not json'), (e) => e.kind === 'upstream_changed');
});

test('codex: extractCacheSnapshot 真实形态（entry.id 键、usage.codex、ISO reset_at 纳秒）', () => {
  const accounts = {
    accounts: [
      {
        id: 'a5d39034994e02e3',
        plan_type: 'plus',
        usage: {
          codex: {
            five_hour: { reset_at: '2026-09-03T19:22:07.486518148Z', used_percent: 4, window_minutes: 300 },
            seven_day: { reset_at: '2026-09-10T08:25:23.486518148Z', used_percent: 16, window_minutes: 10080 },
            plan_type: 'plus',
          },
        },
      },
      { id: '95373967a8ebdca7', email: 'someone@example.com' },
    ],
  };
  const hit = extractCacheSnapshot(accounts, 'a5d39034994e02e3');
  assert.equal(hit.plan, 'plus');
  assert.deepEqual(
    hit.windows.map((w) => [w.name, w.usedPercent, w.resetAt]),
    [
      ['5小时', 4, Date.parse('2026-09-03T19:22:07.486Z')],
      ['每周', 16, Date.parse('2026-09-10T08:25:23.486Z')],
    ],
  );
  assert.equal(extractCacheSnapshot(accounts, '95373967a8ebdca7'), null); // 无 codex 快照
  assert.equal(extractCacheSnapshot(accounts, 'ffffffffffffffff'), null); // authIndex 不存在
  assert.equal(extractCacheSnapshot({ nope: 1 }, 'x'), null);
});

test('codex: extractSignalsQuota 解析 X-Codex-* 被动信号', () => {
  const json = {
    files: [
      {
        auth_index: '95373967a8ebdca7',
        quota: {
          signals: {
            'X-Codex-Plan-Type': 'plus',
            'X-Codex-Primary-Used-Percent': '4',
            'X-Codex-Primary-Window-Minutes': '300',
            'X-Codex-Primary-Reset-At': '1788463307',
            'X-Codex-Secondary-Used-Percent': '16',
            'X-Codex-Secondary-Window-Minutes': '10080',
            'X-Codex-Secondary-Reset-At': '1789028703',
          },
        },
      },
      { auth_index: '4b1e8a00a39540b0', quota: { signals: {} } },
    ],
  };
  const hit = extractSignalsQuota(json, '95373967a8ebdca7');
  assert.equal(hit.plan, 'plus');
  assert.deepEqual(
    hit.windows.map((w) => [w.name, w.usedPercent, w.resetAt]),
    [
      ['5小时', 4, 1788463307000],
      ['每周', 16, 1789028703000],
    ],
  );
  assert.equal(extractSignalsQuota(json, '4b1e8a00a39540b0'), null); // 空 signals
  assert.equal(extractSignalsQuota(json, 'ffffffffffffffff'), null);
});

test('codex: extractSignalsQuota 周窗口为主窗口时按 minutes 命名', () => {
  const json = {
    files: [
      {
        auth_index: 'a5d3',
        quota: {
          signals: {
            'X-Codex-Primary-Used-Percent': '8',
            'X-Codex-Primary-Window-Minutes': '10080',
            'X-Codex-Primary-Reset-At': '1788939116',
            'X-Codex-Secondary-Used-Percent': '0',
            'X-Codex-Secondary-Window-Minutes': '0',
          },
        },
      },
    ],
  };
  const hit = extractSignalsQuota(json, 'a5d3');
  assert.deepEqual(hit.windows.map((w) => w.name), ['每周']); // 0 分钟窗口跳过
});

test('codex: parseAuthFiles → 脱敏账号列表', () => {
  const list = parseAuthFiles({
    files: [
      { auth_index: 2, email: 'someone@example.com', disabled: false, status: 'ready' },
      { auth_index: 3, email: 'b@x.io', disabled: true, status: 'error' },
    ],
  });
  assert.deepEqual(list, [
    { authIndex: 2, maskedEmail: 's***@e***.com', disabled: false, status: 'ready' },
    { authIndex: 3, maskedEmail: 'b***@x***.io', disabled: true, status: 'error' },
  ]);
  assert.throws(() => parseAuthFiles({}), (e) => e.kind === 'upstream_changed');
});

test('codex: adapter 形状与白名单（CPA_MGMT_URL 固定的 http 特例；绝不包含 usage-queue）', () => {
  assert.equal(codex.id, 'codex');
  assert.deepEqual(codex.credentialFields.map((f) => f.key), ['managementKey']);
  for (const a of codex.allowed) {
    assert.equal(a.host, '127.0.0.1:8317'); // 测试环境未设 CPA_MGMT_URL，默认本机管理口
    assert.ok(!a.pathPrefix.includes('usage-queue'));
  }
  const req = codex.buildRequest({ managementKey: 'mgmt-12345678' });
  assert.ok(req.url.startsWith('http://127.0.0.1:8317/v0/management/auth-files'));
  assert.equal(req.headers.authorization, 'Bearer mgmt-12345678');
});
