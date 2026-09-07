// HTTP 服务测试：多用户注册/登录/session/CSRF/路径穿越/step-up/隔离性/用户管理/静态文件
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/server/store/index.js';
import { createServer } from '../src/server/http.js';

const FAST_KDF = { N: 2 ** 10, r: 8, p: 1 };
const PASSWORD = 'http-test-password';
const USER_PASSWORD = 'user-b-password';

let dataDir;
let webDist;
let store;
let server;
let base;
let recoveryCode;

before(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qd-data-'));
  webDist = await fs.mkdtemp(path.join(os.tmpdir(), 'qd-web-'));
  await fs.writeFile(path.join(webDist, 'index.html'), '<html>ok</html>');
  store = new Store(dataDir, { sessionTtlMs: 60_000, backoffBaseMs: 1 });
  const init = await store.init('admin', PASSWORD, FAST_KDF);
  recoveryCode = init.recoveryCode;
  store.unlocked.clear(); // 模拟服务启动锁定态
  server = createServer({ store, dataDir, webDist });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  await fs.rm(dataDir, { recursive: true, force: true });
  await fs.rm(webDist, { recursive: true, force: true });
});

const CSRF = { 'X-Requested-With': 'quota-dashboard' };

async function login(username = 'admin', password = PASSWORD) {
  return fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { ...CSRF, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
}

function cookieOf(res) {
  const sc = res.headers.get('set-cookie') ?? '';
  return sc.split(';')[0];
}

test('登录：错误密码 401，正确密码下发 session cookie 并解锁', async () => {
  const bad = await login('admin', 'wrong-password-0000');
  assert.equal(bad.status, 401);
  assert.equal((await bad.json()).error, 'invalid_credentials');

  const res = await login();
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.ok(body.expiresAt > Date.now());
  const sc = res.headers.get('set-cookie');
  assert.match(sc, /HttpOnly/);
  assert.match(sc, /Secure/);
  assert.match(sc, /SameSite=Strict/);
  assert.equal(store.isUnlocked('admin'), true);
});

test('auth/status 反映认证态并返回用户信息', async () => {
  const res = await login();
  const cookie = cookieOf(res);
  const st = await (await fetch(`${base}/api/auth/status`, { headers: { cookie } })).json();
  assert.equal(st.authenticated, true);
  assert.equal(st.initialized, true);
  assert.equal(st.user.username, 'admin');
  assert.equal(st.user.role, 'admin');
  assert.equal(st.user.totpEnabled, false);
  const anon = await (await fetch(`${base}/api/auth/status`)).json();
  assert.equal(anon.authenticated, false);
  assert.equal(anon.user, null);
});

test('session 过期后不再认证', async () => {
  const res = await login();
  const cookie = cookieOf(res);
  // 手动把该 session 过期
  store.sessions.forEach((s) => {
    s.expiresAt = Date.now() - 1;
  });
  const st = await (await fetch(`${base}/api/auth/status`, { headers: { cookie } })).json();
  assert.equal(st.authenticated, false);
  assert.equal(st.expiresAt, null);
});

test('session 滑动续期：剩余不足一半 TTL 时自动延长（keepalive 有效）', async () => {
  const cookie = cookieOf(await login());
  const s = store.sessions.filter((x) => x.usernameLower === 'admin').at(-1);
  s.expiresAt = Date.now() + store.sessionTtlMs / 4; // 剩余 25% < 50% 阈值
  const before = s.expiresAt;
  const st = await fetch(`${base}/api/auth/status`, { headers: { cookie } });
  assert.equal(st.status, 200);
  await new Promise((r) => setTimeout(r, 120)); // touch 是 fire-and-forget，等它落盘
  assert.ok(s.expiresAt > before + store.sessionTtlMs / 2, '应延长到接近完整 TTL');
  // 刚续过期，立刻再访问不应重复写（节流：剩余已超一半）
  const afterTouch = s.expiresAt;
  await fetch(`${base}/api/auth/status`, { headers: { cookie } });
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(s.expiresAt, afterTouch);
});

test('注册：校验用户名/密码，成功后可用新账号登录', async () => {
  const bad1 = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { ...CSRF, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'a', password: 'long-enough-password' }),
  });
  assert.equal(bad1.status, 400);
  assert.equal((await bad1.json()).error, 'invalid_username');

  const bad2 = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { ...CSRF, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'bob', password: 'short' }),
  });
  assert.equal(bad2.status, 400);
  assert.equal((await bad2.json()).error, 'weak_password');

  const ok = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { ...CSRF, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'bob', password: USER_PASSWORD }),
  });
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.match(body.recoveryCode, /^([0-9A-F]{4}-){7}[0-9A-F]{4}$/);

  // 大小写不敏感查重
  const dup = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { ...CSRF, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'BOB', password: 'another-password-1' }),
  });
  assert.equal(dup.status, 409);
  assert.equal((await dup.json()).error, 'username_taken');

  // 新账号可登录
  const res = await login('bob', USER_PASSWORD);
  assert.equal(res.status, 200);
});

