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
  openrouter: 'OpenRouter',
  sub2api: 'sub2api',
  newapi: 'New API',
};

export const ERROR_KINDS = {
  unavailable: { label: '不可用', cls: 'badge-red', hint: '网络不通或上游暂时故障，可稍后重试' },
  auth_expired: { label: '凭证过期', cls: 'badge-red', hint: '令牌已失效——到「凭证管理」更新 Key，或重新登录' },
  rate_limited: { label: '被限流', cls: 'badge-yellow', hint: '请求太频繁，等几分钟再刷新' },
  upstream_changed: { label: '上游变更', cls: 'badge-yellow', hint: '上游接口结构变化，等待应用更新适配' },
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

// ---- 用量阈值提醒（纯前端） ----
// 阈值：85/90/95，默认 90，存 localStorage（与主题/视图模式同机制）
export const THRESHOLD_OPTIONS = [85, 90, 95];
const THRESHOLD_KEY = 'qd-threshold';
export function getThreshold() {
  try {
    const v = Number(localStorage.getItem(THRESHOLD_KEY));
    return THRESHOLD_OPTIONS.includes(v) ? v : 90;
  } catch {
    return 90;
  }
}
export function setThreshold(v) {
  try {
    localStorage.setItem(THRESHOLD_KEY, String(v));
  } catch {}
}

// 一次性提醒已发记录：key = accountId|窗口名|resetAt，重置时间变化（新周期）即重新武装
export function getAlertedSet() {
  try {
    const arr = JSON.parse(localStorage.getItem('qd-alerted') || '[]');
    return Array.isArray(arr) ? new Set(arr.filter((x) => typeof x === 'string')) : new Set();
  } catch {
    return new Set();
  }
}
export function saveAlertedSet(set) {
  try {
    localStorage.setItem('qd-alerted', JSON.stringify([...set].slice(-400)));
  } catch {}
}

// 一次性提醒判定（纯函数，便于测试）：
// alerted = 已提醒过的 key 集合（key = `accountId|窗口名|resetAt`，新周期自动是新 key = 重新武装）
// 规则：用量 ≥ 阈值且未提醒 → 提醒；用量 < 阈值-5（滞后区间）→ 移出已提醒（重新武装）；区间内保持现状
export function evaluateAlerts(accounts, threshold, alerted) {
  const now = Date.now();
  const fire = [];
  const rearm = [];
  const seen = new Set();
  for (const a of accounts ?? []) {
    if (a.error) continue;
    for (const w of a.windows ?? []) {
      const p = w?.usedPercent;
      if (p == null || !Number.isFinite(p)) continue;
      const resetPart = w.resetAt != null ? String(w.resetAt) : 'none';
      const key = `${a.accountId}|${w.name}|${resetPart}`;
      seen.add(key);
      if (p >= threshold) {
        if (!alerted.has(key)) fire.push({ key, alias: a.alias, window: w.name, used: Math.round(p) });
      } else if (p < threshold - 5 && alerted.has(key)) {
        rearm.push(key);
      }
    }
  }
  // 清理已过期的旧周期 key（resetAt 已过 24h 以上的不再保留）
  const stale = [];
  for (const k of alerted) {
    const ts = Number(k.split('|')[2]);
    if (k.split('|')[2] !== 'none' && Number.isFinite(ts) && ts < now - 24 * 3600 * 1000 && !seen.has(k)) stale.push(k);
  }
  return { fire, rearm, stale };
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

// 移动端（Capacitor WebView）流畅模式：关掉毛玻璃/固定背景/持续动画。桌面不受影响。
export const isLite = () => typeof window !== 'undefined' && !!window.Capacitor;

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
