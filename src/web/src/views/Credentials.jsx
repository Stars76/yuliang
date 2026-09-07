import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { PROVIDER_LABELS, fmtTime } from '../util.js';
import { EmptyState, SkeletonCard, useToast } from '../components/Toast.jsx';

export default function Credentials() {
  const [list, setList] = useState(null);
  const [meta, setMeta] = useState(null);
  const [mode, setMode] = useState(null); // 'add' | {type:'edit'|'delete'|'codex', cred}
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
        <div className="cred-toolbar-actions">
          <button className="btn btn-ghost" onClick={() => setMode('discover')}>
            自动发现本机配置
          </button>
          <button className="btn btn-primary" onClick={() => setMode('add')}>
            + 添加凭证
          </button>
        </div>
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
                  <button className="btn btn-ghost btn-sm" onClick={() => setMode('codex-login')}>
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
          onLogin={() => setMode('codex-login')}
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
      {mode === 'discover' && (
        <DiscoverModal
          onClose={() => setMode(null)}
          onAdopted={() => { setMode(null); load(); toast('已从本机配置采用凭证', 'ok'); }}
        />
      )}
      {mode === 'codex-login' && (
        <CodexLoginModal
          onClose={() => setMode(null)}
          onDone={() => { setMode(null); load(); toast('Codex 登录成功', 'ok'); }}
        />
      )}
    </div>
  );
}

// 在系统浏览器/默认浏览器打开外部链接（Electron→shell，安卓→Intent，Web 兜底 window.open）
export function openExternal(url) {
  try {
    if (window.Capacitor?.Plugins?.QuotaWidget) {
      window.Capacitor.Plugins.QuotaWidget.openExternal({ url }).catch(() => window.open(url, '_blank'));
      return;
    }
  } catch {}
  try {
    if (window.standalone?.openExternal) {
      window.standalone.openExternal(url);
      return;
    }
  } catch {}
  window.open(url, '_blank');
}

function CodexLoginModal({ onClose, onDone }) {
  const [state, setState] = useState('starting'); // starting | waiting | done | error
  const [info, setInfo] = useState(null); // {verificationUrl, userCode, intervalSeconds}
  const [err, setErr] = useState('');

  useEffect(() => {
    let alive = true;
    let timer = 0;
    let loginToken = null;

    async function start() {
      try {
        const r = await api.codexLogin();
        if (!alive) return;
        loginToken = r.loginToken;
        setInfo(r);
        setState('waiting');
        const interval = Math.max(2, r.intervalSeconds || 5) * 1000;
        timer = window.setInterval(async () => {
          try {
            const s = await api.codexLoginStatus(loginToken);
            if (!alive) return;
            if (s.status === 'complete') {
              window.clearInterval(timer);
              setState('done');
              setTimeout(onDone, 600);
            }
            // pending → 继续轮询
          } catch (ex) {
            window.clearInterval(timer);
            if (!alive) return;
            setErr(ex.message || '登录失败');
            setState('error');
          }
        }, interval);
      } catch (ex) {
        if (!alive) return;
        setErr(ex.message || '发起登录失败');
        setState('error');
      }
    }
    start();
    return () => {
      alive = false;
      if (timer) window.clearInterval(timer);
    };
  }, [onDone]);

  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal card" role="dialog" aria-modal="true">
        <h3>登录 Codex（直连）</h3>
        {state === 'starting' && <p className="muted">正在申请设备码…</p>}
        {state === 'waiting' && info && (
          <>
            <p className="modal-desc">
              1. 在浏览器打开验证地址并登录 ChatGPT；<br />
              2. 输入下面的设备码。授权后本窗口会自动完成。
            </p>
            <div className="field">
              <span>验证地址</span>
              <div className="field-input-row">
                <input type="text" readOnly value={info.verificationUrl} onFocus={(e) => e.target.select()} />
                <button type="button" className="reveal-btn" onClick={() => openExternal(info.verificationUrl)}>
                  打开
                </button>
              </div>
            </div>
            <div className="field">
              <span>设备码</span>
              <div className="device-code tabular">{info.userCode}</div>
            </div>
            <p className="muted small">等待授权中，每 {Math.max(2, info.intervalSeconds || 5)} 秒自动检查一次（15 分钟内有效）。</p>
          </>
        )}
        {state === 'done' && <p className="muted">登录成功，正在写入凭证…</p>}
        {state === 'error' && (
          <>
            <div className="form-error">{err}</div>
            <p className="muted small">若提示不支持设备码登录，说明该账号未开放此流程，可改用手动填 token。</p>
          </>
        )}
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            {state === 'done' ? '完成' : '取消'}
          </button>
        </div>
      </div>
    </div>
  );
}

