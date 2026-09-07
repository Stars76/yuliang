import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { PROVIDER_LABELS, fmtTime } from '../util.js';
import { EmptyState, SkeletonCard, useToast } from '../components/Toast.jsx';

export default function Credentials() {
  const [list, setList] = useState(null);
  const [meta, setMeta] = useState(null);
  const [mode, setMode] = useState(null); // 'add' | {type:'edit'|'delete'|'codex', cred}
  const [codexLogin, setCodexLogin] = useState(false);
  const toast = useToast();

  const load = useCallback(async () => {
    try {
      const [c, m] = await Promise.all([api.credentials(), api.credentialMeta()]);
      setList(c);
      setMeta(m);
    } catch (ex) {
      toast(ex.message || '加载凭证失败');
      setList([]);
    }
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  const metaByProvider = useMemo(() => {
    const map = {};
    for (const m of meta ?? []) map[m.id] = m;
    return map;
  }, [meta]);

  return (
    <div>
      <div className="dash-toolbar">
        <h2 className="page-title">凭证管理</h2>
        <button className="btn btn-primary" onClick={() => setMode('add')}>
          + 添加凭证
        </button>
      </div>

      {list === null ? (
        <div className="card-grid">
          <SkeletonCard />
          <SkeletonCard />
        </div>
      ) : list.length === 0 ? (
        <EmptyState title="暂无凭证" hint="点击右上角「添加凭证」开始" />
      ) : (
        <div className="cred-list">
          {list.map((c) => (
            <div className="card cred-row" key={c.id}>
              <div className="cred-main">
                <span className="provider-badge" data-p={c.provider}>{PROVIDER_LABELS[c.provider] || c.provider}</span>
                <span className="alias">{c.alias}</span>
                <span className="muted small tabular">创建于 {fmtTime(c.createdAt)}</span>
              </div>
              <div className="cred-actions">
                {c.provider === 'codex' && (
                  <button className="btn btn-ghost btn-sm" onClick={() => setMode({ type: 'codex', cred: c })}>
                    选择账号
                  </button>
                )}
                {c.provider === 'codex-direct' && (
                  <button className="btn btn-ghost btn-sm" onClick={() => setCodexLogin(true)}>
                    重新登录
                  </button>
                )}
                <button className="btn btn-ghost btn-sm" onClick={() => setMode({ type: 'edit', cred: c })}>
                  编辑别名
                </button>
                <button className="btn btn-danger btn-sm" onClick={() => setMode({ type: 'delete', cred: c })}>
                  删除
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {mode === 'add' && (
        <AddCredentialModal
          metaByProvider={metaByProvider}
          onClose={() => setMode(null)}
          onLogin={() => { setMode(null); setCodexLogin(true); }}
          onAdded={(cred, provider) => {
            setMode(null);
            load();
            toast('凭证已添加', 'ok');
            if (provider === 'codex' && cred.id) {
              setMode({ type: 'codex', cred });
            }
          }}
        />
      )}
      {mode?.type === 'edit' && (
        <EditAliasModal cred={mode.cred} onClose={() => setMode(null)} onDone={() => { setMode(null); load(); toast('别名已更新', 'ok'); }} />
      )}
      {mode?.type === 'delete' && (
        <DeleteModal cred={mode.cred} onClose={() => setMode(null)} onDone={() => { setMode(null); load(); toast('凭证已删除', 'ok'); }} />
      )}
      {mode?.type === 'codex' && (
        <CodexAccountsModal cred={mode.cred} onClose={() => setMode(null)} onSaved={() => { setMode(null); toast('账号已保存', 'ok'); }} />
      )}
      {codexLogin && (
        <CodexLoginModal
          onClose={() => setCodexLogin(false)}
          onDone={() => { setCodexLogin(false); load(); toast('登录成功', 'ok'); }}
        />
      )}
    </div>
  );
}

function AddCredentialModal({ metaByProvider, onClose, onLogin, onAdded }) {
  const providers = Object.keys(metaByProvider);
  const [provider, setProvider] = useState(providers[0] || '');
  const [alias, setAlias] = useState('');
  const [fields, setFields] = useState({});
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const def = metaByProvider[provider];
  const credFields = def.credentialFields;
  const isCodexDirect = provider === 'codex-direct';

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setErr('');
    try {
      const res = await api.createCredential({
        provider,
        alias: alias || undefined,
        fields,
      });
      onAdded({ id: res.id, alias }, provider);
    } catch (ex) {
      setErr(ex.message || '添加失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="modal card" onSubmit={submit} role="dialog" aria-modal="true">
        <h3>添加凭证</h3>
        <label className="field">
          <span>Provider</span>
          <select value={provider} onChange={(e) => { setProvider(e.target.value); setFields({}); }}>
            {providers.map((p) => (
              <option key={p} value={p}>
                {PROVIDER_LABELS[p] || metaByProvider[p]?.displayName || p}
              </option>
            ))}
          </select>
        </label>
        {isCodexDirect ? (
          <>
            <p className="modal-desc">通过 ChatGPT OAuth 登录，无需手动填写 access token / account ID。登录后自动创建凭证并查询额度。</p>
            <p className="muted small">设备码登录：在你自己的浏览器打开验证地址，输入设备码完成授权。</p>
            {err && <div className="form-error">{err}</div>}
            <div className="modal-actions">
              <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>取消</button>
              <button type="button" className="btn btn-primary" onClick={() => { setBusy(true); onLogin(); }} disabled={busy}>
                登录 Codex
              </button>
            </div>
          </>
        ) : (
          <>
            <label className="field">
              <span>别名（可选）</span>
              <input type="text" value={alias} onChange={(e) => setAlias(e.target.value)} placeholder="便于识别的名称" />
            </label>
            {credFields.map((f) => (
              <label className="field" key={f.key}>
                <span>
                  {f.label}
                  {f.required && <em className="req">*</em>}
                </span>
                <input
                  type={f.secret ? 'password' : 'text'}
                  autoComplete="off"
                  placeholder={f.placeholder || ''}
                  value={fields[f.key] || ''}
                  required={!!f.required}
                  onChange={(e) => setFields((s) => ({ ...s, [f.key]: e.target.value }))}
                />
                {f.hint && <span className="muted small">{f.hint}</span>}
              </label>
            ))}
            {err && <div className="form-error">{err}</div>}
            <div className="modal-actions">
              <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>取消</button>
              <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? '提交中…' : '添加'}</button>
            </div>
          </>
        )}
      </form>
    </div>
  );
}

function EditAliasModal({ cred, onClose, onDone }) {
  const [alias, setAlias] = useState(cred.alias);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setErr('');
    try {
      await api.updateCredential(cred.id, { alias });
      onDone();
    } catch (ex) {
      setErr(ex.message || '更新失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="modal card" onSubmit={submit} role="dialog" aria-modal="true">
        <h3>编辑别名</h3>
        <label className="field">
          <span>别名</span>
          <input type="text" value={alias} onChange={(e) => setAlias(e.target.value)} required />
        </label>
        {err && <div className="form-error">{err}</div>}
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>取消</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? '保存中…' : '保存'}</button>
        </div>
      </form>
    </div>
  );
}

function DeleteModal({ cred, onClose, onDone }) {
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function doDelete() {
    setBusy(true);
    setErr('');
    try {
      await api.deleteCredential(cred.id, {});
      onDone();
    } catch (ex) {
      setErr(ex.message || '删除失败');
      setBusy(false);
    }
  }

  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal card" role="dialog" aria-modal="true">
        <h3>删除凭证</h3>
        <p className="modal-desc">
          确定删除 <strong>{cred.alias}</strong>？删除后对应账号将从面板移除，此操作不可撤销。
        </p>
        {err && <div className="form-error">{err}</div>}
        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}>取消</button>
          <button className="btn btn-danger" onClick={doDelete} disabled={busy}>{busy ? '删除中…' : '确认删除'}</button>
        </div>
      </div>
    </div>
  );
}

function CodexAccountsModal({ cred, onClose, onSaved }) {
  const [accounts, setAccounts] = useState(null);
  const [selected, setSelected] = useState({});
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  useEffect(() => {
    (async () => {
      try {
        const list = await api.codexAccounts(cred.id);
        setAccounts(list.accounts);
      } catch (ex) {
        toast(ex.message || '获取账号列表失败');
        setAccounts([]);
      }
    })();
  }, [cred.id, toast]);

  function toggle(a) {
    setSelected((s) => {
      const n = { ...s };
      if (n[a.authIndex]) delete n[a.authIndex];
      else n[a.authIndex] = { authIndex: a.authIndex, alias: a.maskedEmail || String(a.authIndex) };
      return n;
    });
  }

  async function submit(e) {
    e.preventDefault();
    const picks = Object.values(selected);
    if (picks.length === 0) {
      setErr('请至少勾选一个账号');
      return;
    }
    setBusy(true);
    setErr('');
    try {
      await api.saveCodexAccounts({ credId: cred.id, accounts: picks });
      onSaved();
    } catch (ex) {
      setErr(ex.message || '保存失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="modal card modal-wide" onSubmit={submit} role="dialog" aria-modal="true">
        <h3>选择 Codex 账号</h3>
        <p className="modal-desc">勾选要在面板中展示的账号，并为每个账号设置别名。</p>
        {accounts === null ? (
          <div className="skel skel-line w60" />
        ) : accounts.length === 0 ? (
          <p className="muted">未获取到账号。</p>
        ) : (
          <div className="codex-acct-list">
            {accounts.map((a) => {
              const checked = !!selected[a.authIndex];
              return (
                <div key={a.authIndex} className={`codex-acct${a.disabled ? ' disabled' : ''}`}>
                  <label className="switch-row">
                    <input type="checkbox" checked={checked} disabled={a.disabled} onChange={() => toggle(a)} />
                    <span className="mono tabular">{a.maskedEmail}</span>
                    {a.disabled && <span className="badge badge-gray">已禁用</span>}
                    {a.status && <span className="badge badge-gray">{a.status}</span>}
                  </label>
                  {checked && (
                    <input
                      className="codex-alias"
                      type="text"
                      value={selected[a.authIndex].alias}
                      onChange={(e) =>
                        setSelected((s) => ({ ...s, [a.authIndex]: { ...s[a.authIndex], alias: e.target.value } }))
                      }
                      placeholder="账号别名"
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}
        {err && <div className="form-error">{err}</div>}
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>取消</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? '保存中…' : '保存'}</button>
        </div>
      </form>
    </div>
  );
}

function CodexLoginModal({ onClose, onDone }) {
  const [stage, setStage] = useState('init'); // init | waiting | error
  const [info, setInfo] = useState(null);
  const [err, setErr] = useState('');
  const stopRef = useRef(false);
  const timerRef = useRef(null);

  const poll = useCallback(async (loginToken, interval) => {
    if (stopRef.current) return;
    try {
      const st = await api.codexLoginStatus(loginToken);
      if (st.status === 'complete') {
        stopRef.current = true;
        onDone();
        return;
      }
      timerRef.current = setTimeout(() => poll(loginToken, interval), interval);
    } catch (ex) {
      stopRef.current = true;
      setStage('error');
      setErr(ex.message || '登录失败');
    }
  }, [onDone]);

  const start = useCallback(async () => {
    stopRef.current = false;
    setStage('waiting');
    setErr('');
    try {
      const res = await api.codexLogin();
      setInfo(res);
      const interval = Math.max(1000, (Number(res.intervalSeconds) || 5) * 1000);
      timerRef.current = setTimeout(() => poll(res.loginToken, interval), interval);
    } catch (ex) {
      setStage('error');
      setErr(ex.message || '发起登录失败');
    }
  }, [poll]);

  useEffect(() => {
    start();
    return () => {
      stopRef.current = true;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [start]);

  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal card" role="dialog" aria-modal="true">
        <h3>登录 Codex（直连）</h3>
        {stage === 'error' ? (
          <>
            <p className="form-error">{err}</p>
            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={onClose}>关闭</button>
              <button className="btn btn-primary" onClick={() => start()}>重试</button>
            </div>
          </>
        ) : (
          <>
            <p className="modal-desc">在你自己的浏览器打开以下地址，登录 ChatGPT 账号并输入设备码：</p>
            <p className="mono codex-device-url">
              <a href={info?.verificationUrl || 'https://auth.openai.com/codex/device'} target="_blank" rel="noreferrer">
                {info?.verificationUrl || 'https://auth.openai.com/codex/device'}
              </a>
            </p>
            <p className="muted">设备码</p>
            <p className="mono codex-device-code">{info?.userCode || '…'}</p>
            <p className="muted small">等待授权，完成后页面会自动刷新。</p>
            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={onClose}>取消</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
