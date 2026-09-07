// 核心 fetch 封装：白名单校验 + 10s 超时 + QuotaError 定义（契约 §Provider adapter 模块约定）

export class QuotaError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = 'QuotaError';
    this.kind = kind; // 'unavailable' | 'auth_expired' | 'rate_limited' | 'upstream_changed'
  }
}

const TIMEOUT_MS = 10_000;

function assertAllowed(adapter, req) {
  const url = new URL(req.url);
  // http 特例：CPA 管理口（127.0.0.1 本机 / host.docker.internal docker 网关，均不出宿主机）
  const isLoopbackHttp =
    url.protocol === 'http:' &&
    ['127.0.0.1:8317', '127.0.0.1', 'localhost', '[::1]', 'host.docker.internal:8317'].some(
      (h) => url.host === h || url.hostname === h,
    );
  if (url.protocol !== 'https:' && !isLoopbackHttp) {
    throw new QuotaError('unavailable', 'request url must be https');
  }
  const hit = (adapter.allowed ?? []).some((a) => {
    if (a.method !== req.method) return false;
    // host '*'：自建实例，host 由凭证提供（上面已强制 https/环回），路径仍须精确匹配代码固定值
    if (a.host === '*') return url.pathname === a.pathPrefix;
    return a.host === url.host && url.pathname.startsWith(a.pathPrefix);
  });
  if (!hit) throw new QuotaError('unavailable', `request not in ${adapter.id} allowlist`);
}

async function fetchOne(adapter, req) {
  assertAllowed(adapter, req);
  try {
    const res = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'error',
    });
    return { status: res.status, bodyText: await res.text() };
  } catch (e) {
    if (e instanceof QuotaError) throw e;
    throw new QuotaError('unavailable', `${adapter.id}: network error`);
  }
}

export async function executeAdapter(adapter, cred) {
  const main = await fetchOne(adapter, adapter.buildRequest(cred));
  // 附加请求（可选）：辅助信息（如套餐名），网络失败只降级不拖垮主请求；白名单违规照样抛
  let extras = null;
  if (typeof adapter.extraRequests === 'function') {
    extras = await Promise.all(
      adapter.extraRequests(cred).map(async (req) => {
        assertAllowed(adapter, req);
        try {
          const r = await fetchOne(adapter, req);
          return { id: req.id, status: r.status, bodyText: r.bodyText };
        } catch (e) {
          if (e instanceof QuotaError && e.kind !== 'unavailable') throw e;
          return { id: req.id, status: null, bodyText: null };
        }
      }),
    );
  }
  return adapter.parseResponse(main.status, main.bodyText, extras);
}