function DiscoverModal({ onClose, onAdopted }) {
  const [candidates, setCandidates] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const r = await api.discover();
        setCandidates(r.candidates ?? []);
      } catch (ex) {
        setErr(ex.message || '扫描本机配置失败');
        setCandidates([]);
      }
    })();
  }, []);

  async function adopt(c) {
    setBusy(true);
    setErr('');
    try {
      await api.createCredential({ provider: c.provider, alias: c.alias, fields: c.fields });
      onAdopted();
    } catch (ex) {
      setErr(ex.message || '采用失败');
      setBusy(false);
    }
  }

  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal card modal-wide" role="dialog" aria-modal="true">
        <h3>自动发现本机配置</h3>
        <p className="modal-desc">
          扫描本机已有工具的配置文件（Codex <code>~/.codex</code>、OpenCode <code>auth.json</code>）。
          仅显示脱敏摘要，确认后才会写入本机凭证库。
        </p>
        {candidates === null ? (
          <div className="skel skel-line w60" />
        ) : candidates.length === 0 ? (
          <p className="muted">未发现可自动导入的本机配置。其余服务请在「添加凭证」中手动填写。</p>
        ) : (
          <div className="codex-acct-list">
            {candidates.map((c, i) => (
              <div className="codex-acct" key={`${c.provider}-${i}`}>
                <div className="cred-main">
                  <span className="provider-badge" data-p={c.provider}>{PROVIDER_LABELS[c.provider] || c.provider}</span>
                  <span className="alias">{c.alias}</span>
                  <span className="muted small mono">{c.source}</span>
                </div>
                <div className="cred-main">
                  {Object.entries(c.preview ?? {}).map(([k, v]) => (
                    <span className="muted small mono" key={k}>{k}: {v}</span>
                  ))}
                </div>
                <div className="cred-actions">
                  <button className="btn btn-primary btn-sm" onClick={() => adopt(c)} disabled={busy}>采用</button>
                </div>
              </div>
            ))}
          </div>
        )}
        {err && <div className="form-error">{err}</div>}
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>关闭</button>
        </div>
      </div>
    </div>
  );
}

function AddCredentialModal({ metaByProvider, onClose, onLogin, onAdded }) {
  const providers = Object.keys(metaByProvider);
  const [provider, setProvider] = useState(providers[0] || '');
  const [alias, setAlias] = useState('');
  const [fields, setFields] = useState({});
  const [reveal, setReveal] = useState({});
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const def = metaByProvider[provider];
  const credFields = def?.credentialFields ?? [];

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
        {provider === 'codex-direct' ? (
          <>
            <p className="modal-desc">
              通过 ChatGPT 账号授权登录，自动获取 token 并支持自动续期，无需手动填 token。
            </p>
            <div className="modal-actions">
              <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>取消</button>
              <button type="button" className="btn btn-primary" onClick={onLogin}>登录 Codex</button>
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
            <div className="field-input-row">
              <input
                type="text"
                inputMode={f.secret ? 'text' : undefined}
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                className={f.secret && !reveal[f.key] ? 'masked' : ''}
                placeholder={f.placeholder || ''}
                value={fields[f.key] || ''}
                required={!!f.required}
                onChange={(e) => setFields((s) => ({ ...s, [f.key]: e.target.value }))}
              />
              {f.secret && (
                <button
                  type="button"
                  className="reveal-btn"
                  aria-label={reveal[f.key] ? '隐藏' : '显示'}
                  onClick={() => setReveal((s) => ({ ...s, [f.key]: !s[f.key] }))}
                >
                  {reveal[f.key] ? '隐藏' : '显示'}
                </button>
              )}
            </div>
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
