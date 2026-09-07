import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import {
  ERROR_KINDS,
  PROVIDER_LABELS,
  fmtAgo,
  fmtCountdown,
  fmtMoney,
  fmtTime,
  getProgressMode,
  setProgressMode,
  getGroupOrder,
  setGroupOrder,
  getViewMode,
  setViewMode,
  getAccountOrder,
  setAccountOrder,
  subscribeTick,
  windowLevel,
  THRESHOLD_OPTIONS,
  getThreshold,
  setThreshold,
  getAlertedSet,
  saveAlertedSet,
  evaluateAlerts,
} from '../util.js';
import { EmptyState, SkeletonCard, useToast } from '../components/Toast.jsx';

const PROGRESS_MODES = [
  { id: 'bar', label: '条形' },
  { id: 'ring', label: '圆环' },
  { id: 'nested', label: '嵌套环' },
];

const VIEW_MODES = [
  { id: 'group', label: '分组' },
  { id: 'overview', label: '总览' },
];

export default function Dashboard() {
  const [accounts, setAccounts] = useState(null);
  const [lastRefresh, setLastRefresh] = useState(null);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [progMode, setProgModeState] = useState(getProgressMode);
  const [viewMode, setViewModeState] = useState(getViewMode);
  const [groupOrder, setGroupOrderState] = useState(getGroupOrder);
  const [accountOrder, setAccountOrderState] = useState(getAccountOrder);
  const [collapsed, setCollapsed] = useState({}); // provider -> boolean
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [threshold, setThresholdState] = useState(getThreshold);
  const [nearLimitIds, setNearLimitIds] = useState(() => new Set());
  const toast = useToast();
  const firedRef = useRef(new Set());
  const dragProviderRef = useRef(null);
  const dragAccountRef = useRef(null);

  const groups = useMemo(() => (accounts ? groupAccounts(accounts, groupOrder) : []), [accounts, groupOrder]);
  const overviewAccounts = useMemo(() => {
    if (!accounts) return [];
    if (accountOrder.length === 0) return accounts;
    const byId = new Map(accounts.map((a) => [a.accountId, a]));
    const ordered = accountOrder.map((id) => byId.get(id)).filter(Boolean);
    const rest = accounts.filter((a) => !accountOrder.includes(a.accountId));
    return [...ordered, ...rest];
  }, [accounts, accountOrder]);

  // 阈值提醒检测：每次数据到达后跑一次；fire 弹 Toast（一次性），rearm/stale 维护已提醒集合
  const alertedRef = useRef(getAlertedSet());
  useEffect(() => {
    if (!accounts) return;
    const { fire, rearm, stale } = evaluateAlerts(accounts, threshold, alertedRef.current);
    if (fire.length > 0) {
      for (const f of fire) {
        alertedRef.current.add(f.key);
        toast(`${f.alias} 的「${f.window}」窗口已用 ${f.used}%，即将打满`, 'warn');
      }
      saveAlertedSet(alertedRef.current);
    }
    if (rearm.length > 0 || stale.length > 0) {
      for (const k of rearm) alertedRef.current.delete(k);
      for (const k of stale) alertedRef.current.delete(k);
      saveAlertedSet(alertedRef.current);
    }
    const ids = new Set();
    for (const a of accounts) {
      if (a.error) continue;
      if ((a.windows ?? []).some((w) => w.usedPercent != null && w.usedPercent >= threshold)) ids.add(a.accountId);
    }
    setNearLimitIds((prev) => {
      if (prev.size === ids.size && [...ids].every((x) => prev.has(x))) return prev;
      return ids;
    });
  }, [accounts, threshold, toast]);

  const load = useCallback(async (silent) => {
    try {
      const data = await api.quota();
      setAccounts(data.accounts);
      setLastRefresh(Date.now());
      firedRef.current.clear();
    } catch (ex) {
      if (!silent) toast(ex.message || '拉取额度失败');
    }
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  // 统一心跳：驱动倒计时 / 相对时间 / 重置到点检测
  useEffect(
    () =>
      subscribeTick(() => {
        const t = Date.now();
        setNow(t);
        if (accounts) {
          for (const a of accounts) {
            for (const w of a.windows) {
              if (w.resetAt && w.resetAt <= t && !firedRef.current.has(a.accountId)) {
                firedRef.current.add(a.accountId);
                refreshAccount(a.accountId);
                break;
              }
            }
          }
        }
      }),
    [accounts]
  );

  // 自动刷新（5 分钟）
  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(() => load(true), 5 * 60 * 1000);
    return () => clearInterval(id);
  }, [autoRefresh, load]);

  async function refreshAll() {
    setRefreshing(true);
    try {
      await api.refreshQuota();
      await load(true);
      toast('已触发全量刷新', 'ok');
    } catch (ex) {
      toast(ex.message || '刷新失败');
    } finally {
      setRefreshing(false);
    }
  }

  async function refreshAccount(accountId) {
    try {
      await api.refreshQuota(accountId);
      await load(true);
    } catch (ex) {
      toast(ex.message || '刷新失败');
    }
  }

  function setMode(m) {
    setViewModeState(m);
    setViewMode(m);
  }

  // 拖拽重排分组：把 fromProvider 移到 toProvider 位置
  function reorderGroups(fromProvider, toProvider) {
    if (fromProvider === toProvider) return;
    const current = groups.map((g) => g.provider);
    const i = current.indexOf(fromProvider);
    const j = current.indexOf(toProvider);
    if (i < 0 || j < 0) return;
    const next = [...current];
    next.splice(i, 1);
    next.splice(j, 0, fromProvider);
    setGroupOrderState(next);
    setGroupOrder(next);
  }

  // 拖拽重排总览账号：把 fromId 移到 toId 位置
  function reorderAccounts(fromId, toId) {
    if (fromId === toId) return;
    const current = overviewAccounts.map((a) => a.accountId);
    const i = current.indexOf(fromId);
    const j = current.indexOf(toId);
    if (i < 0 || j < 0) return;
    const next = [...current];
    next.splice(i, 1);
    next.splice(j, 0, fromId);
    setAccountOrderState(next);
    setAccountOrder(next);
  }

  const dragGroupProps = (provider) => ({
    draggable: true,
    onDragStart: (e) => { dragProviderRef.current = provider; e.dataTransfer.effectAllowed = 'move'; },
    onDragOver: (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; },
    onDrop: (e) => { e.preventDefault(); if (dragProviderRef.current && dragProviderRef.current !== provider) reorderGroups(dragProviderRef.current, provider); dragProviderRef.current = null; },
    onDragEnd: () => { dragProviderRef.current = null; },
  });

  const dragAccountProps = (id) => ({
    draggable: true,
    onDragStart: (e) => { dragAccountRef.current = id; e.dataTransfer.effectAllowed = 'move'; },
    onDragOver: (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; },
    onDrop: (e) => { e.preventDefault(); if (dragAccountRef.current && dragAccountRef.current !== id) reorderAccounts(dragAccountRef.current, id); dragAccountRef.current = null; },
    onDragEnd: () => { dragAccountRef.current = null; },
  });

  return (
    <div>
      <div className="dash-toolbar">
        <div className="dash-toolbar-left">
          <button className="btn btn-primary" onClick={refreshAll} disabled={refreshing}>
            {refreshing ? '刷新中…' : '刷新'}
          </button>
          <label className="switch-row">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
            />
            <span>自动刷新（5 分钟）</span>
          </label>
          {lastRefresh && (
            <span className="muted small tabular">上次刷新 {fmtTime(lastRefresh)}</span>
          )}
          <div className="seg" role="group" aria-label="进度显示方式">
            {PROGRESS_MODES.map((m) => (
              <button
                key={m.id}
                className={`seg-btn${progMode === m.id ? ' active' : ''}`}
                aria-pressed={progMode === m.id}
                onClick={() => {
                  setProgressMode(m.id);
                  setProgModeState(m.id);
                }}
              >
                {m.label}
              </button>
            ))}
          </div>
          <div className="seg" role="group" aria-label="账户显示方式">
            {VIEW_MODES.map((m) => (
              <button
                key={m.id}
                className={`seg-btn${viewMode === m.id ? ' active' : ''}`}
                aria-pressed={viewMode === m.id}
                onClick={() => setMode(m.id)}
              >
                {m.label}
              </button>
            ))}
          </div>
          <label className="switch-row threshold-ctl" title="用量达到该比例时提醒">
            <span>提醒阈值</span>
            <select
              className="threshold-select"
              value={threshold}
              onChange={(e) => {
                const v = Number(e.target.value);
                setThreshold(v);
                setThresholdState(v);
              }}
            >
              {THRESHOLD_OPTIONS.map((v) => (
                <option key={v} value={v}>
                  {v}%
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {accounts === null ? (
        <div className="card-grid">
          {Array.from({ length: 4 }).map((_, i) => (
            <SkeletonCard key={i} />
          ))}
        </div>
      ) : accounts.length === 0 ? (
        <EmptyState title="暂无账号" hint="请到「凭证管理」添加第一个账号" />
      ) : viewMode === 'overview' ? (
        <>
          <Overview accounts={accounts} />
          <div className="card-grid overview-grid">
            {overviewAccounts.map((a) => (
              <div key={a.accountId} {...dragAccountProps(a.accountId)}>
                <AccountCard account={a} now={now} progMode={progMode} near={nearLimitIds.has(a.accountId)} onRetry={() => refreshAccount(a.accountId)} />
              </div>
            ))}
          </div>
        </>
      ) : (
        <>
          <Overview accounts={accounts} />
          {groups.map((g) => (
            <section className={`acct-group${collapsed[g.provider] ? ' collapsed' : ''}`} key={g.provider} {...dragGroupProps(g.provider)}>
              <div className="group-head">
                <button
                  className={`group-toggle${collapsed[g.provider] ? ' closed' : ''}`}
                  aria-expanded={!collapsed[g.provider]}
                  onClick={() => setCollapsed((s) => ({ ...s, [g.provider]: !s[g.provider] }))}
                >
                  <i className="chev" aria-hidden="true" />
                </button>
                <span className="provider-badge" data-p={g.provider}>
                  {PROVIDER_LABELS[g.provider] || g.provider}
                </span>
                <span className="muted small">{g.list.length} 个账号</span>
                {g.errors > 0 && <span className="badge badge-red">{g.errors} 异常</span>}
                <span className="group-line" aria-hidden="true" />
              </div>
              {!collapsed[g.provider] && (
                <div className="card-grid">
                  {g.list.map((a) => (
                    <AccountCard key={a.accountId} account={a} now={now} progMode={progMode} near={nearLimitIds.has(a.accountId)} onRetry={() => refreshAccount(a.accountId)} />
                  ))}
                </div>
              )}
            </section>
          ))}
        </>
      )}
    </div>
  );
}

// 按 provider 分组：优先用户排序（groupOrder），未排序/未知名排最后
function groupAccounts(accounts, groupOrder = []) {
  const order = groupOrder.length ? groupOrder : Object.keys(PROVIDER_LABELS);
  const map = new Map();
  for (const a of accounts) {
    if (!map.has(a.provider)) map.set(a.provider, []);
    map.get(a.provider).push(a);
  }
  return [...map.entries()]
    .sort(([x], [y]) => {
      const ix = order.includes(x) ? order.indexOf(x) : order.length;
      const iy = order.includes(y) ? order.indexOf(y) : order.length;
      return ix - iy;
    })
    .map(([provider, list]) => ({ provider, list, errors: list.filter((a) => a.error).length }));
}

// 数字滚动 / 进度生长共用：rAF 补间到目标值；挂载时从 0 生长；prefers-reduced-motion 直接跳变
function useCountUp(target, duration = 700) {
  const [value, setValue] = useState(0);
  const prevRef = useRef(null);
  useEffect(() => {
    if (target == null || !Number.isFinite(target)) {
      prevRef.current = null;
      setValue(0);
      return;
    }
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const from = prevRef.current ?? 0;
    prevRef.current = target;
    if (reduced || from === target) {
      setValue(target);
      return;
    }
    let raf = 0;
    const t0 = performance.now();
    const tick = (t) => {
      const k = Math.min(1, (t - t0) / duration);
      const e = 1 - Math.pow(1 - k, 3); // easeOutCubic
      setValue(from + (target - from) * e);
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);
  return target == null ? null : value;
}

const OV_ICONS = {
  total: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  ),
  ok: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M8.5 12.2l2.4 2.4 4.6-4.9" />
    </svg>
  ),
  err: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3.5 2.8 19.5h18.4L12 3.5z" />
      <path d="M12 10v4" />
      <path d="M12 17h.01" />
    </svg>
  ),
};

function Overview({ accounts }) {
  const total = accounts.length;
  const errors = accounts.filter((a) => a.error).length;
  const ok = total - errors;
  const aTotal = useCountUp(total);
  const aOk = useCountUp(ok);
  const aErr = useCountUp(errors);
  const okPct = total > 0 ? (ok / total) * 100 : 0;
  const items = [
    { icon: OV_ICONS.total, cls: 'ic-accent', value: Math.round(aTotal), label: '账号总数', valCls: '' },
    { icon: OV_ICONS.ok, cls: 'ic-green', value: Math.round(aOk), label: '正常', valCls: 'ok' },
    { icon: OV_ICONS.err, cls: 'ic-red', value: Math.round(aErr), label: '异常', valCls: 'err' },
  ];
  return (
    <div className="overview">
      <div className="ov-stats">
        {items.map((it) => (
          <div className="ov-item" key={it.label}>
            <span className={`ov-icon ${it.cls}`} aria-hidden="true">{it.icon}</span>
            <div className="ov-text">
              <div className={`ov-value ${it.valCls}`.trim()}>{it.value}</div>
              <div className="ov-label">{it.label}</div>
            </div>
          </div>
        ))}
      </div>
      <div
        className="ov-health"
        role="img"
        aria-label={`健康度 ${ok}/${total} 正常`}
        title={`${ok}/${total} 正常`}
      >
        <div
          className={`ov-health-fill${errors > 0 ? ' has-err' : ''}`}
          style={{ width: `${okPct}%` }}
        />
      </div>
    </div>
  );
}

function AccountCard({ account: a, now, progMode, near, onRetry }) {
  const errKind = a.error ? ERROR_KINDS[a.error.kind] : null;
  // “进度/限额窗口”：有 used、有纯百分比，或带 total（限额）的窗口都走进度可视化（条形/圆环/嵌套环）。
  // 只有 balance 没有任何窗口的纯余额卡（如 sub2api 钱包）才用大数字。
  const hasProgress = (a.windows ?? []).some((w) => w.usedPercent != null || w.total != null);
  return (
    <div className={`card account-card${a.error ? ' has-error' : ''}${near ? ' near-limit' : ''}`} data-p={a.provider}>
      <div className="card-head">
        <div className="card-title">
          <span className="p-icon" data-p={a.provider} aria-hidden="true">
            {a.provider[0].toUpperCase()}
          </span>
          <span className="alias">{a.alias}</span>
        </div>
        <span className={`badge ${a.source === 'live' ? 'badge-blue' : 'badge-gray'}`}>
          {a.source === 'live' ? 'live' : 'cache'}
        </span>
      </div>
      {near && (
        <div className="near-banner">
          <span className="badge badge-red">即将打满</span>
          <span className="muted small">有窗口用量已达阈值</span>
        </div>
      )}
      {a.plan && (
        <div className="card-sub tabular">
          <span className="plan-tag">{a.plan}</span>
        </div>
      )}

      {a.error ? (
        <div className="card-error">
          <span className={`badge ${errKind?.cls || 'badge-red'}`}>{errKind?.label || '错误'}</span>
          <p className="error-reason">{a.error.message}</p>
          {errKind?.hint && <p className="error-hint muted small">{errKind.hint}</p>}
          <button className="btn btn-ghost btn-sm" onClick={onRetry}>
            重试
          </button>
        </div>
      ) : hasProgress ? (
        progMode === 'ring' ? (
          <div className="windows">
            {a.windows.map((w) => (
              <RingRow key={w.name} w={w} now={now} />
            ))}
          </div>
        ) : progMode === 'nested' ? (
          <NestedRings windows={a.windows} now={now} />
        ) : (
          <div className="windows">
            {a.windows.map((w) => (
              <WindowRow key={w.name} w={w} now={now} />
            ))}
          </div>
        )
      ) : a.balance ? (
        <BalanceAura balance={a.balance} />
      ) : null}

      <div className="card-foot tabular">
        <span className="muted small">{fmtAgo(a.fetchedAt, now)}</span>
      </div>
    </div>
  );
}

function BalanceAura({ balance }) {
  return (
    <div className="balance-box">
      <span className="balance-cap">可用余额</span>
      <div className="balance-value tabular">{fmtMoney(balance.total, balance.currency)}</div>
    </div>
  );
}

// 显示语义：全部改成“剩余”。进度条/圆环 = 剩余百分比（从 100% 起随用量减少），
// 颜色仍按“已用”判定：已用越多（剩余越少）越危险。
function remainPct(w) {
  if (w.usedPercent == null) return null;
  return Math.min(100, Math.max(0, 100 - w.usedPercent));
}

function WindowRow({ w, now }) {
  const level = windowLevel(w.usedPercent);
  const remain = w.resetAt ? Math.max(0, w.resetAt - now) : null;
  const pct = useCountUp(remainPct(w));
  const shown = pct == null ? null : Math.min(100, Math.max(0, pct));
  return (
    <div className="window-row">
      <div className="window-meta">
        <span className="window-name">{w.name}</span>
        <span className={`tabular window-pct pct-${level}`}>
          {shown == null ? '—' : `${Math.round(shown)}%`}
        </span>
      </div>
      <div
        className={`progress${remain === 0 ? ' resetting' : ''}`}
        role="progressbar"
        aria-valuenow={shown ?? 0}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className={`progress-fill level-${level}`}
          style={{ width: `${shown ?? 0}%` }}
        >
        </div>
      </div>
      <WindowSub w={w} remain={remain} />
    </div>
  );
}

// 用量/重置小行（条形、单环、嵌套环图例共用）
// 显示「多久后重置」；长周期窗口（>=1 天，如每月/每周）再补一个具体重置日期（几号几时），
// 短窗口（5小时）保持只有倒计时，避免噪音。
function WindowSub({ w, remain }) {
  const usage = w.used != null && w.total != null
    ? `已用 ${w.used}${w.unit ? ` ${w.unit}` : ''} / ${w.total}${w.unit ? ` ${w.unit}` : ''}`
    : w.total != null
      ? `限额 ${w.total}${w.unit ? ` ${w.unit}` : ''}`
      : w.used != null
        ? `已用 ${w.used}${w.unit ? ` ${w.unit}` : ''}`
        : null;
  const isLongCycle = remain != null && remain >= 24 * 60 * 60 * 1000;
  return (
    <div className="window-sub">
      {usage != null && (
        <span className="tabular muted small">
          {usage}
        </span>
      )}
      {remain != null && (
        <>
          <span className={`tabular small reset-cd${remain <= 0 ? ' reset-now' : ''}`}>
            {remain > 0 ? `${fmtCountdown(remain)} 后重置` : '正在刷新…'}
          </span>
          {isLongCycle && <span className="tabular small reset-date">{fmtResetDate(w.resetAt)}</span>}
        </>
      )}
    </div>
  );
}
// 长周期（>=1 天，如每月/每周）：给「M月D日 HH:MM」，一眼看懂几号重置
function fmtResetDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}月${d.getDate()}日 ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 等级 → 流动渐变的三色停靠（与条形的能量渐变同色板）
const RING_GRADIENTS = {
  ok: ['#25b586', 'var(--green)', '#a8ebc6'],
  warn: ['#e0952f', 'var(--yellow)', '#ffd58a'],
  danger: ['#e05252', 'var(--red)', '#ff9d9d'],
};

function useReducedMotion() {
  return useMemo(() => Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches), []);
}

