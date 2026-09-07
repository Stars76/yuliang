// 备份导入测试：导出→导入闭环、step-up 要求、错误导出密码、格式错误、sessions 不导入
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/server/store/index.js';
import { createServer } from '../src/server/http.js';

const FAST_KDF = { N: 2 ** 10, r: 8, p: 1 };
const PASSWORD = 'import-test-password';
const EXPORT_PW = 'import-test-export-pw';

let dataDir;
let webDist;
let store;
let server;
let base;
let cookie;

before(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qd-import-data-'));
  webDist = await fs.mkdtemp(path.join(os.tmpdir(), 'qd-import-web-'));
  await fs.writeFile(path.join(webDist, 'index.html'), '<html>ok</html>');
  store = new Store(dataDir, { sessionTtlMs: 60_000, backoffBaseMs: 1 });
  await store.init('admin', PASSWORD, FAST_KDF);
  store.unlocked.clear(); // 模拟服务启动锁定态
  server = createServer({ store, dataDir, webDist });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { ...CSRF, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: PASSWORD }),
  });
  assert.equal(res.status, 200);
  cookie = res.headers.get('set-cookie').split(';')[0];
});

after(async () => {
  server.close();
  await fs.rm(dataDir, { recursive: true, force: true });
  await fs.rm(webDist, { recursive: true, force: true });
});

const CSRF = { 'X-Requested-With': 'quota-dashboard' };
const JSON_HEADERS = { ...CSRF, 'Content-Type': 'application/json' };

const payload = () => store.entry('admin').payload;

async function postImport(body) {
  return fetch(`${base}/api/import`, {
    method: 'POST',
    headers: { ...JSON_HEADERS, cookie },
    body: JSON.stringify(body),
  });
}

// 未开启 TOTP：step-up 只验密码
async function exportBackup() {
  const res = await fetch(`${base}/api/export`, {
    method: 'POST',
    headers: { ...JSON_HEADERS, cookie },
    body: JSON.stringify({ password: PASSWORD, exportPassword: EXPORT_PW }),
  });
  assert.equal(res.status, 200);
  return res.text();
}

async function seedCredentials() {
  const add = (provider, fields) =>
    fetch(`${base}/api/credentials`, {
      method: 'POST',
      headers: { ...JSON_HEADERS, cookie },
      body: JSON.stringify({ provider, alias: `t-${provider}`, fields }),
    });
  assert.equal((await add('kimi', { apiKey: 'sk-fake-kimi-0001' })).status, 200);
  assert.equal((await add('deepseek', { apiKey: 'sk-fake-deepseek-0002' })).status, 200);
  payload().codexAccounts = [
    { credId: 'cred-fake', authIndex: '0', maskedEmail: 'a***@example.com', alias: 'fake-codex' },
  ];
  await store.save();
}

test('导入：缺 step-up 401 step_up_failed；缺 CSRF 403', async () => {
  const res = await postImport({ exportPassword: EXPORT_PW, backup: '{}' });
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error, 'step_up_failed');

  const noCsrf = await fetch(`${base}/api/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ password: PASSWORD, exportPassword: EXPORT_PW, backup: '{}' }),
  });
  assert.equal(noCsrf.status, 403);
  assert.equal((await noCsrf.json()).error, 'csrf_failed');
});

test('导入：错误导出密码与坏备份统一 400 invalid_backup', async () => {
  await seedCredentials();
  const backup = await exportBackup();

  const wrongPw = await postImport({
    password: PASSWORD,
    exportPassword: 'wrong-export-password',
    backup,
  });
  assert.equal(wrongPw.status, 400);
  assert.equal((await wrongPw.json()).error, 'invalid_backup');

  const garbage = await postImport({
    password: PASSWORD,
    exportPassword: EXPORT_PW,
    backup: 'not-a-backup-at-all',
  });
  assert.equal(garbage.status, 400);
  assert.equal((await garbage.json()).error, 'invalid_backup');

  // 失败导入不得改动现有数据
  assert.equal(payload().credentials.length, 2);
  assert.equal(payload().codexAccounts.length, 1);
});

test('导入：正确 step-up + 导出密码后覆盖 credentials/codexAccounts，sessions 不导入', async () => {
  assert.equal(payload().credentials.length, 2);
  const backup = await exportBackup();

  // 清空当前数据（模拟迁机/误删），sessions 保持不变
  payload().credentials = [];
  payload().codexAccounts = [];
  await store.save();

  const res = await postImport({ password: PASSWORD, exportPassword: EXPORT_PW, backup });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.imported, { credentials: 2, codexAccounts: 1 });
  assert.equal(payload().credentials.length, 2);
  assert.equal(payload().codexAccounts.length, 1);
  assert.ok(payload().credentials.every((c) => c.alias?.startsWith('t-')));

  // 当前 session 仍然有效（sessions 未被备份内容覆盖）
  const st = await (await fetch(`${base}/api/auth/status`, { headers: { cookie } })).json();
  assert.equal(st.authenticated, true);
});

test('导入：接受 base64 编码的备份内容', async () => {
  const backup = await exportBackup();
  payload().credentials = [];
  payload().codexAccounts = [];
  await store.save();
  const res = await postImport({
    password: PASSWORD,
    exportPassword: EXPORT_PW,
    backup: Buffer.from(backup, 'utf8').toString('base64'),
  });
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).imported, { credentials: 2, codexAccounts: 1 });
});

test('导入后审计记录 credential_import 且只含条目数与用户名', async () => {
  const files = (await fs.readdir(dataDir)).filter((n) => /^audit-\d{8}\.log$/.test(n));
  assert.ok(files.length >= 1);
  const content = await fs.readFile(path.join(dataDir, files[0]), 'utf8');
  const line = content.trim().split('\n').find((l) => l.includes('credential_import'));
  assert.ok(line);
  const entry = JSON.parse(line);
  assert.deepEqual(Object.keys(entry.details).sort(), ['codexAccounts', 'credentials', 'username']);
  assert.ok(!content.includes('sk-fake'));
});
