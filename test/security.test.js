// 安全验收专项：SSRF 白名单、模型请求端点禁入、审计脱敏（node:test，不联网——executeAdapter 在校验失败时于 fetch 前抛错）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeAdapter, QuotaError } from '../src/standalone/providers/http.js';
import { listProviderMeta, getAdapter } from '../src/standalone/providers/index.js';

// 所有 adapter 允许命中的 host 全集（代码固定白名单）
const ALLOWED_HOSTS = new Set([
  '127.0.0.1:8317', // 本机 CPA 管理口（http 特例）
  'host.docker.internal:8317', // 容器部署时 CPA 管理口走 docker 网关（http 特例，CPA_MGMT_URL 固定）
  'api.kimi.com',
  'chatgpt.com',
  'ollama.com',
  'api.commandcode.ai',
  'api.z.ai',
  'open.bigmodel.cn',
  'opencode.ai',
  'api.deepseek.com',
]);
// 会产生模型用量的路径特征，任何 adapter 不得声明
const FORBIDDEN_PATHS = [
  '/chat/completions',
  '/messages',
  '/responses',
  '/provider/v1/chat/completions',
  '/provider/v1/messages',
  '/alpha/generate',
  '/usage-queue',
];
// host '*' 仅允许用于自建实例适配器，路径必须精确固定、方法只能 GET
const WILDCARD_HOST_PATHS = { sub2api: '/v1/usage', newapi: '/api/user/self' };

test('白名单：全部已注册 adapter 的 host/path 均在固定集合内', async () => {
  const meta = await listProviderMeta();
  const ids = meta.map((m) => m.id);
  for (const id of ['codex', 'codex-direct', 'ollama', 'command-code', 'kimi']) {
    assert.ok(ids.includes(id), `${id}: adapter 未加载`);
  }
  for (const id of ids) {
    const adapter = await getAdapter(id);
    assert.ok(Array.isArray(adapter.allowed) && adapter.allowed.length > 0, `${id}: 无 allowed 声明`);
    for (const a of adapter.allowed) {
      if (a.host === '*') {
        assert.ok(id in WILDCARD_HOST_PATHS, `${id}: host '*' 仅限自建实例适配器`);
        assert.equal(a.method, 'GET', `${id}: 通配 host 只允许 GET`);
        assert.equal(a.pathPrefix, WILDCARD_HOST_PATHS[id], `${id}: 通配 host 路径必须固定`);
        continue;
      }
      assert.ok(ALLOWED_HOSTS.has(a.host), `${id}: host 不在白名单 ${a.host}`);
      assert.ok(['GET', 'POST'].includes(a.method), `${id}: 方法 ${a.method}`);
      for (const bad of FORBIDDEN_PATHS) {
        assert.ok(!a.pathPrefix.includes(bad), `${id}: 声明了模型用量路径 ${a.pathPrefix}`);
      }
    }
  }
});

test('SSRF：buildRequest 返回非白名单 URL 时在 fetch 前被拒绝', async () => {
  const evil = (url, method = 'GET') => ({
    id: 'evil',
    allowed: [{ method: 'GET', host: 'api.kimi.com', pathPrefix: '/coding/v1/usages' }],
    buildRequest: () => ({ method, url, headers: {} }),
    parseResponse: () => ({}),
  });
  // 未声明的 host
  await assert.rejects(() => executeAdapter(evil('https://evil.example.com/x'), {}), (e) => e.kind === 'unavailable');
  // 已声明 host 但未声明的路径
  await assert.rejects(() => executeAdapter(evil('https://api.kimi.com/v1/chat/completions'), {}), (e) => e.kind === 'unavailable');
  // 方法不匹配（声明 GET 却发 POST）
  await assert.rejects(() => executeAdapter(evil('https://api.kimi.com/coding/v1/usages', 'POST'), {}), (e) => e.kind === 'unavailable');
  // 非 https（非 http 特例）
  await assert.rejects(() => executeAdapter(evil('http://api.kimi.com/coding/v1/usages'), {}), (e) => e.kind === 'unavailable');
  // http 特例只放行 127.0.0.1:8317 / host.docker.internal:8317，且仍须命中 adapter 自身白名单
  await assert.rejects(() => executeAdapter(evil('http://169.254.169.254/latest/meta-data'), {}), (e) => e.kind === 'unavailable');
  await assert.rejects(() => executeAdapter(evil('http://host.docker.internal:8317/v0/management/auth-files'), {}), (e) => e.kind === 'unavailable');
});

test('HTTP fetch：禁止跟随重定向，extra 白名单违规不降级', async () => {
  let redirectedHits = 0;
  let undeclaredExtraHits = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/allowed-redirect') {
      res.writeHead(302, { location: '/redirect-target' });
      res.end();
    } else if (req.url === '/redirect-target') {
      redirectedHits += 1;
      res.end('redirected');
    } else if (req.url === '/main' || req.url === '/extra') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    } else if (req.url === '/undeclared-extra') {
      undeclaredExtraHits += 1;
      res.end('must not be reached');
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, 'localhost', resolve);
  });
  try {
    const host = `localhost:${server.address().port}`;
    const url = (path) => `http://${host}${path}`;
    const redirectAdapter = {
      id: 'redirect-test',
      allowed: [{ method: 'GET', host, pathPrefix: '/allowed-redirect' }],
      buildRequest: () => ({ method: 'GET', url: url('/allowed-redirect'), headers: {} }),
      parseResponse: () => ({}),
    };
    await assert.rejects(() => executeAdapter(redirectAdapter, {}), (e) => e instanceof QuotaError && e.kind === 'unavailable');
    assert.equal(redirectedHits, 0, '不应访问重定向到的未声明路径');

    const extraAdapter = {
      id: 'extra-test',
      allowed: [
        { method: 'GET', host, pathPrefix: '/main' },
        { method: 'GET', host, pathPrefix: '/extra' },
      ],
      buildRequest: () => ({ method: 'GET', url: url('/main'), headers: {} }),
      extraRequests: () => [
        { id: 'allowed-extra', method: 'GET', url: url('/extra'), headers: {} },
        { id: 'undeclared-extra', method: 'GET', url: url('/undeclared-extra'), headers: {} },
      ],
      parseResponse: () => ({}),
    };
    await assert.rejects(() => executeAdapter(extraAdapter, {}), (e) => e instanceof QuotaError && e.kind === 'unavailable');
    assert.equal(undeclaredExtraHits, 0, '白名单违规 extra 不应访问未声明路径');
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test('真实 adapter：buildRequest 产物均能通过自身白名单', async () => {
  const creds = { apiKey: 'sk-test-12345678abcd', managementKey: 'mgmt-12345678', instanceUrl: 'https://s2a.example.com', userId: '1', accessToken: 'token-12345678' };
  for (const id of [
    'kimi',
    'zai',
    'bigmodel',
    'opencode-go',
    'deepseek',
    'codex',
    'codex-direct',
    'ollama',
    'command-code',
    'sub2api',
    'newapi',
  ]) {
    const adapter = await getAdapter(id);
    const req = adapter.buildRequest(creds);
    const url = new URL(req.url);
    const hit = adapter.allowed.some(
      (a) =>
        a.method === req.method &&
        (a.host === '*' ? url.protocol === 'https:' && url.pathname === a.pathPrefix : a.host === url.host && url.pathname.startsWith(a.pathPrefix)),
    );
    assert.ok(hit, `${id}: buildRequest 产物未命中自身白名单`);
    for (const bad of FORBIDDEN_PATHS) assert.ok(!url.pathname.includes(bad), `${id}: 命中模型用量路径`);
  }
});