// 一组环层（svg 子树，单环/嵌套环共用）：轨道 + 流动渐变进度弧。
// flow=true 时额外画一层「血管式」亮液前锋，沿已填充弧段循环推进（与进度条同一套观感）。
function RingLayers({ pct, level, size, stroke, radius, resetting }) {
  const reduced = useReducedMotion();
  const gid = `rg${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const r = radius ?? (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const half = size / 2;
  const shown = pct == null ? 0 : Math.min(100, Math.max(0, pct));
  const grad = RING_GRADIENTS[level] ?? null;
  return (
    <>
      {grad && (
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" style={{ stopColor: grad[0] }} />
            <stop offset="42%" style={{ stopColor: grad[1] }} />
            <stop offset="55%" style={{ stopColor: grad[2] }} />
            <stop offset="100%" style={{ stopColor: grad[0] }} />
            {!reduced && (
              <animateTransform
                attributeName="gradientTransform"
                type="rotate"
                from="0 0.5 0.5"
                to="360 0.5 0.5"
                dur={resetting ? '2s' : '6s'}
                repeatCount="indefinite"
              />
            )}
          </linearGradient>
        </defs>
      )}
      <circle className="ring-track" cx={half} cy={half} r={r} style={{ strokeWidth: stroke }} />
      <circle
        className={`ring-fill ring-${level}`}
        cx={half}
        cy={half}
        r={r}
        style={{
          strokeWidth: stroke,
          strokeDasharray: c,
          strokeDashoffset: c * (1 - shown / 100),
          stroke: grad ? `url(#${gid})` : undefined,
        }}
        transform={`rotate(-90 ${half} ${half})`}
      />
    </>
  );
}

