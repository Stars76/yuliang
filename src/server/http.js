// 原生 node:http 服务：REST 路由 + 安全头 + CSRF + step-up + 限流 + 静态文件
// 多用户：每个请求按 session 定位用户，数据操作只作用于该用户的加密 payload；
// TOTP 为可选（安全页自行开启），未开启时 step-up 只验密码。
import http from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getAdapter, listProviderMeta } from './providers/index.js';
import { executeAdapter, QuotaError } from './providers/http.js';
import { openEnvelopeWithRecovery, generateTotpSecret, totpUri, verifyTotp } from './crypto/index.js';
import { audit, readAudit } from './store/index.js';

const BODY_LIMIT = 64 * 1024;
const COOKIE_NAME = 'qd_session';
const CACHE_TTL_MS = 60_000;
const RECOVERY_TOKEN_TTL_MS = 10 * 60 * 1000;
const TOTP_PENDING_TTL_MS = 10 * 60 * 1000;
const MIN_PASSWORD_LEN = 8;
const MIN_EXPORT_PASSWORD_LEN = 8;
const USERNAME_RE = /^[A-Za-z0-9._-]{3,20}$/;

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    // sha256 白名单的是 index.html 里防主题闪烁的内联初始化脚本（改该脚本须同步重算哈希）
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self' 'sha256-VC2U0hRkg0m8koNXtYJDXRFq+YKnXswGr2Bst72or4g='; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
};

function httpError(status, body) {
  const e = new Error(body?.error ?? `http ${status}`);
  e.status = status;
  e.body = body;
  return e;
}

class TokenBucket {
  constructor(capacity, refillPerSec) {
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this.tokens = capacity;
    this.updated = Date.now();
  }

  take() {
    const now = Date.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.updated) / 1000) * this.refillPerSec);
    this.updated = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

class SlidingWindow {
  constructor(max, windowMs) {
    this.max = max;
    this.windowMs = windowMs;
    this.hits = [];
  }

  take() {
    const now = Date.now();
    this.hits = this.hits.filter((t) => now - t < this.windowMs);
    if (this.hits.length >= this.max) return false;
    this.hits.push(now);
    return true;
  }
}

