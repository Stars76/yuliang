import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { fmtTime } from '../util.js';
import { EmptyState, Spinner, useToast } from '../components/Toast.jsx';

const EVENT_LABELS = {
  login: '登录',
  login_failed: '登录失败',
  logout: '退出登录',
  step_up: '敏感操作验证',
  step_up_failed: '敏感操作验证失败',
  credential_add: '添加凭证',
  credential_update: '更新凭证',
  credential_delete: '删除凭证',
  credential_reveal: '查看凭证明文',
  credential_import: '导入备份',
  codex_accounts_save: '保存 Codex 账号',
  password_change: '修改主密码',
  revoke_others: '注销其他会话',
  export: '导出备份',
  recover: '恢复验证',
  recover_complete: '完成恢复',
  quota_refresh: '刷新额度',
};

export default function Audit() {
  const [entries, setEntries] = useState(null);
  const [eventFilter, setEventFilter] = useState('');
  const [query, setQuery] = useState('');
  const toast = useToast();

  const load = useCallback(async () => {
    try {
      const data = await api.audit(200);
      // 后端返回即倒序（最新在前）
      setEntries(data.entries);
    } catch (ex) {
      toast(ex.message || '加载审计日志失败');
      setEntries([]);
    }
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  // 纯前端过滤：事件类型 + 文本搜索（匹配时间/事件名/详情）
  const filtered = useMemo(() => {
    if (!entries) return null;
    const q = query.trim().toLowerCase();
    return entries.filter((e) => {
      if (eventFilter && e.event !== eventFilter) return false;
      if (!q) return true;
      const hay =
        `${fmtTime(e.ts)} ${EVENT_LABELS[e.event] || e.event} ${detailText(e)}`.toLowerCase();
      return hay.includes(q);
    });
  }, [entries, eventFilter, query]);

  return (
    <div>
      <div className="dash-toolbar">
        <h2 className="page-title">审计日志</h2>
        <button className="btn btn-ghost" onClick={load}>
          刷新
        </button>
      </div>

      {entries === null ? (
        <Spinner label="加载中…" />
      ) : entries.length === 0 ? (
        <EmptyState title="暂无审计记录" />
      ) : (
        <>
          <div className="audit-filters">
            <select
              value={eventFilter}
              onChange={(e) => setEventFilter(e.target.value)}
              aria-label="按事件类型筛选"
            >
              <option value="">全部事件</option>
              {Object.entries(EVENT_LABELS).map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
            <input
              type="search"
              placeholder="搜索时间 / 事件 / 详情…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <span className="muted small tabular">
              {filtered.length} / {entries.length} 条
            </span>
          </div>
          {filtered.length === 0 ? (
            <EmptyState title="没有匹配的审计记录" hint="换个事件类型或关键词试试" />
          ) : (
            <div className="audit-wrap">
              <table className="audit-table">
                <thead>
                  <tr>
                    <th>时间</th>
                    <th>事件</th>
                    <th>详情</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((e, i) => (
                    <tr key={i}>
                      <td className="tabular mono" style={{ whiteSpace: 'nowrap' }}>
                        {fmtTime(e.ts)}
                      </td>
                      <td>{EVENT_LABELS[e.event] || e.event}</td>
                      <td className="audit-detail">{detailText(e)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function detailText(e) {
  const d = e.details;
  if (d == null) return '—';
  if (typeof d === 'string') return d;
  try {
    return Object.entries(d)
      .map(([k, v]) => `${k}: ${String(v)}`)
      .join('，');
  } catch {
    return String(d);
  }
}
