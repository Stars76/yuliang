// zai / bigmodel —— GET /api/monitor/usage/quota/limit（Authorization 裸 key，无 Bearer 前缀）
import { QuotaError } from './http.js';

const PATH = '/api/monitor/usage/quota/limit';

function clampPct(n) {
  return Math.min(100, Math.max(0, n));
}

// 按 unit/type 字段分类窗口；不要按 nextResetTime 排序区分（周期末尾会标反）
function classifyWindow(entry) {
  if (entry.type === 'TIME_LIMIT') return 'MCP(月)';
  if (entry.unit === 6) return '每周';
  if (entry.unit === 3 || entry.number === 5) return '5小时';
  return null; // 未知窗口类型跳过
}

function parseQuotaResponse(status, bodyText) {
  if (status === 401 || status === 403) throw new QuotaError('auth_expired', `zhipu http ${status}`);
  if (status === 429) throw new QuotaError('rate_limited', 'zhipu http 429');
  if (status !== 200) throw new QuotaError('unavailable', `zhipu http ${status}`);
  let json;
  try {
    json = JSON.parse(bodyText);
  } catch {
    throw new QuotaError('upstream_changed', 'zhipu: body is not json');
  }
  const data = json?.data;
  if (!data || typeof data !== 'object' || !Array.isArray(data.limits)) {
    throw new QuotaError('upstream_changed', 'zhipu: data.limits missing');
  }
  const windows = [];
  for (const entry of data.limits) {
    if (!entry || typeof entry !== 'object') continue;
    const name = classifyWindow(entry);
    if (!name) continue;
    if (typeof entry.percentage !== 'number' || !Number.isFinite(entry.percentage)) {
      throw new QuotaError('upstream_changed', `zhipu: ${name} percentage invalid`);
    }
    windows.push({
      name,
      usedPercent: clampPct(Math.round(entry.percentage)),
      used: null,
      total: null,
      unit: null,
      // 0% 时可能没有 nextResetTime
      resetAt: typeof entry.nextResetTime === 'number' ? entry.nextResetTime : null,
    });
  }
  if (windows.length === 0) throw new QuotaError('upstream_changed', 'zhipu: no recognizable windows');
  return { plan: typeof data.level === 'string' ? data.level : null, windows, error: null };
}

function makeAdapter({ id, displayName, host }) {
  return {
    id,
    displayName,
    kind: 'quota',
    credentialFields: [
      { key: 'apiKey', label: 'API Key', secret: true, required: true, placeholder: 'API Key' },
    ],
    allowed: [{ method: 'GET', host, pathPrefix: PATH }],
    buildRequest(cred) {
      return {
        method: 'GET',
        url: `https://${host}${PATH}`,
        // 裸 key，没有 Bearer 前缀
        headers: { authorization: cred.apiKey, accept: 'application/json' },
      };
    },
    parseResponse: parseQuotaResponse,
  };
}

const zai = makeAdapter({ id: 'zai', displayName: 'Z.ai (GLM Coding Plan)', host: 'api.z.ai' });

export const bigmodel = makeAdapter({
  id: 'bigmodel',
  displayName: '智谱 BigModel',
  host: 'open.bigmodel.cn',
});

export default zai;
