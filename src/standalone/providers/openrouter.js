// OpenRouter —— kind:'balance'，GET https://openrouter.ai/api/v1/credits（Bearer，官方文档化）
// 响应：{data:{total_credits, total_usage}}（美元）；余额 = total_credits - total_usage
// 依据上游契约：total_credits 为购入总额度，total_usage 为已消耗；均为数值。
import { QuotaError } from './http.js';

function toUsd(v, field) {
  const n = typeof v === 'number' ? v : parseFloat(v);
  if (!Number.isFinite(n) || n < 0) throw new QuotaError('upstream_changed', `openrouter: ${field} invalid`);
  return n;
}

export default {
  id: 'openrouter',
  displayName: 'OpenRouter',
  kind: 'balance',
  credentialFields: [
    { key: 'apiKey', label: 'API Key', secret: true, required: true, placeholder: 'sk-or-v1-...' },
  ],
  allowed: [{ method: 'GET', host: 'openrouter.ai', pathPrefix: '/api/v1/credits' }],
  buildRequest(cred) {
    return {
      method: 'GET',
      url: 'https://openrouter.ai/api/v1/credits',
      headers: {
        authorization: `Bearer ${cred.apiKey}`,
        accept: 'application/json',
      },
    };
  },
  parseResponse(status, bodyText) {
    if (status === 401 || status === 403) throw new QuotaError('auth_expired', `openrouter http ${status}`);
    if (status === 429) throw new QuotaError('rate_limited', 'openrouter http 429');
    if (status !== 200) throw new QuotaError('unavailable', `openrouter http ${status}`);
    let json;
    try {
      json = JSON.parse(bodyText);
    } catch {
      throw new QuotaError('upstream_changed', 'openrouter: body is not json');
    }
    const d = json?.data;
    if (!d || typeof d !== 'object' || (d.total_credits == null && d.total_usage == null)) {
      throw new QuotaError('upstream_changed', 'openrouter: missing data.total_credits/total_usage');
    }
    const total = toUsd(d.total_credits, 'total_credits');
    const used = toUsd(d.total_usage, 'total_usage');
    if (used > total) throw new QuotaError('upstream_changed', 'openrouter: usage exceeds credits');
    return {
      plan: null,
      windows: [],
      balance: {
        currency: 'USD',
        total: Math.round((total - used) * 100) / 100,
        granted: null,
        paid: null,
        used,
      },
      error: null,
    };
  },
};
