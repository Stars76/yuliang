import { test } from 'node:test';
import assert from 'node:assert/strict';
import adapter, {
  parseResetAt,
  parseWhamUsage,
  decodeJwtPayload,
  accountIdOf,
  requestDeviceCode,
  pollDeviceCode,
  exchangeDeviceCode,
  refreshCodexSession,
  fetchCodexDirect,
} from '../../src/server/providers/codex-direct.js';
import { QuotaError } from '../../src/server/providers/http.js';

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

test('codex-direct: OAuth 模式无手动字段，直连请求固定端点/账号头/UA/白名单', () => {
  assert.equal(adapter.id, 'codex-direct');
  assert.equal(adapter.authMode, 'oauth');
  assert.deepEqual(adapter.credentialFields, []);
  assert.deepEqual(adapter.allowed, [{ method: 'GET', host: 'chatgpt.com', pathPrefix: '/backend-api/wham/usage' }]);
  const req = adapter.buildRequest({ accessToken: 'access-token-fixture', accountId: 'account-fixture' });
  assert.equal(req.method, 'GET');
  assert.equal(req.url, 'https://chatgpt.com/backend-api/wham/usage');
  assert.equal(req.headers.authorization, 'Bearer access-token-fixture');
  assert.equal(req.headers['ChatGPT-Account-Id'], 'account-fixture');
  assert.match(req.headers['user-agent'], /^codex_cli_rs\//);
  assert.equal(adapter.extraRequests, undefined);
});

test('codex-direct: JWT 解码与 accountId 提取', () => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const token = `${b64({ alg: 'none' })}.${b64({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acc_123' } })}.sig`;
  assert.deepEqual(decodeJwtPayload(token), { 'https://api.openai.com/auth': { chatgpt_account_id: 'acc_123' } });
  assert.equal(accountIdOf(token), 'acc_123');
  assert.equal(decodeJwtPayload('not-a-jwt'), undefined);
  assert.throws(() => accountIdOf(undefined), (e) => e instanceof QuotaError && e.kind === 'upstream_changed');
  // accountId 为空 → 抛上游变更
  const emptyToken = `${b64({})}.${b64({ 'https://api.openai.com/auth': { chatgpt_account_id: '' } })}.sig`;
  assert.throws(() => accountIdOf(emptyToken), (e) => e instanceof QuotaError && e.kind === 'upstream_changed');
});

test('codex-direct: requestDeviceCode 成功解析与错误分支', async () => {
  // 成功
  global.fetch = async () =>
    ({ status: 200, headers: new Headers({ 'content-type': 'application/json' }), text: async () => JSON.stringify({ device_auth_id: 'dev1', user_code: 'AB-CD', interval: 7 }) });
  const got = await requestDeviceCode();
  assert.equal(got.deviceAuthId, 'dev1');
  assert.equal(got.userCode, 'AB-CD');
  assert.equal(got.intervalSeconds, 7);
  assert.equal(got.verificationUrl, 'https://auth.openai.com/codex/device');

  // 404 = 未启用
  global.fetch = async () => ({ status: 404, headers: new Headers(), text: async () => '' });
  await assert.rejects(() => requestDeviceCode(), (e) => e.kind === 'upstream_changed');

  // Cloudflare challenge（403 + HTML body）
  global.fetch = async () => ({ status: 403, headers: new Headers({ 'content-type': 'text/html' }), text: async () => '<!doctype html><html></html>' });
  await assert.rejects(() => requestDeviceCode(), (e) => e.kind === 'unavailable');
});

test('codex-direct: pollDeviceCode pending 与成功', async () => {
  // pending（403）
  global.fetch = async () => ({ status: 403, headers: new Headers({ 'content-type': 'application/json' }), text: async () => '' });
  const pending = await pollDeviceCode({ deviceAuthId: 'dev1', userCode: 'AB-CD' });
  assert.equal(pending, null);

  // 成功
  global.fetch = async () => ({ status: 200, headers: new Headers({ 'content-type': 'application/json' }), text: async () => JSON.stringify({ authorization_code: 'code1', code_verifier: 'verifier1' }) });
  const done = await pollDeviceCode({ deviceAuthId: 'dev1', userCode: 'AB-CD' });
  assert.deepEqual(done, { authorizationCode: 'code1', codeVerifier: 'verifier1' });
});

test('codex-direct: exchangeDeviceCode 返回含 accountId 的会话', async () => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const idToken = `${b64({})}.${b64({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acc_9' } })}.sig`;
  global.fetch = async () => ({
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    text: async () => JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, id_token: idToken }),
  });
  const s = await exchangeDeviceCode('code1', 'verifier1');
  assert.equal(s.accessToken, 'at');
  assert.equal(s.refreshToken, 'rt');
  assert.equal(s.accountId, 'acc_9');
  assert.ok(s.expiresAt > Date.now());
});

test('codex-direct: refreshCodexSession 用 refresh_token 换新 token', async () => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const idToken = `${b64({})}.${b64({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acc_9' } })}.sig`;
  global.fetch = async () => ({
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    text: async () => JSON.stringify({ access_token: 'at2', refresh_token: 'rt2', expires_in: 7200, id_token: idToken }),
  });
  const s = await refreshCodexSession({ accessToken: 'old', refreshToken: 'rt', expiresAt: Date.now() - 1000, accountId: 'acc_9' });
  assert.equal(s.accessToken, 'at2');
  assert.equal(s.refreshToken, 'rt2');
  assert.equal(s.accountId, 'acc_9');
});

test('codex-direct: fetchCodexDirect 临近过期先续期，再查询额度', async () => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const idToken = `${b64({})}.${b64({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acc_9' } })}.sig`;
  // 第一次 fetch 是续期（TOKEN_URL），第二次是 wham
  let call = 0;
  global.fetch = async (url) => {
    call += 1;
    if (call === 1) {
      assert.equal(url, 'https://auth.openai.com/oauth/token');
      return { status: 200, headers: new Headers({ 'content-type': 'application/json' }), text: async () => JSON.stringify({ access_token: 'at2', refresh_token: 'rt2', expires_in: 7200, id_token: idToken }) };
    }
    assert.equal(url, 'https://chatgpt.com/backend-api/wham/usage');
    return { status: 200, headers: new Headers({ 'content-type': 'application/json' }), text: async () => JSON.stringify(FIXTURE) };
  };
  const { partial, newFields } = await fetchCodexDirect({ accessToken: 'old', refreshToken: 'rt', expiresAt: Date.now() - 1000, accountId: 'acc_9' });
  assert.equal(partial.plan, 'plus');
  assert.equal(partial.source, 'live');
  assert.equal(partial.error, null);
  assert.equal(partial.windows.length, 2);
  assert.ok(newFields, '续期后应返回新凭证字段');
  assert.equal(newFields.accessToken, 'at2');
});

test('codex-direct: fetchCodexDirect 未过期不刷新，newFields 为 null', async () => {
  global.fetch = async (url) => {
    assert.equal(url, 'https://chatgpt.com/backend-api/wham/usage');
    return { status: 200, headers: new Headers({ 'content-type': 'application/json' }), text: async () => JSON.stringify(FIXTURE) };
  };
  const { partial, newFields } = await fetchCodexDirect({ accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000, accountId: 'acc_9' });
  assert.equal(partial.plan, 'plus');
  assert.equal(newFields, null);
});

test('codex-direct: fetchCodexDirect 缺凭证直接报未登录', async () => {
  await assert.rejects(() => fetchCodexDirect({}), (e) => e.kind === 'auth_expired');
});