test('隔离性：用户 B 看不到 admin 的凭证，互不影响', async () => {
  const adminCookie = cookieOf(await login('admin', PASSWORD));
  const bobCookie = cookieOf(await login('bob', USER_PASSWORD));

  // admin 加一条凭证
  const add = await fetch(`${base}/api/credentials`, {
    method: 'POST',
    headers: { ...CSRF, 'Content-Type': 'application/json', cookie: adminCookie },
    body: JSON.stringify({ provider: 'kimi', alias: 'admin-kimi', fields: { apiKey: 'sk-admin-secret-001' } }),
  });
  assert.equal(add.status, 200);

  // bob 的列表为空
  const bobList = await (await fetch(`${base}/api/credentials`, { headers: { cookie: bobCookie } })).json();
  assert.equal(bobList.length, 0);

  // bob 加自己的凭证
  const addB = await fetch(`${base}/api/credentials`, {
    method: 'POST',
    headers: { ...CSRF, 'Content-Type': 'application/json', cookie: bobCookie },
    body: JSON.stringify({ provider: 'kimi', alias: 'bob-kimi', fields: { apiKey: 'sk-bob-secret-002' } }),
  });
  assert.equal(addB.status, 200);

  // admin 列表不受 bob 影响
  const adminList = await (await fetch(`${base}/api/credentials`, { headers: { cookie: adminCookie } })).json();
  assert.equal(adminList.length, 1);
  assert.equal(adminList[0].alias, 'admin-kimi');
});

test('用户管理：非 admin 403；admin 可列表/禁用/启用/删除，禁用后登录 403', async () => {
  const bobCookie = cookieOf(await login('bob', USER_PASSWORD));
  const adminCookie = cookieOf(await login('admin', PASSWORD));

  const forbidden = await fetch(`${base}/api/users`, { headers: { cookie: bobCookie } });
  assert.equal(forbidden.status, 403);
  assert.equal((await forbidden.json()).error, 'forbidden');

  const list = await (await fetch(`${base}/api/users`, { headers: { cookie: adminCookie } })).json();
  assert.equal(list.users.length, 2);
  assert.deepEqual(Object.keys(list.users[0]).sort(), ['createdAt', 'lastLoginAt', 'role', 'status', 'username']);

  // 不能操作自己
  const self = await fetch(`${base}/api/users/admin/disable`, {
    method: 'POST',
    headers: { ...CSRF, cookie: adminCookie },
  });
  assert.equal(self.status, 400);

  // 禁用 bob
  const dis = await fetch(`${base}/api/users/bob/disable`, {
    method: 'POST',
    headers: { ...CSRF, cookie: adminCookie },
  });
  assert.equal(dis.status, 200);

  // bob 的 session 被吊销，且无法再登录
  const bobQuota = await fetch(`${base}/api/quota`, { headers: { cookie: bobCookie } });
  assert.equal(bobQuota.status, 401);
  const bobLogin = await login('bob', USER_PASSWORD);
  assert.equal(bobLogin.status, 403);
  assert.equal((await bobLogin.json()).error, 'account_disabled');

  // 重新启用后可登录
  const en = await fetch(`${base}/api/users/bob/enable`, {
    method: 'POST',
    headers: { ...CSRF, cookie: adminCookie },
  });
  assert.equal(en.status, 200);
  assert.equal((await login('bob', USER_PASSWORD)).status, 200);
});

