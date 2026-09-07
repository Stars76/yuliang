// 桌面小组件数据桥（仅 Capacitor）：
//  - 每次取数后把额度快照（含 accountId + kind + 各窗口剩余百分比，绝不含密钥）写入 @capacitor/preferences
//    → SharedPreferences("CapacitorStorage"/"widget_snapshot")，原生小组件读取。
//  - 再调原生 QuotaWidget.notifyUpdate() 让全部已放置实例重绘。
import { Preferences } from '@capacitor/preferences';
import { registerPlugin } from '@capacitor/core';

const QuotaWidget = registerPlugin('QuotaWidget');
const KEY = 'widget_snapshot';

const ERR = { unavailable: '不可用', auth_expired: '凭证过期', rate_limited: '被限流', upstream_changed: '上游变更' };

function money(n, c) {
  const v = Number.isFinite(n) ? n : 0;
  return `${v.toFixed(2)} ${c || ''}`.trim();
}

export function buildSnapshot(accounts) {
  const items = (accounts || []).map((a) => {
    const base = { accountId: a.accountId, alias: a.alias, provider: a.provider, kind: a.kind === 'balance' ? 'balance' : 'quota', err: false };
    if (a.error) return { ...base, kind: 'quota', text: ERR[a.error.kind] || '异常', err: true, pct: null };
    if (a.kind === 'balance' && a.balance)
      return { ...base, kind: 'balance', text: money(a.balance.total, a.balance.currency), pct: null };
    // quota：主窗口（最紧张=usedPercent 最大）→ 剩余%，文本含窗口名；另给 inner/outer（5h/每周）供嵌套环
    const wins = (a.windows || []).filter((x) => x.usedPercent != null);
    if (wins.length === 0) return { ...base, text: a.plan || '—', pct: null };
    const main = wins.slice().sort((x, y) => y.usedPercent - x.usedPercent)[0];
    const rem = (p) => (p == null ? null : Math.max(0, Math.min(100, Math.round(100 - p))));
    const inner = wins.find((w) => /5小时|5h|5 小时/.test(w.name || '')) ?? wins[0];
    const outer = wins.find((w) => /每周|7天|7 天|周/.test(w.name || '')) ?? wins[wins.length - 1] ?? main;
    // 有"额度总量"的窗口（如 Command Code 月度 credits=10 USD）→ 显示「月限额 10 USD · 剩 82%」，而不是纯数字
    let text = `${main.name} 剩 ${rem(main.usedPercent)}%`;
    if (main.total != null) {
      const unit = main.unit || 'USD';
      const totalTxt = `${Number(main.total) % 1 === 0 ? Number(main.total) : Number(main.total).toFixed(2)} ${unit}`;
      text = `${/月/.test(main.name || '') ? '月限额' : `${main.name}限额`} ${totalTxt} · 剩 ${rem(main.usedPercent)}%`;
    }
    return {
      ...base,
      text,
      pct: rem(main.usedPercent),
      innerPct: rem(inner.usedPercent),
      outerPct: rem(outer.usedPercent),
    };
  });
  return { updated: Date.now(), items };
}

export async function publishSnapshot(accounts) {
  try {
    await Preferences.set({ key: KEY, value: JSON.stringify(buildSnapshot(accounts)) });
    await QuotaWidget.notifyUpdate();
  } catch {
    // 小组件为可选增强；失败不影响 App 本体
  }
}

// 主题跟随：App 内切换浅/深后通知所有已放置小组件用对应色板重绘（可选增强）
export async function notifyTheme(theme) {
  try {
    await QuotaWidget.notifyUpdate({ theme: theme === 'light' ? 'light' : 'dark' });
  } catch {}
}
