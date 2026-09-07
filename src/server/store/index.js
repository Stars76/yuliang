// 多用户加密 store：DATA_DIR/store.enc（v2）原子读写、全局 session 表（SHA-256 哈希）、审计日志（每日轮转保留 30 天）
//
// v2 结构：{ v:2, users:[{username, usernameLower, role, status, createdAt, lastLoginAt, envelope}], sessions:[...] }
// 每个用户的 envelope 与 v1 单用户信封结构完全一致：DEK 由该用户自己的登录密码派生的 KEK 包裹，
// 没有该用户的密码，任何人（包括管理员）都无法解密其 payload（凭证/密钥）。
// sessions 是全局表，只存 token 哈希 + 用户名 + 时间，不含任何敏感数据。
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  createEnvelope,
  openEnvelopeWithPassword,
  openEnvelopeWithRecovery,
  rewrapMaster,
  rewrapRecovery,
  createExportEnvelope,
  openExportEnvelope,
  aesGcmEncrypt,
  aesGcmDecrypt,
  generateRecoveryCode,
  generateTotpSecret,
  base32Encode,
  totpUri,
  verifyTotp,
} from '../crypto/index.js';

const SESSION_TTL_MS = 12 * 3600 * 1000;
const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
const AUDIT_KEEP_DAYS = 30;

function sha256(s) {
  return createHash('sha256').update(s).digest('hex');
}

function normalizePayload(p) {
  return {
    credentials: Array.isArray(p?.credentials) ? p.credentials : [],
    codexAccounts: Array.isArray(p?.codexAccounts) ? p.codexAccounts : [],
    settings: p?.settings && typeof p.settings === 'object' ? p.settings : {},
    totp: p?.totp ?? null,
    lockout: {
      fails: p?.lockout?.fails ?? 0,
      nextAllowedAt: p?.lockout?.nextAllowedAt ?? 0,
      lockedUntil: p?.lockout?.lockedUntil ?? 0,
    },
  };
}

export class Store {
  constructor(dataDir, { sessionTtlMs = SESSION_TTL_MS, backoffBaseMs = 1000, lockoutThreshold = LOCKOUT_THRESHOLD, lockoutMs = LOCKOUT_MS } = {}) {
    this.dataDir = dataDir;
    this.sessionTtlMs = sessionTtlMs;
    this.backoffBaseMs = backoffBaseMs;
    this.lockoutThreshold = lockoutThreshold;
    this.lockoutMs = lockoutMs;
    this.users = null; // 磁盘上的用户记录（含各自的 envelope）
    this.sessions = []; // 全局 session 表（哈希，不落敏感数据）
    this.unlocked = new Map(); // usernameLower -> { dek, payload }
    this._lockoutMem = new Map(); // 未解锁用户的内存锁定状态
  }

  get filePath() {
    return path.join(this.dataDir, 'store.enc');
  }

  get initialized() {
    return Array.isArray(this.users) && this.users.length > 0;
  }

  async exists() {
    try {
      await fs.access(this.filePath);
      return true;
    } catch {
      return false;
    }
  }

  async load() {
    const raw = JSON.parse(await fs.readFile(this.filePath, 'utf8'));
    if (raw?.v === 2 && Array.isArray(raw.users)) {
      this.users = raw.users;
      this.sessions = Array.isArray(raw.sessions) ? raw.sessions : [];
      return;
    }
    // v1 单用户信封 → 迁移为 v2：原信封整体成为 admin 用户，sessions 无法解密迁移（重新登录即可）
    if (raw?.v === 1 && raw.kdf && raw.dek && raw.payload) {
      const bak = `${this.filePath}.v1.bak`;
      await fs.copyFile(this.filePath, bak);
      await fs.chmod(bak, 0o600).catch(() => {});
      this.users = [
        {
          username: 'admin',
          usernameLower: 'admin',
          role: 'admin',
          status: 'active',
          createdAt: Date.now(),
          lastLoginAt: 0,
          envelope: raw,
        },
      ];
      this.sessions = [];
      await this.save();
      return;
    }
    throw new Error('store 格式无法识别');
  }

  // ---- 用户 ----

  userByName(username) {
    const ul = String(username ?? '').toLowerCase();
    return this.users?.find((u) => u.usernameLower === ul) ?? null;
  }