test('TOTP 可选：开启后 step-up 需要验证码，关闭后只需密码', async () => {
  const bobCookie = cookieOf(await login('bob', USER_PASSWORD));
  const H = { ...CSRF, 'Content-Type': 'application/json', cookie: bobCookie };

  // 未开启 TOTP：导出只需密码
  const exp = await fetch(`${base}/api/export`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ password: USER_PASSWORD, exportPassword: 'export-pw-1234' }),
  });
  assert.equal(exp.status, 200);

  // 开启：begin（错误密码 401）→ confirm
  const badBegin = await fetch(`${base}/api/auth/totp/begin`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ password: 'wrong-password-xx' }),
  });
  assert.equal(badBegin.status, 401);
  const begin = await fetch(`${base}/api/auth/totp/begin`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ password: USER_PASSWORD }),
  });
  assert.equal(begin.status, 200);
  const { totpSecret } = await begin.json();
  assert.ok(totpSecret);

  const { base32Decode, totpCode } = await import('../src/server/crypto/index.js');
  const code = totpCode(base32Decode(totpSecret), Date.now());
  const confirm = await fetch(`${base}/api/auth/totp/confirm`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ code }),
  });
  assert.equal(confirm.status, 200);

  // 开启后只给密码 → 401
  const noTotp = await fetch(`${base}/api/export`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ password: USER_PASSWORD, exportPassword: 'export-pw-1234' }),
  });
  assert.equal(noTotp.status, 401);
  assert.equal((await noTotp.json()).error, 'step_up_failed');

  // 密码 + 验证码 → 200
  const withTotp = await fetch(`${base}/api/export`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({
      password: USER_PASSWORD,
      totp: totpCode(base32Decode(totpSecret), Date.now()),
      exportPassword: 'export-pw-1234',
    }),
  });
  assert.equal(withTotp.status, 200);

  // 关闭（只需密码）
  const disable = await fetch(`${base}/api/auth/totp/disable`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ password: USER_PASSWORD }),
  });
  assert.equal(disable.status, 200);
  const exp2 = await fetch(`${base}/api/export`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ password: USER_PASSWORD, exportPassword: 'export-pw-1234' }),
  });
  assert.equal(exp2.status, 200);
});

test('删除用户：数据与 session 一并清除', async () => {
  const adminCookie = cookieOf(await login('admin', PASSWORD));
  const del = await fetch(`${base}/api/users/bob`, {
    method: 'DELETE',
    headers: { ...CSRF, cookie: adminCookie },
  });
  assert.equal(del.status, 200);
  assert.equal(store.userByName('bob'), null);
  assert.ok(!store.sessions.some((s) => s.usernameLower === 'bob'));
  assert.equal((await login('bob', USER_PASSWORD)).status, 401);
});

test('CSRF：写操作缺 X-Requested-With 头被拒绝', async () => {
  const res = await fetch(`${base}/api/auth/logout`, { method: 'POST' });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, 'csrf_failed');
  const ok = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: CSRF });
  assert.equal(ok.status, 200);
});

test('CSRF：跨源 Origin 被拒绝，同源放行', async () => {
  const url = new URL(base);
  const evil = await fetch(`${base}/api/auth/logout`, {
    method: 'POST',
    headers: { ...CSRF, Origin: 'https://evil.example.com' },
  });
  assert.equal(evil.status, 403);
  const same = await fetch(`${base}/api/auth/logout`, {
    method: 'POST',
    headers: { ...CSRF, Origin: `http://${url.host}` },
  });
  assert.equal(same.status, 200);
});

test('未认证访问受保护端点 401', async () => {
  const res = await fetch(`${base}/api/quota`);
  assert.equal(res.status, 401);
  const res2 = await fetch(`${base}/api/credentials`);
  assert.equal(res2.status, 401);
});

