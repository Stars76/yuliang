export class ApiError extends Error {
  constructor(status, code, message, retryAfterSec = null) {
    super(message || code || `HTTP ${status}`);
    this.status = status;
    this.code = code;
    this.retryAfterSec = retryAfterSec;
  }
}

let onUnauthorized = null;
export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn;
}

async function request(method, path, body, opts = {}) {
  const headers = { Accept: 'application/json' };
  if (method !== 'GET') {
    headers['X-Requested-With'] = 'quota-dashboard';
    if (body !== undefined) headers['Content-Type'] = 'application/json';
  }
  let res;
  try {
    res = await fetch(path, {
      method,
      headers,
      credentials: 'same-origin',
      body: body !== undefined ? JSON.stringify(body) : undefined,
      ...opts,
    });
  } catch (e) {
    throw new ApiError(0, 'network_error', '网络错误，请检查连接');
  }
  if (res.status === 401 && !path.startsWith('/api/auth/login') && !path.startsWith('/api/auth/recover')) {
    if (onUnauthorized) onUnauthorized();
  }
  const ct = res.headers.get('content-type') || '';
  let data = null;
  if (ct.includes('application/json')) {
    data = await res.json().catch(() => null);
  }
  if (!res.ok) {
    const code = data?.error || `http_${res.status}`;
    const retry = Number.isFinite(data?.retryAfterSec) ? data.retryAfterSec : null;
    let message = data?.message || msgFor(code);
    if ((code === 'locked' || code === 'rate_limited') && retry) message = `${message}（约 ${retry} 秒后）`;
    throw new ApiError(res.status, code, message, retry);
  }
  return data;
}

function msgFor(code) {
  const map = {
    step_up_failed: '密码或动态验证码错误',
    invalid_backup: '备份文件无效或导出密码错误',
    network_error: '网络错误，请检查连接',
    rate_limited: '请求过于频繁，请稍后再试',
    locked: '已锁定，请稍后再试',
    invalid_recovery_code: '用户名或恢复码无效',
    invalid_username: '用户名格式不正确（3-20 位字母、数字、. _ -）',
    username_taken: '该用户名已被注册',
    weak_password: '密码至少 8 位',
    account_disabled: '账号已被禁用，请联系管理员',
    forbidden: '没有权限执行此操作',
    totp_code_invalid: '动态验证码错误',
    totp_pending_expired: '绑定已过期，请重新发起',
  };
  return map[code] || `请求失败（${code}）`;
}

export const api = {
  status: () => request('GET', '/api/auth/status'),
  login: (username, password) => request('POST', '/api/auth/login', { username, password }),
  register: (username, password) => request('POST', '/api/auth/register', { username, password }),
  logout: () => request('POST', '/api/auth/logout'),

  quota: () => request('GET', '/api/quota'),
  refreshQuota: (accountId) =>
    request('POST', '/api/quota/refresh', accountId ? { accountId } : {}),

  credentials: () => request('GET', '/api/credentials'),
  credentialMeta: () => request('GET', '/api/credentials/meta'),
  createCredential: (payload) => request('POST', '/api/credentials', payload),
  updateCredential: (id, payload) => request('PUT', `/api/credentials/${id}`, payload),
  deleteCredential: (id, payload) =>
    request('DELETE', `/api/credentials/${id}`, payload),

  codexAccounts: (credId) => request('GET', `/api/codex/accounts?credId=${encodeURIComponent(credId)}`),
  saveCodexAccounts: (payload) => request('POST', '/api/codex/accounts', payload),
  codexLogin: () => request('POST', '/api/codex-direct/login'),
  codexLoginStatus: (loginToken) => request('GET', `/api/codex-direct/login/status?loginToken=${encodeURIComponent(loginToken)}`),

  audit: (limit = 200) => request('GET', `/api/audit?limit=${limit}`),

  changePassword: (payload) => request('POST', '/api/auth/change-password', payload),
  revokeOthers: (payload) => request('POST', '/api/auth/revoke-others', payload),
  importBackup: (payload) => request('POST', '/api/import', payload),

  totpBegin: (payload) => request('POST', '/api/auth/totp/begin', payload),
  totpConfirm: (payload) => request('POST', '/api/auth/totp/confirm', payload),
  totpDisable: (payload) => request('POST', '/api/auth/totp/disable', payload),

  listUsers: () => request('GET', '/api/users'),
  disableUser: (username) => request('POST', `/api/users/${encodeURIComponent(username)}/disable`),
  enableUser: (username) => request('POST', `/api/users/${encodeURIComponent(username)}/enable`),
  deleteUser: (username) => request('DELETE', `/api/users/${encodeURIComponent(username)}`),

  recover: (username, recoveryCode) => request('POST', '/api/auth/recover', { username, recoveryCode }),
  recoverComplete: (payload) => request('POST', '/api/auth/recover/complete', payload),
};

export async function exportBackup(payload) {
  let res;
  try {
    res = await fetch('/api/export', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'quota-dashboard',
      },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    throw new ApiError(0, 'network_error', '网络错误，请检查连接');
  }
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new ApiError(res.status, data?.error, data?.message || msgFor(data?.error));
  }
  const blob = await res.blob();
  const a = document.createElement('a');
  const url = URL.createObjectURL(blob);
  a.href = url;
  a.download = `quota-backup-${new Date().toISOString().slice(0, 10)}.enc`;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  // 延迟到下载真正开始后再清理，避免同步移除 anchor / revoke 取消尚未启动的下载（Firefox/Safari）
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 1000);
}