// SVG 圆环基底：环层 + 可选环心内容
function Ring({ pct, level, size, stroke, radius, resetting, label, children }) {
  const shown = pct == null ? 0 : Math.min(100, Math.max(0, pct));
  return (
    <div
      className={`ring-wrap${resetting ? ' resetting' : ''}`}
      style={{ width: size, height: size }}
      role="progressbar"
      aria-valuenow={pct ?? 0}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <RingLayers pct={shown} level={level} size={size} stroke={stroke} radius={radius} resetting={resetting} />
      </svg>
      {children && <div className="ring-center-wrap">{children}</div>}
    </div>
  );
}

// 单圆环模式：每个窗口一颗环，右侧名称/用量/重置。环进度/环心数字 = 剩余百分比
function RingRow({ w, now }) {
  const level = windowLevel(w.usedPercent);
  const remain = w.resetAt ? Math.max(0, w.resetAt - now) : null;
  const pct = useCountUp(remainPct(w));
  const shown = pct == null ? null : Math.min(100, Math.max(0, pct));
  return (
    <div className="ring-row">
      <Ring pct={shown} level={level} size={62} stroke={7} resetting={remain === 0} label={w.name}>
        <span className={`ring-center tabular pct-${level}`}>
          {shown == null ? '—' : `${Math.round(shown)}%`}
        </span>
      </Ring>
      <div className="ring-info">
        <div className="window-meta">
          <span className="window-name">{w.name}</span>
        </div>
        <WindowSub w={w} remain={remain} />
      </div>
    </div>
  );
}