test('凭证增删改：仅需登录态（无需 password/totp）；密钥完全不回传（无 reveal 端点、列表无密钥材料）', async () => {
  const cookie = cookieOf(await login());
  // 添加：不带 password/totp 也应成功
  const add = await fetch(`${base}/api/credentials`, {
    method: 'POST',
    headers: { ...CSRF, 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ provider: 'kimi', alias: 'x', fields: { apiKey: 'sk-test-12345678' } }),
  });
  assert.equal(add.status, 200);
  const { id } = await add.json();
  assert.ok(id);
  // reveal 端点已移除：任何请求一律 404（路由不存在，密钥明文无从取出）
  const gone = await fetch(`${base}/api/credentials/${id}/reveal`, {
    method: 'POST',
    headers: { ...CSRF, 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ password: 'bad', totp: '000000' }),
  });
  assert.equal(gone.status, 404);
  // 列表不回传任何密钥材料（连脱敏片段也没有）
  const list = await (await fetch(`${base}/api/credentials`, { headers: { cookie } })).json();
  const item = list.find((c) => c.id === id);
  assert.ok(item);
  const raw = JSON.stringify(item);
  assert.ok(!raw.includes('sk-test'), '列表泄露密钥片段');
  assert.ok(!('maskedIdentity' in item), '列表仍携带 maskedIdentity');
  // 删除：无需 step-up
  const del = await fetch(`${base}/api/credentials/${id}`, {
    method: 'DELETE',
    headers: { ...CSRF, 'Content-Type': 'application/json', cookie },
    body: '{}',
  });
  assert.equal(del.status, 200);
});

test('codex 凭证不产生额度卡片（卡片只来自已勾选的 codexAccounts）', async () => {
  const cookie = cookieOf(await login());
  const add = await fetch(`${base}/api/credentials`, {
    method: 'POST',
    headers: { ...CSRF, 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ provider: 'codex', fields: { mgmtUrl: 'http://127.0.0.1:8317', managementKey: 'mgmt-test-key' } }),
  });
  assert.equal(add.status, 200);
  const { id } = await add.json();
  const quota = await (await fetch(`${base}/api/quota`, { headers: { cookie } })).json();
  assert.ok(!quota.accounts.some((a) => a.accountId === id), 'codex 凭证本身不应出现在 quota 账号里');
  await fetch(`${base}/api/credentials/${id}`, {
    method: 'DELETE',
    headers: { ...CSRF, 'Content-Type': 'application/json', cookie },
    body: '{}',
  });
});

test('codex-direct 禁用手动添加凭证（仅能走 OAuth 登录）', async () => {
  const cookie = cookieOf(await login());
  const add = await fetch(`${base}/api/credentials`, {
    method: 'POST',
    headers: { ...CSRF, 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ provider: 'codex-direct', fields: { accessToken: 'sk-test', accountId: 'acc' } }),
  });
  assert.equal(add.status, 400);
  assert.equal((await add.json()).error, 'invalid_fields');
});

