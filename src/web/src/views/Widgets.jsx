import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { PROVIDER_LABELS } from '../util.js';
import { useToast } from '../components/Toast.jsx';

// 桌面小组件添加/管理（仅 Capacitor 运行；本文件不含任何 @capacitor 静态 import，保证桌面端也能打包）。
// 账号可多选，quota 选样式（圆环/进度条/嵌套圆环），balance 自动数字；尺寸按账号数自动给范围。
// 原生插件经 window.Capacitor.Plugins.QuotaWidget 调用（无需 import @capacitor/core）。
export default function Widgets() {
  const toast = useToast();
  const [accounts, setAccounts] = useState(null);
  const [picked, setPicked] = useState({}); // accountId -> {style}
  const [size, setSize] = useState('3x2');
  const [busy, setBusy] = useState(false);
  const theme = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';

  const load = useCallback(async () => {
    try {
      const d = await api.quota();
      setAccounts(d.accounts || []);
      const def = {};
      for (const a of d.accounts || []) {
        def[a.accountId] = { style: a.kind === 'balance' ? 'number' : 'ring' };
      }
      setPicked(def);
    } catch (ex) {
      toast(ex.message || '加载失败');
      setAccounts([]);
    }
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  const visible = useMemo(() => (accounts || []).filter((a) => !a.error), [accounts]);
  const count = Object.keys(picked).length;

  // 尺寸范围：按 选定账号数 计算。
  const sizeOpts = useMemo(() => {
    if (count <= 0) return [{ id: '3x2', label: '3×2' }];
    if (count === 1)
      return ['1x1', '2x1', '2x2', '3x2', '4x2', '4x4'].map((s) => ({ id: s, label: s.replace('x', '×') }));
    if (count <= 3) return ['2x2', '3x2', '4x2', '4x4'].map((s) => ({ id: s, label: s.replace('x', '×') }));
    if (count <= 5) return ['3x2', '4x2', '4x4'].map((s) => ({ id: s, label: s.replace('x', '×') }));
    return ['4x2', '4x4'].map((s) => ({ id: s, label: s.replace('x', '×') }));
  }, [count]);

  useEffect(() => {
    if (sizeOpts.length && !sizeOpts.some((s) => s.id === size)) setSize(sizeOpts[0].id);
  }, [sizeOpts, size]);

  function toggle(a) {
    setPicked((p) => {
      const n = { ...p };
      if (n[a.accountId]) delete n[a.accountId];
      else n[a.accountId] = { style: a.kind === 'balance' ? 'number' : 'ring' };
      return n;
    });
  }
  function setStyle(id, style) {
    setPicked((p) => ({ ...p, [id]: { style } }));
  }

  async function addToHome() {
    const entries = Object.entries(picked);
    if (entries.length === 0) {
      toast('请至少选一个账号');
      return;
    }
    if (!window.Capacitor?.Plugins?.QuotaWidget) {
      toast('小组件插件未就绪');
      return;
    }
    const arr = entries.map(([id, cfg]) => {
      const a = accounts.find((x) => x.accountId === id);
      return { accountId: id, alias: a?.alias, kind: a?.kind, style: cfg.style };
    });
    setBusy(true);
    try {
      const res = await window.Capacitor.Plugins.QuotaWidget.requestAdd({ size, theme, accounts: arr });
      const status = res?.status;
      if (status === 'pinned') {
        toast('已添加到桌面 ✓', 'ok');
      } else if (status === 'miui-permission') {
        toast('小米/红米需开启「桌面快捷方式」权限：已在系统弹出应用信息页 → 权限管理 → 桌面快捷方式 → 允许，然后回 App 重新点添加', 'warn');
      } else if (status === 'coloros-permission') {
        toast('ColorOS 需开启「桌面快捷方式」权限：已在系统弹出应用信息页 → 权限管理 → 打开「桌面快捷方式」，然后回 App 重新点添加', 'warn');
      } else if (status === 'picker') {
        toast('已打开系统小组件选择器，请在列表里选「余量」并放置', 'ok');
      } else {
        // manual：vivo 等未接厂商 SDK 的 ROM 请求无效，只能手动
        toast('该系统不支持应用内自动放置：请长按桌面空白处 → 小组件 → 找「余量」手动添加（配置已记住）', 'ok');
      }
    } catch (ex) {
      toast(ex.message || '请求放置失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="dash-toolbar">
        <h2 className="page-title">桌面小组件</h2>
      </div>

      {accounts === null ? (
        <div className="card-grid"><div className="skel skel-line w60" /></div>
      ) : (
        <div className="widget-main">
          <div className="card widget-card">
            <div className="card-title">1 · 选择要显示的账号</div>
            <p className="muted small">勾选要在小组件里看到的账号。</p>
            {accounts.length === 0 ? (
              <p className="muted">还没有凭证数据。请先在「凭证管理」添加并刷新。</p>
            ) : (
              <div className="widget-pick-list">
                {visible.map((a) => (
                  <div className={`widget-pick${picked[a.accountId] ? ' on' : ''}`} key={a.accountId}>
                    <label className="switch-row">
                      <input type="checkbox" checked={!!picked[a.accountId]} onChange={() => toggle(a)} />
                      <span className="provider-badge" data-p={a.provider}>{PROVIDER_LABELS[a.provider] || a.provider}</span>
                      <span className="alias">{a.alias}</span>
                      <span className="muted small">{a.kind === 'balance' ? '余额' : a.plan || '额度'}</span>
                    </label>
                    {picked[a.accountId] && a.kind === 'quota' && (
                      <div className="seg" role="group">
                        {[['ring', '圆环'], ['nested', '嵌套圆环'], ['bar', '进度条'], ['number', '纯数字']].map(([k, l]) => (
                          <button
                            key={k}
                            className={`seg-btn${picked[a.accountId].style === k ? ' active' : ''}`}
                            onClick={() => setStyle(a.accountId, k)}
                          >
                            {l}
                          </button>
                        ))}
                      </div>
                    )}
                    {picked[a.accountId] && a.kind === 'balance' && (
                      <span className="muted small">余额账号 → 数字显示</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="card widget-card">
            <div className="card-title">2 · 选择尺寸</div>
            <p className="muted small">已选 {count} 个账号，可选：{sizeOpts.map((s) => s.label).join(' / ')}。</p>
            <div className="seg" role="group">
              {sizeOpts.map((s) => (
                <button key={s.id} className={`seg-btn${size === s.id ? ' active' : ''}`} onClick={() => setSize(s.id)}>
                  {s.label}
                </button>
              ))}
            </div>
            <p className="muted small">
              {size === '4x2' || size === '4x4' ? '该尺寸账号多时可内部滚动。' : size === '1x1' || size === '2x1' ? '小尺寸显示最靠前的一个账号。' : '固定展示所选账号。'}
            </p>
          </div>

          <button
            className="btn btn-primary"
            style={{ padding: '10px 18px', fontSize: 15 }}
            onClick={addToHome}
            disabled={busy || count === 0}
          >
            {busy ? '请求中…' : `添加到桌面（${size} · ${count} 个账号）`}
          </button>
          <p className="muted small">
            已放置的小组件会随 App 刷新自动更新。若点「添加到桌面」没反应：小米/OPPO 系（含一加/真我）请到 系统设置 → 应用管理 → 余量 → 权限管理 → 开启「桌面快捷方式」后重试；其他系统请长按桌面空白处 → 小组件 → 找「余量」手动添加（账号/样式/尺寸已自动记住）。
          </p>
        </div>
      )}
    </div>
  );
}