  listUsers() {
    return (this.users ?? []).map((u) => ({
      username: u.username,
      role: u.role,
      status: u.status,
      createdAt: u.createdAt,
      lastLoginAt: u.lastLoginAt ?? 0,
    }));
  }

  isUnlocked(username) {
    return this.unlocked.has(String(username ?? '').toLowerCase());
  }

  // 已解锁用户的运行上下文；未解锁返回 null
  entry(username) {
    const ul = String(username ?? '').toLowerCase();
    const user = this.userByName(ul);
    const open = this.unlocked.get(ul);
    if (!user || !open) return null;
    return { user, dek: open.dek, payload: open.payload };
  }

  async #createUser({ username, role, password, kdfParams }) {
    const { envelope, recoveryCode, dek } = await createEnvelope(password, undefined, kdfParams);
    const user = {
      username,
      usernameLower: username.toLowerCase(),
      role,
      status: 'active',
      createdAt: Date.now(),
      lastLoginAt: 0,
      envelope,
    };
    this.users ??= [];
    this.users.push(user);
    this.unlocked.set(user.usernameLower, { dek, payload: normalizePayload(null) });
    await this.save();
    return { recoveryCode };
  }

  // 初始化管理员（CLI init）；不再强制生成 TOTP，TOTP 为安全页可选开关
  async init(username, password, kdfParams) {
    return this.#createUser({ username, role: 'admin', password, kdfParams });
  }

  // 注册普通用户
  async register(username, password, kdfParams) {
    return this.#createUser({ username, role: 'user', password, kdfParams });
  }

  async setStatus(username, status) {
    const user = this.userByName(username);
    if (!user) return false;
    user.status = status;
    if (status !== 'active') await this.revokeUserSessions(user.usernameLower);
    await this.save();
    return true;
  }

  async deleteUser(username) {
    const ul = String(username ?? '').toLowerCase();
    const before = this.users.length;
    this.users = this.users.filter((u) => u.usernameLower !== ul);
    if (this.users.length === before) return false;
    this.unlocked.delete(ul);
    this._lockoutMem.delete(ul);
    this.sessions = this.sessions.filter((s) => s.usernameLower !== ul);
    await this.save();
    return true;
  }

  // ---- 解锁 / 密码校验 ----

  async verifyPassword(username, password) {
    const user = this.userByName(username);
    if (!user || typeof password !== 'string') return null;
    try {
      return await openEnvelopeWithPassword(user.envelope, password);
    } catch {
      return null;
    }
  }

  adoptUnlock(username, { dek, payload }) {
    this.unlocked.set(String(username ?? '').toLowerCase(), { dek, payload: normalizePayload(payload) });
  }

  async unlockWithPassword(username, password) {
    const r = await this.verifyPassword(username, password);
    if (!r) return false;
    this.adoptUnlock(username, r);
    return true;
  }

  // ---- 持久化：把每个已解锁用户的 payload 重新加密回各自信封，整体原子写 ----

  async save() {
    if (!this.users) throw new Error('store not loaded');
    for (const [ul, open] of this.unlocked) {
      const user = this.userByName(ul);
      if (!user) continue;
      user.envelope = { ...user.envelope, payload: aesGcmEncrypt(open.dek, JSON.stringify(open.payload)) };
    }
    this.pruneSessions();
    await fs.mkdir(this.dataDir, { recursive: true });
    const doc = { v: 2, users: this.users, sessions: this.sessions };
    const tmp = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(tmp, JSON.stringify(doc), { mode: 0o600 });
    await fs.rename(tmp, this.filePath);
  }

  // ---- 锁定（按用户；已解锁持久化到各自 payload，未解锁退化到内存） ----

  lockoutState(username) {
    const ul = String(username ?? '').toLowerCase();
    const open = this.unlocked.get(ul);
    if (open) return open.payload.lockout;
    if (!this._lockoutMem.has(ul)) this._lockoutMem.set(ul, { fails: 0, nextAllowedAt: 0, lockedUntil: 0 });
    return this._lockoutMem.get(ul);
  }

  async recordAuthFailure(username) {
    const lo = this.lockoutState(username);
    const now = Date.now();
    lo.fails += 1;
    lo.nextAllowedAt = now + Math.min(2 ** lo.fails * this.backoffBaseMs, 30 * this.backoffBaseMs);
    if (lo.fails >= this.lockoutThreshold) {
      lo.lockedUntil = now + this.lockoutMs;
      lo.fails = 0;
    }
    if (this.isUnlocked(username)) await this.save();
  }

  async clearAuthFailures(username) {
    const lo = this.lockoutState(username);
    lo.fails = 0;
    lo.nextAllowedAt = 0;
    lo.lockedUntil = 0;
    if (this.isUnlocked(username)) await this.save();
  }

  // ---- session（全局表，只存哈希） ----

  pruneSessions() {
    const now = Date.now();
    this.sessions = this.sessions.filter((s) => s.expiresAt > now);
  }

  async createSession(username) {
    const ul = String(username ?? '').toLowerCase();
    if (!this.userByName(ul)) throw new Error('unknown user');
    this.pruneSessions();
    const token = randomBytes(32).toString('base64url');
    const now = Date.now();
    this.sessions.push({ hash: sha256(token), usernameLower: ul, createdAt: now, expiresAt: now + this.sessionTtlMs });
    await this.save();
    return { token, expiresAt: now + this.sessionTtlMs };
  }

  findSession(token) {
    if (!token) return null;
    this.pruneSessions();
    const hash = sha256(token);
    return this.sessions.find((s) => s.hash === hash) ?? null;
  }

  // 滑动续期：剩余不足一半时延长到完整 TTL 并落盘（每个 session 最多每 TTL/2 写一次）
  async touchSession(token) {
    if (!token) return false;
    const hash = sha256(token);
    const s = this.sessions.find((x) => x.hash === hash);
    if (!s) return false;
    const now = Date.now();
    if (s.expiresAt - now > this.sessionTtlMs / 2) return false;
    s.expiresAt = now + this.sessionTtlMs;
    await this.save();
    return true;
  }

  async revokeSession(token) {
    const hash = sha256(token);
    this.sessions = this.sessions.filter((s) => s.hash !== hash);
    await this.save();
  }

  // 只保留该用户当前这一个 session（不影响其他用户）
  async revokeOtherSessions(username, token) {
    const ul = String(username ?? '').toLowerCase();
    const hash = sha256(token);
    this.sessions = this.sessions.filter((s) => s.usernameLower !== ul || s.hash === hash);
    await this.save();
  }

  async revokeUserSessions(username) {
    const ul = String(username ?? '').toLowerCase();
    this.sessions = this.sessions.filter((s) => s.usernameLower !== ul);
    await this.save();
  }

  // ---- TOTP（可选，按用户） ----

  hasTotp(username) {
    const e = this.entry(username);
    return Boolean(e?.payload.totp?.secretEnc);
  }

  totpRaw(username) {
    const e = this.entry(username);
    if (!e?.payload.totp?.secretEnc) return null;
    return aesGcmDecrypt(e.dek, e.payload.totp.secretEnc);
  }

  verifyTotpCode(username, code) {
    const raw = this.totpRaw(username);
    return raw ? verifyTotp(raw, code) : false;
  }

  // 启用 TOTP：写入密钥并返回一次性展示的 uri/secret；secretRaw 缺省时现场生成
  async enableTotp(username, secretRaw) {
    const e = this.entry(username);
    if (!e) throw new Error('store locked');
    const totp = secretRaw ? { raw: secretRaw, base32: base32Encode(secretRaw) } : generateTotpSecret();
    e.payload.totp = { secretEnc: aesGcmEncrypt(e.dek, totp.raw) };
    await this.save();
    return { totpSecret: totp.base32, totpUri: totpUri(totp.base32, e.user.username) };
  }

  async disableTotp(username) {
    const e = this.entry(username);
    if (!e) throw new Error('store locked');
    e.payload.totp = null;
    await this.save();
  }

  // ---- 密码 / 备份 / 恢复（全部按用户） ----

  async changePassword(username, newPassword, kdfParams) {
    const e = this.entry(username);
    if (!e) throw new Error('store locked');
    e.user.envelope = await rewrapMaster(e.user.envelope, e.dek, newPassword, kdfParams);
    await this.save();
  }

  async exportBackup(username, exportPassword, kdfParams) {
    const e = this.entry(username);
    if (!e) throw new Error('store locked');
    const env = await createExportEnvelope(e.user.envelope, e.dek, exportPassword, kdfParams);
    return JSON.stringify(env);
  }

  // 导入备份：解密导出信封，替换 credentials/codexAccounts（settings 如含则一并恢复；
  // totp/lockout 保留现状，sessions 绝不导入）。失败返回 null，不泄露细节。
  async importBackup(username, exportPassword, backupText) {
    const e = this.entry(username);
    if (!e) throw new Error('store locked');
    let r;
    try {
      const text = String(backupText ?? '').trim();
      const jsonText = text.startsWith('{') ? text : Buffer.from(text, 'base64').toString('utf8');
      const env = JSON.parse(jsonText);
      if (env?.v !== 1 || !env.kdf?.salt || !env.dek?.wrappedByExport || !env.payload?.ct) throw new Error('bad format');
      r = await openExportEnvelope(env, exportPassword);
      if (!r.payload || typeof r.payload !== 'object') throw new Error('bad payload');
    } catch {
      return null;
    }
    const restored = normalizePayload(r.payload);
    e.payload.credentials = restored.credentials;
    e.payload.codexAccounts = restored.codexAccounts;
    if (r.payload.settings && typeof r.payload.settings === 'object') e.payload.settings = restored.settings;
    await this.save();
    return { credentials: e.payload.credentials.length, codexAccounts: e.payload.codexAccounts.length };
  }

  // 恢复完成：换新密码 + 新恢复码，清除 TOTP（恢复码本身是根因子，避免用户被 TOTP 锁死），注销该用户全部 session
  async completeRecovery(username, newPassword, kdfParams) {
    const e = this.entry(username);
    if (!e) throw new Error('store locked');
    e.user.envelope = await rewrapMaster(e.user.envelope, e.dek, newPassword, kdfParams);
    const recoveryCode = generateRecoveryCode();
    e.user.envelope = await rewrapRecovery(e.user.envelope, e.dek, recoveryCode);
    e.payload.totp = null;
    await this.save();
    await this.revokeUserSessions(e.user.usernameLower);
    return { newRecoveryCode: recoveryCode };
  }
}