test('codex-direct login：未认证 401；无 CSRF 403；成功返回设备码；status 轮询 pending→complete 并创建凭证', async () => {
  // 未认证
  const anon = await fetch(`${base}/api/codex-direct/login`, { method: 'POST', headers: CSRF });
  assert.equal(anon.status, 401);

  const cookie = cookieOf(await login());

  // 无 CSRF → 403
  const noCsrf = await fetch(`${base}/api/codex-direct/login`, { method: 'POST' });
  assert.equal(noCsrf.status, 403);
  assert.equal((await noCsrf.json()).error, 'csrf_failed');

  // 注入假 fetch 以驱动 device-flow；本机 server 请求放行到真实网络
  const origFetch = global.fetch;
  let tokenCalls = 0;
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (!u.includes('auth.openai.com') && !u.includes('chatgpt.com')) {
      return origFetch(url, opts);
    }
    if (u.includes('/usercode')) {
      return { status: 200, headers: new Headers({ 'content-type': 'application/json' }), text: async () => JSON.stringify({ device_auth_id: 'dev1', user_code: 'AB-CD', interval: 1 }) };
    }
    if (u.includes('/deviceauth/token')) {
      tokenCalls += 1;
      if (tokenCalls === 1) return { status: 403, headers: new Headers({ 'content-type': 'application/json' }), text: async () => '' };
      const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
      const idToken = `${b64({})}.${b64({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acc_9' } })}.sig`;
      return { status: 200, headers: new Headers({ 'content-type': 'application/json' }), text: async () => JSON.stringify({ authorization_code: 'code1', code_verifier: 'v1' }) };
    }
    if (u.includes('/oauth/token')) {
      const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
      const idToken = `${b64({})}.${b64({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acc_9' } })}.sig`;
      return { status: 200, headers: new Headers({ 'content-type': 'application/json' }), text: async () => JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, id_token: idToken }) };
    }
    throw new Error(`unexpected url ${u}`);
  };

  try {
    // 发起登录
    const start = await fetch(`${base}/api/codex-direct/login`, { method: 'POST', headers: { ...CSRF, cookie } });
    assert.equal(start.status, 200);
    const s = await start.json();
    assert.equal(s.userCode, 'AB-CD');
    assert.equal(s.verificationUrl, 'https://auth.openai.com/codex/device');
    assert.equal(s.intervalSeconds, 1);
    assert.ok(s.loginToken);

    // 第一次轮询：pending
    const pending = await fetch(`${base}/api/codex-direct/login/status?loginToken=${encodeURIComponent(s.loginToken)}`, { headers: { cookie } });
    assert.equal(pending.status, 200);
    assert.equal((await pending.json()).status, 'pending');

    // 第二次轮询：complete 并创建凭证
    const done = await fetch(`${base}/api/codex-direct/login/status?loginToken=${encodeURIComponent(s.loginToken)}`, { headers: { cookie } });
    assert.equal(done.status, 200);
    const db = await done.json();
    assert.equal(db.status, 'complete');
    assert.ok(db.credentialId);

    // 凭证已存在且 codex-direct 卡片出现在 quota 里
    const list = await (await fetch(`${base}/api/credentials`, { headers: { cookie } })).json();
    const cred = list.find((c) => c.id === db.credentialId);
    assert.ok(cred);
    assert.equal(cred.provider, 'codex-direct');
    const raw = JSON.stringify(cred);
    assert.ok(!raw.includes('access_token')); // 不泄露 token
  } finally {
    global.fetch = origFetch;
  }
});

test('路径穿越被拒绝（含编码变体，一律 404）', async () => {
  // undici fetch 会客户端规范化点段，这里用原生 http 按原样发送路径
  const u = new URL(base);
  const rawGet = (p) =>
    new Promise((resolve, reject) => {
      const req = http.request({ hostname: u.hostname, port: u.port, path: p, method: 'GET' }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      });
      req.on('error', reject);
      req.end();
    });
  for (const p of [
    '/../CONTRACT.md',
    '/%2e%2e/CONTRACT.md',
    '/%2e%2e%2fCONTRACT.md',
    '/..%2f..%2fpackage.json',
    '/%2e%2e/%2e%2e/etc/passwd',
    '/assets/../../etc/passwd',
  ]) {
    const res = await rawGet(p);
    assert.equal(res.status, 404, p);
    assert.ok(!res.body.includes('<html>ok</html>'), p);
  }
});

test('静态文件：index.html 与 SPA 回退', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<html>ok<\/html>/);
  const spa = await fetch(`${base}/some/route`);
  assert.equal(spa.status, 200);
  // 安全头
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
});

test('JSON body 超 64KB 拒绝', async () => {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { ...CSRF, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'x'.repeat(70 * 1024) }),
  });
  assert.equal(res.status, 413);
});

