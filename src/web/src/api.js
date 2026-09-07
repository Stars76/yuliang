// 单机版前端数据层。两种宿主共用同一份 React 构建：
//  • Electron：从 http://127.0.0.1:<port> 同源加载，走相对路径 REST（loopback server）。
//  • Capacitor(WebView)：无 Node，桥（src/standalone/capacitor/bridge.js）把引擎注入 globalThis.__QUOTA_ENGINE__，此处直接调用引擎。
// 无登录/会话/CSRF/TOTP/审计/用户管理等账户体系调用。
export class ApiError extends Error {
  constructor(status, code, message) {
    super(message || code || `HTTP ${status}`);
    this.status = status;
    this.code = code;
  }
}

function msgFor(code) {
  const map = {
    network_error: '本地服务连接失败',
    unknown_provider: '未知的 provider',
    invalid_fields: '凭证字段不完整',
    credential_not_found: '凭证不存在',
    account_not_found: '账号不存在',
    adapter_unavailable: 'provider 适配器不可用',
    upstream: '上游取数失败',
    auth_expired: '凭证已过期',
    rate_limited: '被限流，请稍后再试',
    unavailable: '暂不可用',
    upstream_changed: '上游响应结构变更',
  };
  return map[code] || (code ? `请求失败（${code}）` : '请求失败');
}

async function request(method, path, body) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch {
    throw new ApiError(0, 'network_error', '本地服务连接失败');
  }
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('application/json') ? await res.json().catch(() => null) : null;
  if (!res.ok) throw new ApiError(res.status, data?.error || `http_${res.status}`, msgFor(data?.error));
  return data;
}

// 引擎直连（Capacitor）：把引擎抛出的 {code} 归一成 ApiError，返回体与 REST 端点对齐。
const E = () => globalThis.__QUOTA_ENGINE__;
async function call(fn) {
  try {
    return await fn();
  } catch (e) {
    const code = e?.code ?? (e?.name === 'QuotaError' ? e.kind : undefined);
    throw new ApiError(0, code ?? 'internal', msgFor(code));
  }
}

const restApi = {
  quota: () => request('GET', '/api/quota'),
  refreshQuota: (accountId) => request('POST', '/api/quota/refresh', accountId ? { accountId } : {}),
  credentials: () => request('GET', '/api/credentials'),
  credentialMeta: () => request('GET', '/api/credentials/meta'),
  createCredential: (payload) => request('POST', '/api/credentials', payload),
  updateCredential: (id, payload) => request('PUT', `/api/credentials/${id}`, payload),
  deleteCredential: (id) => request('DELETE', `/api/credentials/${id}`),
  discover: () => request('GET', '/api/discover'),
  codexLogin: () => request('POST', '/api/codex-direct/login', {}),
  codexLoginStatus: (loginToken) => request('GET', `/api/codex-direct/login/status?loginToken=${encodeURIComponent(loginToken)}`),
  codexAccounts: (credId) => request('GET', `/api/codex/accounts?credId=${encodeURIComponent(credId)}`),
  saveCodexAccounts: (payload) => request('POST', '/api/codex/accounts', payload),
};

const engineApi = {
  quota: () => call(async () => ({ accounts: await E().getQuota() })),
  refreshQuota: (accountId) => call(async () => ({ accounts: await E().refreshQuota(accountId) })),
  credentials: () => call(async () => E().listCredentials()),
  credentialMeta: () => call(async () => E().listProvidersMeta()),
  createCredential: (payload) => call(async () => E().saveCredential(payload)),
  updateCredential: (id, payload) => call(async () => E().updateCredential(id, payload)),
  deleteCredential: (id) => call(async () => E().deleteCredential(id)),
  discover: () => call(async () => E().discoverLocalCredentials()),
  codexLogin: () => call(async () => E().codexDirectStart()),
  codexLoginStatus: (loginToken) => call(async () => E().codexDirectPoll(loginToken)),
  codexAccounts: (credId) => call(async () => E().listCodexAccounts(credId)),
  saveCodexAccounts: ({ credId, accounts }) => call(async () => E().saveCodexAccounts(credId, accounts)),
};

// 每次调用时再选传输层：安卓 Capacitor 里 __QUOTA_ENGINE__ 是异步 bootstrap 后才注入的，
// 若在模块加载期一次性绑定会误锁到 restApi（→ 去 fetch 不存在的本地服务）。
const pick = () => (globalThis.__QUOTA_ENGINE__ ? engineApi : restApi);
export const api = {
  quota: (...a) => pick().quota(...a),
  refreshQuota: (...a) => pick().refreshQuota(...a),
  credentials: (...a) => pick().credentials(...a),
  credentialMeta: (...a) => pick().credentialMeta(...a),
  createCredential: (...a) => pick().createCredential(...a),
  updateCredential: (...a) => pick().updateCredential(...a),
  deleteCredential: (...a) => pick().deleteCredential(...a),
  discover: (...a) => pick().discover(...a),
  codexLogin: (...a) => pick().codexLogin(...a),
  codexLoginStatus: (...a) => pick().codexLoginStatus(...a),
  codexAccounts: (...a) => pick().codexAccounts(...a),
  saveCodexAccounts: (...a) => pick().saveCodexAccounts(...a),
};
