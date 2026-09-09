// New API / One API 系自建站 —— kind:'balance'，GET {instanceUrl}/api/user/self
// 鉴权：Authorization: Bearer <系统访问令牌> + New-Api-User: <用户ID>（均在该站个人设置页生成/查看）
// 响应：{success:true, data:{username, quota, used_quota, ...}}；额度单位 500000 = 1 USD
import { QuotaError, parseJson } from './http.js';

export const QUOTA_PER_USD = 500000;

// 站点地址校验（与 sub2api 同约定）：仅 https（环回允许 http），不允许 userinfo/fragment
export function parseInstanceUrl(raw) {
  let url;
  try {
    url = new URL(String(raw ?? '').trim());
  } catch {
    throw new QuotaError('upstream_changed', 'newapi: instanceUrl 不是合法 URL');
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new QuotaError('upstream_changed', 'newapi: instanceUrl 必须是 https（环回允许 http）');
  }
  if (url.username || url.password || url.hash) {
    throw new QuotaError('upstream_changed', 'newapi: instanceUrl 不允许携带凭证或 fragment');
  }
  return url.origin;
}

function toUsd(v, field) {
  const n = typeof v === 'number' ? v : parseFloat(v);
  if (!Number.isFinite(n) || n < 0) throw new QuotaError('upstream_changed', `newapi: ${field} invalid`);
  return n / QUOTA_PER_USD;
}

export default {
  id: 'newapi',
  displayName: 'New API',
  kind: 'balance',
  credentialFields: [
    { key: 'instanceUrl', label: '站点地址', secret: false, required: true, placeholder: 'https://api.example.com' },
    { key: 'userId', label: '用户 ID', secret: false, required: true, placeholder: '个人设置页顶部的数字 ID' },
    { key: 'accessToken', label: '系统访问令牌', secret: true, required: true, placeholder: '个人设置页生成' },
  ],
  // host '*' = 自建站：host 由凭证提供（强制 https/环回），方法与路径仍由代码固定
  allowed: [{ method: 'GET', host: '*', pathPrefix: '/api/user/self' }],
  buildRequest(cred) {
    return {
      method: 'GET',
      url: `${parseInstanceUrl(cred.instanceUrl)}/api/user/self`,
      headers: {
        authorization: `Bearer ${cred.accessToken}`,
        'new-api-user': String(cred.userId ?? ''),
        accept: 'application/json',
      },
    };
  },
  parseResponse(status, bodyText) {
    const json = parseJson(status, bodyText, 'newapi');
    if (!json || typeof json !== 'object') {
      throw new QuotaError('upstream_changed', 'newapi: body is not an object');
    }
    if (json.success !== true || !json.data || typeof json.data !== 'object') {
      throw new QuotaError('auth_expired', 'newapi: success=false（令牌或用户 ID 无效）');
    }
    const d = json.data;
    return {
      plan: typeof d.username === 'string' && d.username ? d.username : null,
      windows: [],
      balance: {
        currency: 'USD',
        total: toUsd(d.quota, 'quota'),
        granted: null,
        paid: null,
        used: toUsd(d.used_quota, 'used_quota'),
      },
      error: null,
    };
  },
};
