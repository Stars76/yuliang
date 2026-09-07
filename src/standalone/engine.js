// 单机引擎：复用 src/server/providers/**，去掉服务器/账户体系，暴露统一接口。
// 环境无关：只依赖注入的 store（凭证）与 env（cpaMgmtUrl）；取数走全局 fetch（Node/Electron 主进程或 Capacitor 注入的原生 fetch）。
// 缓存 60s + 失败指数退避，逻辑搬自 server/http.js 的 fetchOne/collectQuota/quotaCache，去掉 username 作用域。
// discover 依赖 node:fs，仅在 Node 侧动态加载，不拉入 WebView 包。
import { getAdapter, listProviderMeta } from '../server/providers/index.js';
import { executeAdapter, QuotaError } from '../server/providers/http.js';
import { setCpaMgmtUrl } from './env.js';
import {
  requestDeviceCode,
  pollDeviceCode,
  exchangeDeviceCode,
  accountIdOf,
  refreshSession,
  needsRefresh,
  newDeviceSession,
  VERIFICATION_URL,
} from './codexDirectAuth.js';

const CACHE_TTL_MS = 60_000;
const BACKOFF_CAP_MS = 30 * 60_000;

// 单机/安卓专属：给 codex 追加"手填 CPA 管理地址"字段（服务器 credentialFields 不含此项，行为不变）。
const CODEX_URL_FIELD = {
  key: 'baseUrl',
  label: 'CPA 管理地址',
  secret: false,
  required: false,
  placeholder: 'http://192.168.1.10:8317 或 https://cpa.example.com',
  hint: '留空=本机 http://127.0.0.1:8317（需本机运行 CLIProxyAPI）',
};
function fieldsFor(adapterOrMeta) {
  const base = adapterOrMeta?.credentialFields ?? [];
  return adapterOrMeta?.id === 'codex' ? [...base, CODEX_URL_FIELD] : base;
}

function uuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const b = new Uint8Array(16);
  (globalThis.crypto?.getRandomValues ?? ((a) => a.forEach((_, i) => (a[i] = (Math.random() * 256) | 0))))(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function createEngine({ store, cpaMgmtUrl = null, home, hiddenProviders = [] } = {}) {
  if (cpaMgmtUrl) setCpaMgmtUrl(cpaMgmtUrl);
  const hidden = new Set(hiddenProviders); // 平台隐藏项（如 Android 无 CPA → 隐藏 'codex'）

  const quotaCache = new Map(); // accountId -> {result, fetchedAt, fails, nextRetryAt}
  const inflight = new Map();

  async function credentialSources() {
    const out = [];
    for (const c of store.all()) {
      if (hidden.has(c.provider)) continue; // 平台隐藏项：不产卡片
      if (c.provider === 'codex') continue; // codex 凭证只是 CPA 管理 key，卡片来自勾选的 codexAccounts
      const adapter = await getAdapter(c.provider);
      out.push({
        accountId: c.id,
        provider: c.provider,
        alias: c.alias,
        kind: adapter?.kind ?? null,
        fetch: async () => {
          if (!adapter) throw new QuotaError('unavailable', `adapter ${c.provider} unavailable`);
          // codex-direct（登录版）：临近过期先续期并写回 store，再用新 token 取数
          if (c.provider === 'codex-direct') {
            let fields = c.fields;
            if (needsRefresh(fields)) {
              try {
                fields = await refreshSession(fields);
                store.patch(c.id, { fields });
              } catch {
                // 续期失败：用旧 token 再试一次，401 会如实显示凭证过期
              }
            }
            return { adapter, partial: await executeAdapter(adapter, fields) };
          }
          return { adapter, partial: await executeAdapter(adapter, c.fields) };
        },
      });
    }
    return out;
  }

  async function codexSources() {
    if (hidden.has('codex')) return [];
    const accounts = store.codexAccounts();
    if (accounts.length === 0) return [];
    const adapter = await getAdapter('codex');
    if (!adapter) return [];
    return accounts.map((a) => ({
      accountId: `codex:${a.credId}:${a.authIndex}`,
      provider: 'codex',
      alias: a.alias,
      kind: 'quota',
      fetch: async () => {
        const cred = store.find(a.credId);
        if (!cred) throw new QuotaError('unavailable', 'codex credential missing');
        return { adapter, partial: await adapter.fetchCodexQuota(cred.fields, a.authIndex) };
      },
    }));
  }

  async function fetchOne(src, { force = false } = {}) {
    const now = Date.now();
    const cached = quotaCache.get(src.accountId);
    if (!force && cached) {
      if (now - cached.fetchedAt < CACHE_TTL_MS) return cached.result;
      if (cached.nextRetryAt > now) return cached.result;
    }
    if (inflight.has(src.accountId)) return inflight.get(src.accountId);
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
        quotaCache.set(src.accountId, { result: base, fetchedAt, fails: 0, nextRetryAt: 0 });
      } catch (e) {
        const prev = quotaCache.get(src.accountId);
        const fails = (prev?.fails ?? 0) + 1;
        base.error = {
          kind: e instanceof QuotaError ? e.kind : 'unavailable',
          message: e instanceof QuotaError ? e.message : 'unexpected error',
        };
        quotaCache.set(src.accountId, {
          result: base,
          fetchedAt,
          fails,
          nextRetryAt: Date.now() + Math.min(CACHE_TTL_MS * 2 ** (fails - 1), BACKOFF_CAP_MS),
        });
      }
      return quotaCache.get(src.accountId).result;
    })().finally(() => inflight.delete(src.accountId));
    inflight.set(src.accountId, p);
    return p;
  }

  async function collectQuota({ force = false, onlyAccountId = null } = {}) {
    const sources = [...(await credentialSources()), ...(await codexSources())];
    const targets = onlyAccountId ? sources.filter((s) => s.accountId === onlyAccountId) : sources;
    if (onlyAccountId && targets.length === 0) {
      const err = new Error('account_not_found');
      err.code = 'account_not_found';
      throw err;
    }
    const now = Date.now();
    const results = await Promise.all(
      targets.map((s) => {
        const cached = quotaCache.get(s.accountId);
        if (!force && cached && now - cached.fetchedAt >= CACHE_TTL_MS) {
          fetchOne(s).catch(() => {});
          return cached.result;
        }
        return fetchOne(s, { force });
      }),
    );
    if (!onlyAccountId) {
      const live = new Set(sources.map((s) => s.accountId));
      for (const key of quotaCache.keys()) if (!live.has(key)) quotaCache.delete(key);
    }
    return results;
  }

  function validateFields(adapter, fields) {
    const src = fields && typeof fields === 'object' ? fields : {};
    const defs = fieldsFor(adapter);
    for (const f of defs) {
      if (f.required && (typeof src[f.key] !== 'string' || src[f.key].trim() === '')) {
        const err = new Error('invalid_fields');
        err.code = 'invalid_fields';
        throw err;
      }
    }
    return Object.fromEntries(defs.map((f) => [f.key, typeof src[f.key] === 'string' ? src[f.key] : '']));
  }

  // ---- Codex 直连：OAuth device-code 登录（单用户，无会话/限流） ----
  const loginStates = new Map(); // loginToken -> { deviceAuthId, userCode, codeVerifier, intervalSeconds, expiresAt }

  function err(code) {
    const e = new Error(code);
    e.code = code;
    return e;
  }

  async function saveCodexDirectCred(fields, alias) {
    // 同 accountId 已有 codex-direct 凭证 → 覆盖其 fields；否则新建
    const existing = store.all().find((c) => c.provider === 'codex-direct' && c.fields?.accountId === fields.accountId);
    if (existing) {
      store.patch(existing.id, { fields });
      return existing.id;
    }
    const adapter = await getAdapter('codex-direct');
    const cred = {
      id: uuid(),
      provider: 'codex-direct',
      kind: adapter?.kind ?? 'quota',
      alias: alias || 'Codex（直连）',
      fields,
      createdAt: Date.now(),
    };
    store.insert(cred);
    return cred.id;
  }

  return {
    async listProvidersMeta() {
      let meta = await listProviderMeta();
      if (hidden.size) meta = meta.filter((m) => !hidden.has(m.id));
      return meta.map((m) => (m.id === 'codex' ? { ...m, credentialFields: fieldsFor(m) } : m));
    },

    // 发起 Codex 直连登录：申请设备码
    async codexDirectStart() {
      const verifier = newDeviceSession();
      const d = await requestDeviceCode(verifier.codeVerifier);
      const loginToken = uuid();
      loginStates.set(loginToken, {
        deviceAuthId: d.deviceAuthId,
        userCode: d.userCode,
        codeVerifier: verifier.codeVerifier,
        intervalSeconds: d.intervalSeconds,
        expiresAt: Date.now() + 15 * 60_000,
      });
      return {
        loginToken,
        verificationUrl: VERIFICATION_URL,
        userCode: d.userCode,
        intervalSeconds: d.intervalSeconds,
        expiresAt: Date.now() + 15 * 60_000,
      };
    },

    // 轮询登录状态：pending / complete / expired
    async codexDirectPoll(loginToken) {
      const st = loginStates.get(loginToken);
      if (!st) throw err('expired');
      if (st.expiresAt < Date.now()) {
        loginStates.delete(loginToken);
        throw err('expired');
      }
      let code;
      try {
        code = await pollDeviceCode(st);
      } catch (e) {
        loginStates.delete(loginToken);
        throw e;
      }
      if (!code) return { status: 'pending' };
      loginStates.delete(loginToken);
      const session = await exchangeDeviceCode(code.authorizationCode, code.codeVerifier);
      const accountId = accountIdOf(session.idToken);
      if (!accountId) throw err('upstream_changed');
      const fields = {
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
        expiresAt: session.expiresAt,
        accountId,
      };
      const credentialId = await saveCodexDirectCred(fields);
      quotaCache.clear();
      return { status: 'complete', credentialId, accountId };
    },

    async getQuota() {
      return collectQuota();
    },
    async refreshQuota(accountId) {
      return collectQuota({ force: true, onlyAccountId: accountId ?? null });
    },

    listCredentials: () => store.index(),

    async saveCredential({ provider, alias, fields }) {
      const adapter = await getAdapter(provider);
      if (!adapter || hidden.has(provider)) {
        const err = new Error('unknown_provider');
        err.code = 'unknown_provider';
        throw err;
      }
      const clean = validateFields(adapter, fields);
      const cred = {
        id: uuid(),
        provider: adapter.id,
        kind: adapter.kind,
        alias: typeof alias === 'string' && alias.trim() ? alias.trim() : adapter.displayName,
        fields: clean,
        createdAt: Date.now(),
      };
      store.insert(cred);
      return { id: cred.id };
    },

    async updateCredential(id, { alias, fields }) {
      const cred = store.find(id);
      if (!cred) {
        const err = new Error('credential_not_found');
        err.code = 'credential_not_found';
        throw err;
      }
      let clean = null;
      if (fields && typeof fields === 'object') {
        const adapter = await getAdapter(cred.provider);
        clean = { ...cred.fields };
        for (const [k, v] of Object.entries(fields)) {
          if (typeof v === 'string' && v !== '') clean[k] = v;
        }
        if (adapter) clean = validateFields(adapter, clean);
      }
      store.patch(id, { alias, fields: clean });
      return { ok: true };
    },

    deleteCredential(id) {
      return { ok: store.remove(id) > 0 };
    },

    async listCodexAccounts(credId) {
      if (hidden.has('codex')) {
        const err = new Error('adapter_unavailable');
        err.code = 'adapter_unavailable';
        throw err;
      }
      const cred = store.find(credId);
      if (!cred || cred.provider !== 'codex') {
        const err = new Error('credential_not_found');
        err.code = 'credential_not_found';
        throw err;
      }
      const adapter = await getAdapter('codex');
      if (!adapter?.listAccounts) {
        const err = new Error('adapter_unavailable');
        err.code = 'adapter_unavailable';
        throw err;
      }
      return { accounts: await adapter.listAccounts(cred.fields) };
    },

    async saveCodexAccounts(credId, accounts) {
      if (hidden.has('codex')) {
        const err = new Error('adapter_unavailable');
        err.code = 'adapter_unavailable';
        throw err;
      }
      const cred = store.find(credId);
      if (!cred || cred.provider !== 'codex') {
        const err = new Error('credential_not_found');
        err.code = 'credential_not_found';
        throw err;
      }
      const adapter = await getAdapter('codex');
      if (!adapter?.listAccounts) {
        const err = new Error('adapter_unavailable');
        err.code = 'adapter_unavailable';
        throw err;
      }
      if (!Array.isArray(accounts)) {
        const err = new Error('bad_request');
        err.code = 'bad_request';
        throw err;
      }
      let remote;
      try {
        remote = await adapter.listAccounts(cred.fields);
      } catch (e) {
        const err = new Error(e instanceof QuotaError ? e.kind : 'unavailable');
        err.code = 'upstream';
        throw err;
      }
      const byIndex = new Map(remote.map((a) => [a.authIndex, a]));
      const records = [];
      for (const item of accounts) {
        if (!byIndex.has(item?.authIndex)) continue;
        const r = byIndex.get(item.authIndex);
        records.push({
          credId: cred.id,
          authIndex: item.authIndex,
          maskedEmail: r.maskedEmail,
          alias: typeof item.alias === 'string' && item.alias.trim() ? item.alias.trim() : r.maskedEmail,
        });
      }
      const count = store.setCodexAccounts(cred.id, records);
      quotaCache.clear();
      return { ok: true, count };
    },

    async discoverLocalCredentials() {
      const { discoverLocalCredentials } = await import('./discover.js');
      return discoverLocalCredentials(home ? { home } : {});
    },
  };
}