// ---- 审计日志 ----

const REDACT_RULES = [
  /Bearer\s+\S+/gi,
  /sk-[A-Za-z0-9_-]{4,}/g,
  /[A-Za-z0-9+/=_-]{21,}/g,
];

export function redactValue(value) {
  if (typeof value === 'string') {
    let out = value;
    for (const rule of REDACT_RULES) out = out.replace(rule, '[REDACTED]');
    return out;
  }
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactValue(v)]));
  }
  return value;
}

function auditFileName(date = new Date()) {
  const ymd = date.toISOString().slice(0, 10).replace(/-/g, '');
  return `audit-${ymd}.log`;
}

export async function audit(dataDir, event, details = {}) {
  try {
    await fs.mkdir(dataDir, { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), event, details: redactValue(details) });
    await fs.appendFile(path.join(dataDir, auditFileName()), line + '\n', { mode: 0o600 });
    await pruneAudit(dataDir);
  } catch (e) {
    console.warn(`[audit] write failed: ${e.message}`);
  }
}

async function pruneAudit(dataDir) {
  const cutoff = Date.now() - AUDIT_KEEP_DAYS * 24 * 3600 * 1000;
  for (const name of await fs.readdir(dataDir)) {
    const m = /^audit-(\d{4})(\d{2})(\d{2})\.log$/.exec(name);
    if (!m) continue;
    if (Date.UTC(+m[1], +m[2] - 1, +m[3]) < cutoff) {
      await fs.rm(path.join(dataDir, name), { force: true });
    }
  }
}

export async function readAudit(dataDir, limit = 200) {
  let names = [];
  try {
    names = (await fs.readdir(dataDir)).filter((n) => /^audit-\d{8}\.log$/.test(n)).sort().reverse();
  } catch {
    return [];
  }
  const entries = [];
  for (const name of names) {
    const text = await fs.readFile(path.join(dataDir, name), 'utf8').catch(() => '');
    const lines = text.trim().split('\n').filter(Boolean).reverse();
    for (const line of lines) {
      try {
        entries.push(JSON.parse(line));
      } catch {
        // 跳过坏行
      }
      if (entries.length >= limit) return entries;
    }
  }
  return entries;
}