export function createServer({ store, dataDir, webDist }) {
  const quotaCache = new Map(); // `${usernameLower}:${accountId}` -> {result, fetchedAt, fails, nextRetryAt}
  const inflight = new Map();
  const recoveryTokens = new Map(); // token -> {usernameLower, dek, payload, expiresAt}
  const totpPending = new Map(); // usernameLower -> {raw, base32, expiresAt}
  const globalBucket = new TokenBucket(120, 2);
  const refreshBucket = new TokenBucket(5, 5 / 60);
  const recoverWindow = new SlidingWindow(5, 15 * 60 * 1000);
  const registerWindow = new SlidingWindow(10, 60 * 60 * 1000);

  function sendJson(res, status, obj, extraHeaders = {}) {
    const body = JSON.stringify(obj);
    res.writeHead(status, {
      ...SECURITY_HEADERS,
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      ...extraHeaders,
    });
    res.end(body);
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const len = Number(req.headers['content-length'] ?? 0);
      if (len > BODY_LIMIT) {
        req.resume();
        reject(httpError(413, { error: 'body_too_large' }));
        return;
      }
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > BODY_LIMIT) {
          reject(httpError(413, { error: 'body_too_large' }));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', () => reject(httpError(400, { error: 'bad_request' })));
    });
  }

  async function readJson(req) {
    const text = await readBody(req);
    if (!text) return {};
    try {
      const obj = JSON.parse(text);
      if (!obj || typeof obj !== 'object') throw new Error();
      return obj;
    } catch {
      throw httpError(400, { error: 'bad_json' });
    }
  }

  function checkCsrf(req) {
    if (req.headers['x-requested-with'] !== 'quota-dashboard') {
      throw httpError(403, { error: 'csrf_failed' });
    }
    const origin = req.headers.origin;
    if (origin) {
      let host = null;
      try {
        host = new URL(origin).host;
      } catch {
        host = null;
      }
      if (host !== req.headers.host) throw httpError(403, { error: 'csrf_failed' });
    }
  }

  function sessionOf(req) {
    const cookie = req.headers.cookie ?? '';
    const m = new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`).exec(cookie);
    const token = m ? decodeURIComponent(m[1]) : null;
    const session = store.findSession(token);
    if (!session) return null;
    return { token, session, usernameLower: session.usernameLower, user: store.userByName(session.usernameLower) };
  }

  function requireAuth(req) {
    const auth = sessionOf(req);
    if (!auth) throw httpError(401, { error: 'unauthenticated' });
    if (!auth.user || auth.user.status !== 'active') throw httpError(403, { error: 'account_disabled' });
    // 服务重启后 session 表仍在但用户数据未解锁：要求重新登录（登录成功即解锁）
    if (!store.isUnlocked(auth.usernameLower)) throw httpError(401, { error: 'locked' });
    // 滑动续期（fire-and-forget）：活动中的 session 不过期
    store.touchSession(auth.token).catch(() => {});
    return auth;
  }

  function requireAdmin(req) {
    const auth = requireAuth(req);
    if (auth.user.role !== 'admin') throw httpError(403, { error: 'forbidden' });
    return auth;
  }

  function checkLockout(usernameLower) {
    const lo = store.lockoutState(usernameLower);
    const now = Date.now();
    if (lo.lockedUntil > now) {
      throw httpError(423, { error: 'locked', retryAfterSec: Math.ceil((lo.lockedUntil - now) / 1000) });
    }
    if (lo.nextAllowedAt > now) {
      throw httpError(429, { error: 'rate_limited', retryAfterSec: Math.ceil((lo.nextAllowedAt - now) / 1000) });
    }
  }

  // step-up：每次重验密码；该用户开启了 TOTP 时才需要动态验证码。任一错误统一 401 并计入该用户锁定
  async function stepUp(body, auth) {
    checkLockout(auth.usernameLower);
    const okPw = typeof body.password === 'string' ? await store.verifyPassword(auth.usernameLower, body.password) : null;
    const ok = Boolean(okPw) && (!store.hasTotp(auth.usernameLower) || store.verifyTotpCode(auth.usernameLower, body.totp));
    if (!ok) {
      await store.recordAuthFailure(auth.usernameLower);
      await audit(dataDir, 'step_up_failed', { username: auth.user.username });
      throw httpError(401, { error: 'step_up_failed' });
    }
  }

  // 仅验证密码（TOTP 开关等场景）
  async function verifyPasswordOrThrow(body, auth) {
    checkLockout(auth.usernameLower);
    const ok = typeof body.password === 'string' ? await store.verifyPassword(auth.usernameLower, body.password) : null;
    if (!ok) {
      await store.recordAuthFailure(auth.usernameLower);
      await audit(dataDir, 'step_up_failed', { username: auth.user.username });
      throw httpError(401, { error: 'step_up_failed' });
    }
  }

  function payloadOf(usernameLower) {
    return store.entry(usernameLower)?.payload;
  }

  // ---- quota 组装：内存缓存 ≥60s + 失败指数退避；缓存按 用户+账号 隔离 ----

  async function quotaSources(usernameLower) {
    const out = [];
    for (const c of payloadOf(usernameLower)?.credentials ?? []) {
      // codex 凭证只是 CPA 管理 key，本身没有额度卡片；卡片来自已勾选的 codexAccounts（codexSources）
      if (c.provider === 'codex') continue;
      const adapter = await getAdapter(c.provider);
      out.push({
        accountId: c.id,
        cacheKey: `${usernameLower}:${c.id}`,
        provider: c.provider,
        alias: c.alias,
        kind: adapter?.kind ?? null,
        fetch: async () => {
          if (!adapter) throw new QuotaError('unavailable', `adapter ${c.provider} unavailable`);
          return { adapter, partial: await executeAdapter(adapter, c.fields) };
        },
      });
    }
    return out;
  }

  async function codexSources(usernameLower) {
    const accounts = payloadOf(usernameLower)?.codexAccounts ?? [];
    if (accounts.length === 0) return [];
    const adapter = await getAdapter('codex');
    if (!adapter) return []; // adapter 未加载则返回空数组
    return accounts.map((a) => ({
      accountId: `codex:${a.credId}:${a.authIndex}`,
      cacheKey: `${usernameLower}:codex:${a.credId}:${a.authIndex}`,
      provider: 'codex',
      alias: a.alias,
      kind: 'quota',
      fetch: async () => {
        const cred = (payloadOf(usernameLower)?.credentials ?? []).find((c) => c.id === a.credId);
        if (!cred) throw new QuotaError('unavailable', 'codex credential missing');
        const partial = await adapter.fetchCodexQuota(cred.fields, a.authIndex);
        return { adapter, partial };
      },
    }));
  }

  async function fetchOne(src, { force = false } = {}) {
    const now = Date.now();
    const cached = quotaCache.get(src.cacheKey);
    if (!force && cached) {
      if (now - cached.fetchedAt < CACHE_TTL_MS) return cached.result;
      if (cached.nextRetryAt > now) return cached.result; // 退避窗口内沿用旧结果
    }
    if (inflight.has(src.cacheKey)) return inflight.get(src.cacheKey);
    const p = (async () => {
      const fetchedAt = Date.now();
      const base = {
        accountId: src.accountId,
        provider: src.provider,
        kind: src.kind ?? 'quota',
        alias: src.alias,
        plan: null,
        windows: [],
        balance: null,
        fetchedAt,
        source: 'live',
        error: null,
      };
      try {
        const { adapter, partial } = await src.fetch();
        base.kind = adapter.kind ?? base.kind;
        for (const k of ['plan', 'windows', 'balance', 'source']) {
          if (partial?.[k] !== undefined) base[k] = partial[k];
        }
        if (partial?.error) base.error = partial.error;
        quotaCache.set(src.cacheKey, { result: base, fetchedAt, fails: 0, nextRetryAt: 0 });
      } catch (e) {
        const prev = quotaCache.get(src.cacheKey);
        const fails = (prev?.fails ?? 0) + 1;
        base.error = {
          kind: e instanceof QuotaError ? e.kind : 'unavailable',
          message: e instanceof QuotaError ? e.message : 'unexpected error',
        };
        quotaCache.set(src.cacheKey, {
          result: base,
          fetchedAt,
          fails,
          nextRetryAt: Date.now() + Math.min(CACHE_TTL_MS * 2 ** (fails - 1), 30 * 60_000),
        });
      }
      return quotaCache.get(src.cacheKey).result;
    })().finally(() => inflight.delete(src.cacheKey));
    inflight.set(src.cacheKey, p);
    return p;
  }

  async function collectQuota(usernameLower, { force = false, onlyAccountId = null } = {}) {
    const sources = [...(await quotaSources(usernameLower)), ...(await codexSources(usernameLower))];
    const targets = onlyAccountId ? sources.filter((s) => s.accountId === onlyAccountId) : sources;
    if (onlyAccountId && targets.length === 0) throw httpError(404, { error: 'account_not_found' });
    const now = Date.now();
    const results = await Promise.all(
      targets.map((s) => {
        const cached = quotaCache.get(s.cacheKey);
        if (!force && cached && now - cached.fetchedAt >= CACHE_TTL_MS) {
          fetchOne(s).catch(() => {}); // 后台刷新，先返回缓存
          return cached.result;
        }
        return fetchOne(s, { force });
      }),
    );
    if (!onlyAccountId) {
      const live = results.map((r) => `${usernameLower}:${r.accountId}`);
      for (const [key] of quotaCache) {
        if (key.startsWith(`${usernameLower}:`) && !live.includes(key) && !sources.some((s) => s.cacheKey === key)) {
          quotaCache.delete(key);
        }
      }
    }
    return results;
  }

  function findCredential(usernameLower, id) {
    const cred = (payloadOf(usernameLower)?.credentials ?? []).find((c) => c.id === id);
    if (!cred) throw httpError(404, { error: 'credential_not_found' });
    return cred;
  }

  // init 可能由 CLI 进程在服务运行期间完成，未初始化时尝试从磁盘重新加载
  async function refreshStoreIfNeeded() {
    if (!store.initialized && (await store.exists())) await store.load();
  }

  // ---- 路由 ----

  const routes = {
    'POST /api/auth/register': async (req, res) => {
      await refreshStoreIfNeeded();
      if (!store.initialized) throw httpError(503, { error: 'not_initialized' });
      if (!registerWindow.take()) throw httpError(429, { error: 'rate_limited' });
      const body = await readJson(req);
      const username = typeof body.username === 'string' ? body.username.trim() : '';
      if (!USERNAME_RE.test(username)) throw httpError(400, { error: 'invalid_username' });
      if (typeof body.password !== 'string' || body.password.length < MIN_PASSWORD_LEN) {
        throw httpError(400, { error: 'weak_password' });
      }
      if (store.userByName(username)) throw httpError(409, { error: 'username_taken' });
      const { recoveryCode } = await store.register(username, body.password);
      await audit(dataDir, 'register', { username });
      sendJson(res, 200, { ok: true, recoveryCode });
    },

    'POST /api/auth/login': async (req, res) => {
      await refreshStoreIfNeeded();
      if (!store.initialized) throw httpError(503, { error: 'not_initialized' });
      const body = await readJson(req);
      const username = typeof body.username === 'string' ? body.username.trim() : '';
      const ul = username.toLowerCase();
      checkLockout(ul);
      const user = store.userByName(ul);
      const r = user && typeof body.password === 'string' ? await store.verifyPassword(ul, body.password) : null;
      if (!r) {
        await store.recordAuthFailure(ul);
        await audit(dataDir, 'login_failed', { username: username || '(empty)' });
        throw httpError(401, { error: 'invalid_credentials' });
      }
      if (user.status !== 'active') {
        await audit(dataDir, 'login_disabled', { username: user.username });
        throw httpError(403, { error: 'account_disabled' });
      }
      if (!store.isUnlocked(ul)) store.adoptUnlock(ul, r);
      await store.clearAuthFailures(ul);
      user.lastLoginAt = Date.now();
      const { token, expiresAt } = await store.createSession(ul);
      await audit(dataDir, 'login_success', { username: user.username });
      sendJson(
        res,
        200,
        { ok: true, expiresAt },
        {
          'Set-Cookie': `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${30 * 24 * 3600}`,
        },
      );
    },

    'POST /api/auth/logout': async (req, res) => {
      const auth = sessionOf(req);
      if (auth) {
        await store.revokeSession(auth.token);
        await audit(dataDir, 'logout', { username: auth.user?.username ?? auth.usernameLower });
      }
      sendJson(res, 200, { ok: true }, { 'Set-Cookie': `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0` });
    },

    'GET /api/auth/status': async (req, res) => {
      await refreshStoreIfNeeded();
      const auth = sessionOf(req);
      const active = Boolean(auth && auth.user?.status === 'active' && store.isUnlocked(auth.usernameLower));
      if (active) store.touchSession(auth.token).catch(() => {}); // keepalive 也算活动
      sendJson(res, 200, {
        authenticated: active,
        expiresAt: active ? auth.session.expiresAt : null,
        initialized: store.initialized,
        user: active
          ? { username: auth.user.username, role: auth.user.role, totpEnabled: store.hasTotp(auth.usernameLower) }
          : null,
      });
    },

    'POST /api/auth/recover': async (req, res) => {
      await refreshStoreIfNeeded();
      if (!store.initialized) throw httpError(503, { error: 'not_initialized' });
      if (!recoverWindow.take()) throw httpError(429, { error: 'rate_limited' });
      const body = await readJson(req);
      const username = typeof body.username === 'string' ? body.username.trim() : '';
      const user = store.userByName(username);
      try {
        if (!user) throw new Error('no user');
        const r = await openEnvelopeWithRecovery(user.envelope, body.recoveryCode);
        const token = randomBytes(32).toString('base64url');
        recoveryTokens.set(token, {
          usernameLower: user.usernameLower,
          dek: r.dek,
          payload: r.payload,
          expiresAt: Date.now() + RECOVERY_TOKEN_TTL_MS,
        });
        await audit(dataDir, 'recover_start', { username: user.username });
        sendJson(res, 200, { recoveryToken: token, expiresIn: RECOVERY_TOKEN_TTL_MS / 1000 });
      } catch {
        await audit(dataDir, 'recover_failed', { username: username || '(empty)' });
        throw httpError(401, { error: 'invalid_recovery_code' });
      }
    },

    'POST /api/auth/recover/complete': async (req, res) => {
      await refreshStoreIfNeeded();
      if (!store.initialized) throw httpError(503, { error: 'not_initialized' });
      const body = await readJson(req);
      const entry = recoveryTokens.get(body.recoveryToken);
      recoveryTokens.delete(body.recoveryToken); // 一次性
      if (!entry || entry.expiresAt < Date.now()) throw httpError(401, { error: 'invalid_recovery_token' });
      if (typeof body.newPassword !== 'string' || body.newPassword.length < MIN_PASSWORD_LEN) {
        throw httpError(400, { error: 'weak_password' });
      }
      store.adoptUnlock(entry.usernameLower, { dek: entry.dek, payload: entry.payload });
      const result = await store.completeRecovery(entry.usernameLower, body.newPassword);
      await store.clearAuthFailures(entry.usernameLower);
      await audit(dataDir, 'recover_complete', { username: store.userByName(entry.usernameLower)?.username });
      sendJson(res, 200, result);
    },

    'GET /api/quota': async (req, res) => {
      const auth = requireAuth(req);
      const accounts = await collectQuota(auth.usernameLower);
      sendJson(res, 200, { accounts });
    },

    'POST /api/quota/refresh': async (req, res) => {
      const auth = requireAuth(req);
      if (!refreshBucket.take()) throw httpError(429, { error: 'rate_limited' });
      const body = await readJson(req);
      const accounts = await collectQuota(auth.usernameLower, { force: true, onlyAccountId: body.accountId ?? null });
      await audit(dataDir, 'quota_refresh', { username: auth.user.username, accountId: body.accountId ?? 'all' });
      sendJson(res, 200, { accounts });
    },

    'GET /api/credentials': async (req, res) => {
      const auth = requireAuth(req);
      // 不返回任何密钥材料（连脱敏片段也不给）：列表只有展示所需的元信息
      const list = await Promise.all(
        (payloadOf(auth.usernameLower)?.credentials ?? []).map(async (c) => {
          const adapter = await getAdapter(c.provider);
          return {
            id: c.id,
            provider: c.provider,
            kind: c.kind ?? adapter?.kind ?? 'quota',
            alias: c.alias,
            createdAt: c.createdAt,
          };
        }),
      );
      sendJson(res, 200, list);
    },

    'GET /api/credentials/meta': async (req, res) => {
      requireAuth(req);
      sendJson(res, 200, await listProviderMeta());
    },

    'POST /api/credentials': async (req, res) => {
      const auth = requireAuth(req);
      const body = await readJson(req);
      const adapter = await getAdapter(body.provider);
      if (!adapter) throw httpError(400, { error: 'unknown_provider' });
      const fields = body.fields && typeof body.fields === 'object' ? body.fields : {};
      for (const f of adapter.credentialFields ?? []) {
        if (f.required && (typeof fields[f.key] !== 'string' || fields[f.key].trim() === '')) {
          throw httpError(400, { error: 'invalid_fields' });
        }
      }
      const cred = {
        id: randomUUID(),
        provider: adapter.id,
        kind: adapter.kind,
        alias: typeof body.alias === 'string' && body.alias.trim() ? body.alias.trim() : adapter.displayName,
        fields: Object.fromEntries(
          (adapter.credentialFields ?? []).map((f) => [f.key, typeof fields[f.key] === 'string' ? fields[f.key] : '']),
        ),
        createdAt: Date.now(),
      };
      payloadOf(auth.usernameLower).credentials.push(cred);
      await store.save();
      await audit(dataDir, 'credential_add', { username: auth.user.username, provider: cred.provider, alias: cred.alias });
      sendJson(res, 200, { id: cred.id });
    },

    'PUT /api/credentials/:id': async (req, res, { id }) => {
      const auth = requireAuth(req);
      const body = await readJson(req);
      const cred = findCredential(auth.usernameLower, id);
      if (typeof body.alias === 'string' && body.alias.trim()) cred.alias = body.alias.trim();
      if (body.fields && typeof body.fields === 'object') {
        for (const [k, v] of Object.entries(body.fields)) {
          if (typeof v === 'string' && v !== '') cred.fields[k] = v;
        }
      }
      await store.save();
      await audit(dataDir, 'credential_update', { username: auth.user.username, provider: cred.provider, alias: cred.alias });
      sendJson(res, 200, { ok: true });
    },

    'DELETE /api/credentials/:id': async (req, res, { id }) => {
      const auth = requireAuth(req);
      const cred = findCredential(auth.usernameLower, id);
      const payload = payloadOf(auth.usernameLower);
      payload.credentials = payload.credentials.filter((c) => c.id !== id);
      payload.codexAccounts = payload.codexAccounts.filter((a) => a.credId !== id);
      await store.save();
      await audit(dataDir, 'credential_delete', { username: auth.user.username, provider: cred.provider, alias: cred.alias });
      sendJson(res, 200, { ok: true });
    },

    'GET /api/codex/accounts': async (req, res, params, url) => {
      const auth = requireAuth(req);
      const credId = url.searchParams.get('credId');
      const cred = findCredential(auth.usernameLower, credId);
      const adapter = await getAdapter('codex');
      if (!adapter?.listAccounts) throw httpError(503, { error: 'adapter_unavailable' });
      try {
        const accounts = await adapter.listAccounts(cred.fields);
        sendJson(res, 200, { accounts });
      } catch (e) {
        if (e instanceof QuotaError) throw httpError(502, { error: e.kind });
        throw httpError(502, { error: 'unavailable' });
      }
    },

    'POST /api/codex/accounts': async (req, res) => {
      const auth = requireAuth(req);
      const body = await readJson(req);
      const cred = findCredential(auth.usernameLower, body.credId);
      const adapter = await getAdapter('codex');
      if (!adapter?.listAccounts) throw httpError(503, { error: 'adapter_unavailable' });
      if (!Array.isArray(body.accounts)) throw httpError(400, { error: 'bad_request' });
      let remote;
      try {
        remote = await adapter.listAccounts(cred.fields);
      } catch (e) {
        throw httpError(502, { error: e instanceof QuotaError ? e.kind : 'unavailable' });
      }
      const byIndex = new Map(remote.map((a) => [a.authIndex, a]));
      const records = [];
      for (const item of body.accounts) {
        if (typeof item?.authIndex !== 'string' || !byIndex.has(item.authIndex)) continue;
        records.push({
          credId: cred.id,
          authIndex: item.authIndex,
          maskedEmail: byIndex.get(item.authIndex).maskedEmail,
          alias: typeof item.alias === 'string' && item.alias.trim() ? item.alias.trim() : byIndex.get(item.authIndex).maskedEmail,
        });
      }
      const payload = payloadOf(auth.usernameLower);
      payload.codexAccounts = payload.codexAccounts.filter((a) => a.credId !== cred.id).concat(records);
      await store.save();
      await audit(dataDir, 'codex_accounts_save', { username: auth.user.username, count: records.length });
      sendJson(res, 200, { ok: true, count: records.length });
    },

    'GET /api/audit': async (req, res, params, url) => {
      const auth = requireAuth(req);
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 200, 1), 500);
      const entries = await readAudit(dataDir, limit);
      // 普通用户只能看到自己的条目；无 username 的历史条目归属管理员
      const filtered =
        auth.user.role === 'admin' ? entries : entries.filter((e) => e.details?.username === auth.user.username);
      sendJson(res, 200, { entries: filtered });
    },

    'POST /api/auth/change-password': async (req, res) => {
      const auth = requireAuth(req);
      const body = await readJson(req);
      await stepUp(body, auth);
      if (typeof body.newPassword !== 'string' || body.newPassword.length < MIN_PASSWORD_LEN) {
        throw httpError(400, { error: 'weak_password' });
      }
      await store.changePassword(auth.usernameLower, body.newPassword);
      await audit(dataDir, 'password_change', { username: auth.user.username });
      sendJson(res, 200, { ok: true });
    },

    'POST /api/auth/revoke-others': async (req, res) => {
      const auth = requireAuth(req);
      const body = await readJson(req);
      await stepUp(body, auth);
      await store.revokeOtherSessions(auth.usernameLower, auth.token);
      await audit(dataDir, 'revoke_others', { username: auth.user.username });
      sendJson(res, 200, { ok: true });
    },

    // TOTP 为可选项：begin 验证密码后暂存密钥，confirm 用首个验证码激活
    'POST /api/auth/totp/begin': async (req, res) => {
      const auth = requireAuth(req);
      const body = await readJson(req);
      await verifyPasswordOrThrow(body, auth);
      const totp = generateTotpSecret();
      totpPending.set(auth.usernameLower, { ...totp, expiresAt: Date.now() + TOTP_PENDING_TTL_MS });
      sendJson(res, 200, { totpSecret: totp.base32, totpUri: totpUri(totp.base32, auth.user.username) });
    },

    'POST /api/auth/totp/confirm': async (req, res) => {
      const auth = requireAuth(req);
      const body = await readJson(req);
      const pending = totpPending.get(auth.usernameLower);
      if (!pending || pending.expiresAt < Date.now()) throw httpError(400, { error: 'totp_pending_expired' });
      if (!verifyTotp(pending.raw, body.code)) throw httpError(401, { error: 'totp_code_invalid' });
      totpPending.delete(auth.usernameLower);
      await store.enableTotp(auth.usernameLower, pending.raw);
      await audit(dataDir, 'totp_enable', { username: auth.user.username });
      sendJson(res, 200, { ok: true });
    },

    'POST /api/auth/totp/disable': async (req, res) => {
      const auth = requireAuth(req);
      const body = await readJson(req);
      await verifyPasswordOrThrow(body, auth);
      await store.disableTotp(auth.usernameLower);
      await audit(dataDir, 'totp_disable', { username: auth.user.username });
      sendJson(res, 200, { ok: true });
    },

    'POST /api/export': async (req, res) => {
      const auth = requireAuth(req);
      const body = await readJson(req);
      await stepUp(body, auth);
      if (typeof body.exportPassword !== 'string' || body.exportPassword.length < MIN_EXPORT_PASSWORD_LEN) {
        throw httpError(400, { error: 'weak_export_password' });
      }
      const backup = await store.exportBackup(auth.usernameLower, body.exportPassword);
      await audit(dataDir, 'export', { username: auth.user.username });
      const ymd = new Date().toISOString().slice(0, 10);
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="quota-backup-${ymd}.enc"`,
        'Content-Length': Buffer.byteLength(backup),
      });
      res.end(backup);
    },

    // 导入恢复：step-up 后用导出密码解密备份，覆盖 credentials/codexAccounts（sessions 绝不导入）
    'POST /api/import': async (req, res) => {
      const auth = requireAuth(req);
      const body = await readJson(req);
      await stepUp(body, auth);
      if (typeof body.exportPassword !== 'string' || typeof body.backup !== 'string' || body.backup.trim() === '') {
        throw httpError(400, { error: 'invalid_backup' });
      }
      const imported = await store.importBackup(auth.usernameLower, body.exportPassword, body.backup);
      if (!imported) throw httpError(400, { error: 'invalid_backup' });
      await audit(dataDir, 'credential_import', { username: auth.user.username, ...imported }); // 只记条目数
      sendJson(res, 200, { ok: true, imported });
    },

    // ---- 用户管理（仅管理员；管理员只能看到元信息，无法接触任何用户的密钥） ----

    'GET /api/users': async (req, res) => {
      requireAdmin(req);
      sendJson(res, 200, { users: store.listUsers() });
    },

    'POST /api/users/:username/disable': async (req, res, { username }) => {
      const auth = requireAdmin(req);
      const target = store.userByName(username);
      if (!target) throw httpError(404, { error: 'user_not_found' });
      if (target.usernameLower === auth.usernameLower) throw httpError(400, { error: 'cannot_self' });
      await store.setStatus(target.usernameLower, 'disabled');
      await audit(dataDir, 'user_disable', { username: target.username, by: auth.user.username });
      sendJson(res, 200, { ok: true });
    },

    'POST /api/users/:username/enable': async (req, res, { username }) => {
      const auth = requireAdmin(req);
      const target = store.userByName(username);
      if (!target) throw httpError(404, { error: 'user_not_found' });
      if (target.usernameLower === auth.usernameLower) throw httpError(400, { error: 'cannot_self' });
      await store.setStatus(target.usernameLower, 'active');
      await audit(dataDir, 'user_enable', { username: target.username, by: auth.user.username });
      sendJson(res, 200, { ok: true });
    },

    'DELETE /api/users/:username': async (req, res, { username }) => {
      const auth = requireAdmin(req);
      const target = store.userByName(username);
      if (!target) throw httpError(404, { error: 'user_not_found' });
      if (target.usernameLower === auth.usernameLower) throw httpError(400, { error: 'cannot_self' });
      if (target.role === 'admin') throw httpError(400, { error: 'cannot_delete_admin' });
      await store.deleteUser(target.usernameLower);
      await audit(dataDir, 'user_delete', { username: target.username, by: auth.user.username });
      sendJson(res, 200, { ok: true });
    },
  };

  function matchRoute(method, pathname) {
    const direct = routes[`${method} ${pathname}`];
    if (direct) return { handler: direct, params: {} };
    for (const [key, handler] of Object.entries(routes)) {
      const [m, p] = key.split(' ');
      if (m !== method || !p.includes(':')) continue;
      const routeParts = p.split('/');
      const pathParts = pathname.split('/');
      if (routeParts.length !== pathParts.length) continue;
      const params = {};
      let ok = true;
      for (let i = 0; i < routeParts.length; i++) {
        if (routeParts[i].startsWith(':')) params[routeParts[i].slice(1)] = decodeURIComponent(pathParts[i]);
        else if (routeParts[i] !== pathParts[i]) {
          ok = false;
          break;
        }
      }
      if (ok) return { handler, params };
    }
    return null;
  }

  async function serveStatic(req, res, pathname) {
    // URL 解析已规范化点段；对原始路径逐段解码检查，显式穿越一律 404
    const rawPath = (req.url ?? '').split(/[?#]/)[0];
    for (const seg of rawPath.split('/')) {
      let dec;
      try {
        dec = decodeURIComponent(seg);
      } catch {
        throw httpError(400, { error: 'bad_request' });
      }
      if (dec === '..' || dec.includes('\0')) throw httpError(404, { error: 'not_found' });
    }
    let rel;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      throw httpError(400, { error: 'bad_request' });
    }
    if (rel.includes('\0')) throw httpError(400, { error: 'bad_request' });
    const root = path.resolve(webDist);
    let filePath = path.resolve(root, `.${rel}`);
    if (filePath !== root && !filePath.startsWith(root + path.sep)) {
      throw httpError(404, { error: 'not_found' });
    }
    let stat = await fs.stat(filePath).catch(() => null);
    if (stat?.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
      stat = await fs.stat(filePath).catch(() => null);
    }
    if (!stat && !path.extname(rel)) {
      filePath = path.join(root, 'index.html'); // SPA 回退
      stat = await fs.stat(filePath).catch(() => null);
    }
    if (!stat) throw httpError(404, { error: 'not_found' });
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    res.end(await fs.readFile(filePath));
  }

  const server = http.createServer(async (req, res) => {
    try {
      if (!globalBucket.take()) throw httpError(429, { error: 'rate_limited' });
      const url = new URL(req.url, 'http://localhost');
      const pathname = url.pathname;
      if (pathname.startsWith('/api/')) {
        if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) checkCsrf(req);
        const match = matchRoute(req.method, pathname);
        if (!match) throw httpError(404, { error: 'not_found' });
        await match.handler(req, res, match.params, url);
        return;
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        await serveStatic(req, res, pathname);
        return;
      }
      throw httpError(405, { error: 'method_not_allowed' });
    } catch (e) {
      if (e.status) {
        sendJson(res, e.status, e.body ?? { error: 'error' });
      } else {
        console.warn(`[http] ${req.method} ${req.url} -> 500 (${e.message})`);
        sendJson(res, 500, { error: 'internal' });
      }
    }
  });

  return server;
}

export { httpError };