test('恢复流程：用户名+恢复码换一次性 token，complete 重置密码并下发新恢复码', async () => {
  const bad = await fetch(`${base}/api/auth/recover`, {
    method: 'POST',
    headers: { ...CSRF, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', recoveryCode: 'AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-0000-1111' }),
  });
  assert.equal(bad.status, 401);
  assert.equal((await bad.json()).error, 'invalid_recovery_code');

  const res = await fetch(`${base}/api/auth/recover`, {
    method: 'POST',
    headers: { ...CSRF, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', recoveryCode }),
  });
  assert.equal(res.status, 200);
  const { recoveryToken } = await res.json();
  assert.ok(recoveryToken);

  const done = await fetch(`${base}/api/auth/recover/complete`, {
    method: 'POST',
    headers: { ...CSRF, 'Content-Type': 'application/json' },
    body: JSON.stringify({ recoveryToken, newPassword: 'recovered-password' }),
  });
  assert.equal(done.status, 200);
  const body = await done.json();
  assert.match(body.newRecoveryCode, /^([0-9A-F]{4}-){7}[0-9A-F]{4}$/);

  // recovery token 一次性
  const reuse = await fetch(`${base}/api/auth/recover/complete`, {
    method: 'POST',
    headers: { ...CSRF, 'Content-Type': 'application/json' },
    body: JSON.stringify({ recoveryToken, newPassword: 'another-password' }),
  });
  assert.equal(reuse.status, 401);

  // 旧密码失效，新密码可登录
  assert.equal((await login('admin', PASSWORD)).status, 401);
  assert.equal((await login('admin', 'recovered-password')).status, 200);
});

test('审计日志已落盘且不含敏感串', async () => {
  const files = (await fs.readdir(dataDir)).filter((n) => /^audit-\d{8}\.log$/.test(n));
  assert.ok(files.length >= 1);
  const content = await fs.readFile(path.join(dataDir, files[0]), 'utf8');
  assert.ok(content.includes('login_success'));
  assert.ok(!content.includes(PASSWORD));
  assert.ok(!content.includes(USER_PASSWORD));
});

test('store.enc 原子写且为 v2 多用户结构', async () => {
  const doc = JSON.parse(await fs.readFile(path.join(dataDir, 'store.enc'), 'utf8'));
  assert.equal(doc.v, 2);
  assert.ok(Array.isArray(doc.users));
  assert.ok(Array.isArray(doc.sessions));
  const admin = doc.users.find((u) => u.usernameLower === 'admin');
  assert.ok(admin);
  assert.equal(admin.role, 'admin');
  assert.equal(admin.envelope.v, 1);
  assert.equal(admin.envelope.kdf.algo, 'scrypt');
  assert.ok(admin.envelope.dek.wrappedByMaster.iv && admin.envelope.dek.wrappedByMaster.ct);
  assert.ok(admin.envelope.dek.wrappedByRecovery.salt2);
  assert.ok(admin.envelope.payload.ct);
  const raw = JSON.stringify(doc);
  assert.ok(!raw.includes(PASSWORD));
  assert.ok(!raw.includes('recovered-password'));
});

test('v1 单用户 store 自动迁移为 v2 并留备份', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qd-migrate-'));
  try {
    // 手工构造 v1 信封
    const { createEnvelope } = await import('../src/server/crypto/index.js');
    const { envelope } = await createEnvelope('migrate-password', undefined, FAST_KDF);
    await fs.writeFile(path.join(dir, 'store.enc'), JSON.stringify(envelope), { mode: 0o600 });

    const s2 = new Store(dir, { sessionTtlMs: 60_000 });
    await s2.load();
    assert.equal(s2.initialized, true);
    assert.equal(s2.userByName('admin')?.role, 'admin');
    // 备份文件存在
    const bak = JSON.parse(await fs.readFile(path.join(dir, 'store.enc.v1.bak'), 'utf8'));
    assert.equal(bak.v, 1);
    // 迁移后可正常解锁
    assert.equal(await s2.unlockWithPassword('admin', 'migrate-password'), true);
    // 落盘为 v2
    const doc = JSON.parse(await fs.readFile(path.join(dir, 'store.enc'), 'utf8'));
    assert.equal(doc.v, 2);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