// 嵌套环上的一层（独立组件以便各自 useCountUp 生长）
function NestedLayer({ w, radius, size, stroke, resetting }) {
  const level = windowLevel(w.usedPercent);
  const pct = useCountUp(remainPct(w));
  const shown = pct == null ? 0 : Math.min(100, Math.max(0, pct));
  return (
    <g>
      <RingLayers pct={shown} level={level} size={size} stroke={stroke} radius={radius} resetting={resetting} />
    </g>
  );
}

function NestedCenter({ w }) {
  const level = windowLevel(w.usedPercent);
  const pct = useCountUp(remainPct(w));
  const shown = pct == null ? null : Math.min(100, Math.max(0, pct));
  return (
    <div className="nested-center">
      <span className={`nested-pct tabular pct-${level}`}>
        {shown == null ? '—' : `${Math.round(shown)}%`}
      </span>
      <span className="nested-name muted">{w.name}</span>
    </div>
  );
}

// 嵌套圆环模式：一张卡一组同心环（外环=第一个窗口，向内依次），右侧图例列出全部窗口
const NESTED_SIZE = 124;
const NESTED_STROKE = 8;
const NESTED_STEP = 12;
const NESTED_MAX_RINGS = 3;

function NestedRings({ windows, now }) {
  const rings = windows.slice(0, NESTED_MAX_RINGS);
  const resetting = windows.some((w) => w.resetAt && w.resetAt - now <= 0);
  return (
    <div className={`nested${resetting ? ' resetting' : ''}`}>
      <div className="nested-stage" style={{ width: NESTED_SIZE, height: NESTED_SIZE }}>
        <svg width={NESTED_SIZE} height={NESTED_SIZE} viewBox={`0 0 ${NESTED_SIZE} ${NESTED_SIZE}`} aria-hidden="true">
          {rings.map((w, i) => (
            <NestedLayer
              key={w.name}
              w={w}
              radius={(NESTED_SIZE - NESTED_STROKE) / 2 - i * NESTED_STEP}
              size={NESTED_SIZE}
              stroke={NESTED_STROKE}
              resetting={resetting}
            />
          ))}
        </svg>
        {rings.length > 0 && <NestedCenter w={rings[rings.length - 1]} />}
      </div>
      <div className="nested-legend">
        {windows.map((w, i) => (
          <NestedLegendRow key={w.name} w={w} now={now} ringed={i < NESTED_MAX_RINGS} />
        ))}
      </div>
    </div>
  );
}

function NestedLegendRow({ w, now, ringed }) {
  const level = windowLevel(w.usedPercent);
  const remain = w.resetAt ? Math.max(0, w.resetAt - now) : null;
  const pct = remainPct(w);
  return (
    <div className="legend-row">
      <div className="legend-head">
        {ringed && <i className={`legend-dot dot-${level}`} aria-hidden="true" />}
        <span className="window-name">{w.name}</span>
        <span className={`tabular window-pct pct-${level}`}>
          {pct == null ? '—' : `${Math.round(pct)}%`}
        </span>
      </div>
      <WindowSub w={w} remain={remain} />
    </div>
  );
}
