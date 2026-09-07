// 加密核心测试：信封往返、错误密码、GCM 篡改、恢复码、TOTP RFC6238 已知向量、导出备份
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createEnvelope,
  openEnvelopeWithPassword,
  openEnvelopeWithRecovery,
  createExportEnvelope,
  openExportEnvelope,
  rewrapMaster,
  totpCode,
  verifyTotp,
  generateTotpSecret,
  normalizeRecoveryCode,
} from '../src/server/crypto/index.js';

const FAST_KDF = { N: 2 ** 10, r: 8, p: 1 };
const PASSWORD = 'test-master-password-1234';

function samplePayload() {
  return {
    credentials: [{ id: 'c1', provider: 'kimi', alias: '主号', fields: { apiKey: 'sk-test' }, createdAt: 1 }],
    codexAccounts: [],
    settings: {},
    sessions: [],
    totp: null,
    lockout: { fails: 0, nextAllowedAt: 0, lockedUntil: 0 },
  };
}

test('信封加解密往返', async () => {
  const payload = samplePayload();
  const { envelope } = await createEnvelope(PASSWORD, payload, FAST_KDF);
  const { payload: opened } = await openEnvelopeWithPassword(envelope, PASSWORD);
  assert.deepEqual(opened, payload);
});

test('错误密码解不开', async () => {
  const { envelope } = await createEnvelope(PASSWORD, samplePayload(), FAST_KDF);
  await assert.rejects(openEnvelopeWithPassword(envelope, 'wrong-password-xxxx'));
});

test('篡改 payload 密文导致 GCM 校验失败', async () => {
  const { envelope } = await createEnvelope(PASSWORD, samplePayload(), FAST_KDF);
  const tampered = structuredClone(envelope);
  const ct = Buffer.from(tampered.payload.ct, 'base64');
  ct[0] ^= 0xff;
  tampered.payload.ct = ct.toString('base64');
  await assert.rejects(openEnvelopeWithPassword(tampered, PASSWORD));
});

test('篡改 DEK 包装密文导致 GCM 校验失败', async () => {
  const { envelope } = await createEnvelope(PASSWORD, samplePayload(), FAST_KDF);
  const tampered = structuredClone(envelope);
  const ct = Buffer.from(tampered.dek.wrappedByMaster.ct, 'base64');
  ct[0] ^= 0xff;
  tampered.dek.wrappedByMaster.ct = ct.toString('base64');
  await assert.rejects(openEnvelopeWithPassword(tampered, PASSWORD));
});

test('恢复码可解出同一 DEK 与 payload（含 normalize）', async () => {
  const payload = samplePayload();
  const { envelope, recoveryCode, dek } = await createEnvelope(PASSWORD, payload, FAST_KDF);
  const r = await openEnvelopeWithRecovery(envelope, recoveryCode);
  assert.deepEqual(r.payload, payload);
  assert.equal(r.dek.toString('hex'), dek.toString('hex'));
  // normalize：小写 + 去分隔符也能解
  const messy = recoveryCode.toLowerCase().replaceAll('-', ' ');
  const r2 = await openEnvelopeWithRecovery(envelope, normalizeRecoveryCode(messy));
  assert.equal(r2.dek.toString('hex'), dek.toString('hex'));
});

test('错误恢复码失败', async () => {
  const { envelope } = await createEnvelope(PASSWORD, samplePayload(), FAST_KDF);
  await assert.rejects(openEnvelopeWithRecovery(envelope, 'AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-0000-1111'));
});

test('换主密码后旧密码失效、新密码可解、恢复码仍有效', async () => {
  const payload = samplePayload();
  const { envelope, recoveryCode, dek } = await createEnvelope(PASSWORD, payload, FAST_KDF);
  const newEnv = await rewrapMaster(envelope, dek, 'new-master-password-5678', FAST_KDF);
  await assert.rejects(openEnvelopeWithPassword(newEnv, PASSWORD));
  const r = await openEnvelopeWithPassword(newEnv, 'new-master-password-5678');
  assert.deepEqual(r.payload, payload);
  const r2 = await openEnvelopeWithRecovery(newEnv, recoveryCode);
  assert.equal(r2.dek.toString('hex'), dek.toString('hex'));
});

test('TOTP RFC6238 SHA-1 已知向量（8 位）', () => {
  const secret = Buffer.from('12345678901234567890', 'ascii');
  const vectors = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ];
  for (const [t, expected] of vectors) {
    assert.equal(totpCode(secret, t * 1000, { digits: 8 }), expected, `T=${t}`);
  }
});

test('TOTP 6 位 ±1 窗口验证', () => {
  const { raw } = generateTotpSecret();
  const now = Date.now();
  const code = totpCode(raw, now);
  assert.match(code, /^\d{6}$/);
  assert.equal(verifyTotp(raw, code, now), true);
  assert.equal(verifyTotp(raw, totpCode(raw, now - 30_000), now), true); // 上一窗口
  assert.equal(verifyTotp(raw, totpCode(raw, now + 30_000), now), true); // 下一窗口
  assert.equal(verifyTotp(raw, totpCode(raw, now + 90_000), now), false); // 超出窗口
  assert.equal(verifyTotp(raw, 'abcdef', now), false);
});

test('导出备份：导出密码可解，主密码/错误导出密码不可解', async () => {
  const payload = samplePayload();
  const { envelope, dek } = await createEnvelope(PASSWORD, payload, FAST_KDF);
  const exportEnv = await createExportEnvelope(envelope, dek, 'export-pw-123', FAST_KDF);
  assert.ok(exportEnv.dek.wrappedByExport);
  const r = await openExportEnvelope(exportEnv, 'export-pw-123');
  assert.deepEqual(r.payload, payload);
  assert.equal(r.dek.toString('hex'), dek.toString('hex'));
  await assert.rejects(openExportEnvelope(exportEnv, 'wrong-export-pw'));
  await assert.rejects(openExportEnvelope(exportEnv, PASSWORD));
});
