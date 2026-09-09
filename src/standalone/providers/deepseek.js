// DeepSeek —— kind:'balance'，GET https://api.deepseek.com/user/balance（Bearer）
// 官方响应：{is_available: boolean, balance_infos: [{currency, total_balance, granted_balance, topped_up_balance}]}（金额为字符串）
import { QuotaError, parseJson } from './http.js';

const ENDPOINT = 'https://api.deepseek.com/user/balance';

function toAmount(v, field) {
  const n = typeof v === 'number' ? v : parseFloat(v);
  if (!Number.isFinite(n)) throw new QuotaError('upstream_changed', `deepseek: ${field} invalid`);
  return n;
}

export default {
  id: 'deepseek',
  displayName: 'DeepSeek',
  kind: 'balance',
  credentialFields: [
    { key: 'apiKey', label: 'API Key', secret: true, required: true, placeholder: 'sk-...' },
  ],
  allowed: [{ method: 'GET', host: 'api.deepseek.com', pathPrefix: '/user/balance' }],
  buildRequest(cred) {
    return {
      method: 'GET',
      url: ENDPOINT,
      headers: { authorization: `Bearer ${cred.apiKey}`, accept: 'application/json' },
    };
  },
  parseResponse(status, bodyText) {
    const json = parseJson(status, bodyText, 'deepseek');
    if (!json || typeof json !== 'object') {
      throw new QuotaError('upstream_changed', 'deepseek: body is not an object');
    }
    if (json.is_available === false) {
      throw new QuotaError('unavailable', 'deepseek: balance insufficient / unavailable');
    }
    const infos = json.balance_infos;
    if (!Array.isArray(infos) || infos.length === 0 || !infos[0] || typeof infos[0] !== 'object') {
      throw new QuotaError('upstream_changed', 'deepseek: balance_infos missing');
    }
    const b0 = infos[0];
    return {
      plan: null,
      windows: [],
      balance: {
        currency: String(b0.currency ?? ''),
        total: toAmount(b0.total_balance, 'total_balance'),
        granted: toAmount(b0.granted_balance, 'granted_balance'),
        paid: toAmount(b0.topped_up_balance, 'topped_up_balance'),
      },
      error: null,
    };
  },
};
