import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

const USERNAME_RE = /^[A-Za-z0-9._-]{3,20}$/;

export default function Login({ initialized, onSuccess, onRecover }) {
  const [tab, setTab] = useState('login'); // 'login' | 'register'

  if (!initialized) {
    return (
      <div className="center-page">
        <div className="card auth-card">
          <div className="auth-logo"><img className="auth-logo-mark" src="/icons/logo.png" alt="EntropicEcho" />EntropicEcho额度聚合面板</div>
          <h2>尚未初始化</h2>
          <p className="muted">
            请先在服务器终端完成初始化：
          </p>
          <pre className="code-block">node src/server/cli/index.js init</pre>
          <p className="muted">初始化管理员账号后再打开本页面。</p>
        </div>
      </div>
    );
  }

  return (
    <div className="center-page">
      <div className="card auth-card">
        <div className="auth-logo"><img className="auth-logo-mark" src="/icons/logo.png" alt="EntropicEcho" />EntropicEcho额度聚合面板</div>
        <div className="auth-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'login'}
            className={`auth-tab${tab === 'login' ? ' active' : ''}`}
            onClick={() => setTab('login')}
          >
            登录
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'register'}
            className={`auth-tab${tab === 'register' ? ' active' : ''}`}
            onClick={() => setTab('register')}
          >
            注册
          </button>
        </div>
        {tab === 'login' ? (
          <LoginForm onSuccess={onSuccess} onRecover={onRecover} />
        ) : (
          <RegisterForm onGoLogin={() => setTab('login')} />
        )}
        <p className="privacy-note">
          你的密钥由你自己的登录密码加密存储（scrypt + AES-256-GCM），没有你的密码任何人都无法解密——包括本站管理员。后台没有任何查看或导出你密钥的入口。
        </p>
      </div>
    </div>
  );
}

function LoginForm({ onSuccess, onRecover }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [lockedUntil, setLockedUntil] = useState(0);
  const timerRef = useRef(null);

  const [lockRemain, setLockRemain] = useState(0);
  useEffect(() => {
    if (!lockedUntil) return;
    timerRef.current = setInterval(() => {
      const remain = Math.max(0, lockedUntil - Date.now());
      setLockRemain(remain);
      if (remain <= 0) {
        clearInterval(timerRef.current);
        setLockedUntil(0);
      }
    }, 500);
    return () => clearInterval(timerRef.current);
  }, [lockedUntil]);

  async function submit(e) {
    e.preventDefault();
    if (lockedUntil > Date.now()) return;
    setBusy(true);
    setErr('');
    try {
      await api.login(username.trim(), password);
      setPassword('');
      onSuccess();
    } catch (ex) {
      setPassword('');
      setErr(ex.message || '登录失败');
      if (ex.retryAfterSec) setLockedUntil(Date.now() + ex.retryAfterSec * 1000);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <label className="field">
        <span>用户名</span>
        <input
          type="text"
          autoComplete="username"
          autoFocus
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          disabled={lockedUntil > Date.now()}
          required
        />
      </label>
      <label className="field">
        <span>密码</span>
        <input
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={lockedUntil > Date.now()}
          required
        />
      </label>
      {err && <div className="form-error">{err}</div>}
      {lockedUntil > Date.now() && (
        <div className="form-error lock-count">
          已锁定，{Math.ceil(lockRemain / 1000)} 秒后可重试
        </div>
      )}
      <button className="btn btn-primary btn-block" type="submit" disabled={busy || lockedUntil > Date.now()}>
        {busy ? '登录中…' : '登录'}
      </button>
      <button type="button" className="btn btn-ghost btn-block" onClick={onRecover}>
        忘记密码？使用恢复码
      </button>
    </form>
  );
}

function RegisterForm({ onGoLogin }) {
  const [username, setUsername] = useState('');
  const [pw1, setPw1] = useState('');
  const [pw2, setPw2] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState(null);
  const [saved, setSaved] = useState(false);

  async function submit(e) {
    e.preventDefault();
    const name = username.trim();
    if (!USERNAME_RE.test(name)) return setErr('用户名格式不正确（3-20 位字母、数字、. _ -）');
    if (pw1.length < 8) return setErr('密码至少 8 位');
    if (pw1 !== pw2) return setErr('两次输入的密码不一致');
    setBusy(true);
    setErr('');
    try {
      const r = await api.register(name, pw1);
      setRecoveryCode(r.recoveryCode);
    } catch (ex) {
      setErr(ex.message || '注册失败');
    } finally {
      setBusy(false);
    }
  }

  if (recoveryCode) {
    return (
      <div>
        <h2>注册成功</h2>
        <p className="muted small" style={{ marginBottom: 14 }}>
          以下恢复码<strong>仅展示一次</strong>，是你忘记密码时的唯一找回途径，请立即抄写并妥善保存。
        </p>
        <div className="recovery-code-box">
          <span className="small muted">恢复码</span>
          <div className="code">{recoveryCode}</div>
        </div>
        <label className="saved-confirm">
          <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
          <span>我已抄写并妥善保存恢复码</span>
        </label>
        <button className="btn btn-primary btn-block" disabled={!saved} onClick={onGoLogin}>
          前往登录
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={submit}>
      <label className="field">
        <span>用户名</span>
        <input
          type="text"
          autoComplete="username"
          autoFocus
          placeholder="3-20 位字母、数字、. _ -"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          required
        />
      </label>
      <label className="field">
        <span>密码（≥8 位）</span>
        <input
          type="password"
          autoComplete="new-password"
          minLength={8}
          value={pw1}
          onChange={(e) => setPw1(e.target.value)}
          required
        />
      </label>
      <label className="field">
        <span>再次输入密码</span>
        <input
          type="password"
          autoComplete="new-password"
          minLength={8}
          value={pw2}
          onChange={(e) => setPw2(e.target.value)}
          required
        />
      </label>
      {err && <div className="form-error">{err}</div>}
      <button className="btn btn-primary btn-block" type="submit" disabled={busy}>
        {busy ? '注册中…（约需 1 秒）' : '注册'}
      </button>
    </form>
  );
}
