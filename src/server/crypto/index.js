// 加密核心：scrypt KEK 派生（校准 200-300ms）、AES-256-GCM、信封格式、TOTP、恢复码
import {
  scrypt,
  randomBytes,
  createCipheriv,
  createDecipheriv,
  createHmac,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);

const KEY_LEN = 32;
const IV_LEN = 12;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const MAXMEM = 512 * 1024 * 1024;
const MIN_N_EXP = 14;
const MAX_N_EXP = 17;

// 实测 N=2^14 耗时，按 250ms 目标缩放到 2 的幂（Node 要求 N 为 2 的幂）
export async function calibrateKdf(targetMs = 270) {
  const probe = { N: 2 ** MIN_N_EXP, r: SCRYPT_R, p: SCRYPT_P };
  const t0 = performance.now();
  await scryptAsync('kdf-calibration-probe', randomBytes(16), KEY_LEN, { ...probe, maxmem: MAXMEM });
  const elapsed = Math.max(performance.now() - t0, 1);
  const exp = Math.round(MIN_N_EXP + Math.log2(targetMs / elapsed));
  const clamped = Math.min(MAX_N_EXP, Math.max(MIN_N_EXP, exp));
  return { N: 2 ** clamped, r: SCRYPT_R, p: SCRYPT_P };
}

export function deriveKek(secret, saltB64, { N, r, p }) {
  return scryptAsync(String(secret), Buffer.from(saltB64, 'base64'), KEY_LEN, { N, r, p, maxmem: MAXMEM });
}

export function aesGcmEncrypt(key, plaintext) {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(String(plaintext), 'utf8');
  const ct = Buffer.concat([cipher.update(data), cipher.final()]);
  return { iv: iv.toString('base64'), ct: ct.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
}

export function aesGcmDecrypt(key, { iv, ct, tag }) {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]);
}

export function generateRecoveryCode() {
  const hex = randomBytes(16).toString('hex').toUpperCase();
  return hex.match(/.{4}/g).join('-');
}

export function normalizeRecoveryCode(code) {
  return String(code ?? '').toUpperCase().replace(/[^0-9A-F]/g, '');
}

function emptyPayload() {
  return {
    credentials: [],
    codexAccounts: [],
    settings: {},
    sessions: [],
    totp: null,
    lockout: { fails: 0, nextAllowedAt: 0, lockedUntil: 0 },
  };
}

// 新建信封：主密码包装 DEK + 恢复码独立包装（salt2）DEK + DEK 加密 payload
export async function createEnvelope(password, payload = emptyPayload(), kdfParams) {
  const params = kdfParams ?? (await calibrateKdf());
  const salt = randomBytes(16).toString('base64');
  const kek = await deriveKek(password, salt, params);
  const dek = randomBytes(KEY_LEN);
  const recoveryCode = generateRecoveryCode();
  const envelope = {
    v: 1,
    kdf: { algo: 'scrypt', N: params.N, r: params.r, p: params.p, salt },
    dek: {
      wrappedByMaster: aesGcmEncrypt(kek, dek),
      wrappedByRecovery: await wrapDekWithRecovery(dek, recoveryCode, params),
    },
    payload: aesGcmEncrypt(dek, JSON.stringify(payload)),
  };
  return { envelope, recoveryCode, dek };
}

async function wrapDekWithRecovery(dek, recoveryCode, params) {
  const salt2 = randomBytes(16).toString('base64');
  const rKek = await deriveKek(normalizeRecoveryCode(recoveryCode), salt2, params);
  return { salt2, ...aesGcmEncrypt(rKek, dek) };
}

function kdfParamsOf(envelope) {
  const { N, r, p } = envelope.kdf;
  return { N, r, p };
}

function decryptPayload(dek, envelope) {
  return JSON.parse(aesGcmDecrypt(dek, envelope.payload).toString('utf8'));
}

export async function openEnvelopeWithPassword(envelope, password) {
  const kek = await deriveKek(password, envelope.kdf.salt, kdfParamsOf(envelope));
  const dek = aesGcmDecrypt(kek, envelope.dek.wrappedByMaster);
  return { dek, payload: decryptPayload(dek, envelope) };
}

export async function openEnvelopeWithRecovery(envelope, code) {
  const wrap = envelope.dek.wrappedByRecovery;
  const rKek = await deriveKek(normalizeRecoveryCode(code), wrap.salt2, kdfParamsOf(envelope));
  const dek = aesGcmDecrypt(rKek, { iv: wrap.iv, ct: wrap.ct, tag: wrap.tag });
  return { dek, payload: decryptPayload(dek, envelope) };
}

// 换主密码：仅重包 wrappedByMaster，恢复码保持不变
export async function rewrapMaster(envelope, dek, newPassword, kdfParams) {
  const params = kdfParams ?? kdfParamsOf(envelope);
  const salt = randomBytes(16).toString('base64');
  const kek = await deriveKek(newPassword, salt, params);
  return {
    ...envelope,
    kdf: { algo: 'scrypt', N: params.N, r: params.r, p: params.p, salt },
    dek: { ...envelope.dek, wrappedByMaster: aesGcmEncrypt(kek, dek) },
  };
}

// 重置恢复码（恢复流程完成后）
export async function rewrapRecovery(envelope, dek, newRecoveryCode) {
  return {
    ...envelope,
    dek: {
      ...envelope.dek,
      wrappedByRecovery: await wrapDekWithRecovery(dek, newRecoveryCode, kdfParamsOf(envelope)),
    },
  };
}

// 导出备份：导出密码派生 KEK'' 重新包装 DEK，payload 密文原样携带
export async function createExportEnvelope(envelope, dek, exportPassword, kdfParams) {
  const params = kdfParams ?? kdfParamsOf(envelope);
  const salt = randomBytes(16).toString('base64');
  const kek = await deriveKek(exportPassword, salt, params);
  return {
    v: 1,
    kdf: { algo: 'scrypt', N: params.N, r: params.r, p: params.p, salt },
    dek: { wrappedByExport: aesGcmEncrypt(kek, dek) },
    payload: envelope.payload,
  };
}

export async function openExportEnvelope(exportEnvelope, exportPassword) {
  const kek = await deriveKek(exportPassword, exportEnvelope.kdf.salt, kdfParamsOf(exportEnvelope));
  const dek = aesGcmDecrypt(kek, exportEnvelope.dek.wrappedByExport);
  return { dek, payload: decryptPayload(dek, exportEnvelope) };
}

// ---- TOTP (RFC 6238, HMAC-SHA1, 30s 步长, 6 位, ±1 窗口) ----

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/=+$/, '').replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateTotpSecret() {
  const raw = randomBytes(20);
  return { raw, base32: base32Encode(raw) };
}

export function totpUri(base32Secret, account = 'quota-dashboard', issuer = 'QuotaDashboard') {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  return `otpauth://totp/${label}?secret=${base32Secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

export function totpCode(secretRaw, timeMs, { stepMs = 30_000, digits = 6 } = {}) {
  const counter = BigInt(Math.floor(timeMs / stepMs));
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(counter);
  const h = createHmac('sha1', secretRaw).update(msg).digest();
  const off = h[h.length - 1] & 0x0f;
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

export function verifyTotp(secretRaw, code, timeMs = Date.now(), window = 1) {
  const c = String(code ?? '').trim();
  if (!/^\d{6}$/.test(c)) return false;
  for (let w = -window; w <= window; w++) {
    const t = totpCode(secretRaw, timeMs + w * 30_000);
    if (timingSafeEqual(Buffer.from(t), Buffer.from(c))) return true;
  }
  return false;
}
