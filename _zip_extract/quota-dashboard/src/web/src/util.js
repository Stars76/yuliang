export const PROVIDER_LABELS = {
  codex: 'Codex (CPA)',
  'codex-direct': 'Codex（直连）',
  ollama: 'Ollama Cloud',
  'command-code': 'Command Code',
  'opencode-go': 'OpenCode（自动识别 Go / Zen）',
  kimi: 'Kimi For Coding',
  zai: 'Z.AI',
  bigmodel: '智谱 BigModel',
  deepseek: 'DeepSeek',
  sub2api: 'sub2api',
  newapi: 'New API',
};

export const ERROR_KINDS = {
  unavailable: { label: '不可用', cls: 'badge-red' },
  auth_expired: { label: '凭证过期', cls: 'badge-red' },
  rate_limited: { label: '被限流', cls: 'badge-yellow' },
  upstream_changed: { label: '上游变更', cls: 'badge-yellow' },
};

export function fmtCountdown(ms) {
  if (ms <= 0) return '已到点';
  const totalMin = Math.floor(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h`;
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

export function fmtAgo(ts, now) {
  const diff = now - ts;
  if (diff < 30000) return '刚刚';
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}

export function fmtTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function fmtMoney(n, currency) {
  const v = Number.isFinite(n) ? n : 0;
  return `${v.toFixed(2)} ${currency || ''}`.trim();
}

export function windowLevel(percent) {
  if (percent == null) return 'none';
  if (percent > 95) return 'danger';
  if (percent > 80) return 'warn';
  return 'ok';
}

// 主题：'light' | 'dark'，index.html 内联脚本已在首帧前设置 data-theme
export function getTheme() {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

export function setTheme(t) {
  document.documentElement.dataset.theme = t;
  try {
    localStorage.setItem('qd-theme', t);
  } catch {}
}

// 进度显示方式：'bar' 条形（默认）| 'ring' 单圆环 | 'nested' 嵌套圆环（大环包小环）
export function getProgressMode() {
  try {
    const v = localStorage.getItem('qd-progress-mode');
    return v === 'ring' || v === 'nested' ? v : 'bar';
  } catch {
    return 'bar';
  }
}

export function setProgressMode(m) {
  try {
    localStorage.setItem('qd-progress-mode', m);
  } catch {}
}

// 分组显示顺序：空数组回退到 PROVIDER_LABELS 声明序
export function getGroupOrder() {
  try {
    const v = JSON.parse(localStorage.getItem('qd-group-order') || 'null');
    return Array.isArray(v) ? v.filter((id) => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

export function setGroupOrder(list) {
  try {
    localStorage.setItem('qd-group-order', JSON.stringify(list));
  } catch {}
}

// 仪表盘显示模式：'group' 分组显示（默认）| 'overview' 账户总览（无分组，紧凑）
export function getViewMode() {
  try {
    const v = localStorage.getItem('qd-view-mode');
    return v === 'overview' ? 'overview' : 'group';
  } catch {
    return 'group';
  }
}

export function setViewMode(m) {
  try {
    localStorage.setItem('qd-view-mode', m);
  } catch {}
}

// 账户总览的账号顺序（拖拽）；空数组 = 跟随分组内顺序
export function getAccountOrder() {
  try {
    const v = JSON.parse(localStorage.getItem('qd-account-order') || 'null');
    return Array.isArray(v) ? v.filter((id) => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

export function setAccountOrder(list) {
  try {
    localStorage.setItem('qd-account-order', JSON.stringify(list));
  } catch {}
}

// 单个全局秒级心跳，所有倒计时/相对时间共用
const tickSubs = new Set();
let tickTimer = null;
export function subscribeTick(fn) {
  tickSubs.add(fn);
  if (!tickTimer) tickTimer = setInterval(() => tickSubs.forEach((f) => f()), 1000);
  return () => {
    tickSubs.delete(fn);
    if (tickSubs.size === 0 && tickTimer) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
  };
}
