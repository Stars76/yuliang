import { useEffect, useState } from 'react';
import { api } from '../api.js';

// 恢复流程（未登录可访问）：用户名 + 恢复码 → 新密码 → 展示新恢复码
export default function Recover({ onBack, onDone }) {
  const [step, setStep] = useState(1);
  const [username, setUsername] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [recoveryToken, setRecoveryToken] = useState('');
  const [result, setResult] = useState(null); // {newRecoveryCode}

  return (
    <div className="center-page">
      <div className="card recover-card">
        <div className="auth-logo"><img className="auth-logo-mark" src="/icons/logo.png" alt="EntropicEcho" />EntropicEcho额度聚合面板</div>
        <h2 style={{ margin: '6px 0 4px' }}>恢复账户</h2>
        <div className="recover-steps" aria-hidden="true">
          <span className={`recover-step${step >= 1 ? ' active' : ''}`} />
          <span className={`recover-step${step >= 2 ? ' active' : ''}`} />
          <span className={`recover-step${step >= 3 ? ' active' : ''}`} />
        </div>

        {step === 1 && (
          <StepCode
            username={username}
            setUsername={setUsername}
            code={recoveryCode}
            setCode={setRecoveryCode}
            onNext={(token) => {
              setRecoveryToken(token);
              setStep(2);
            }}
            onBack={onBack}
          />
        )}
        {step === 2 && (
          <StepPassword
            recoveryToken={recoveryToken}
            onNext={(res) => {
              setResult(res);
              setStep(3);
            }}
          />
        )}
        {step === 3 && <StepResult result={result} onDone={onDone} />}
      </div>
    </div>
  );
}

function StepCode({ username, setUsername, code, setCode, onNext, onBack }) {
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setErr('');
    try {
      const res = await api.recover(username.trim(), code.trim());
      const token = res.recoveryToken;
      if (!token) throw new Error('服务器未返回恢复令牌');
      onNext(token);
    } catch (ex) {
      setErr(ex.message || '恢复码验证失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <p className="muted small" style={{ marginBottom: 14 }}>
        请输入用户名与注册（或初始化）时保存的恢复码。验证通过后需要设置新密码，旧凭证数据将保留，全部旧会话会被注销。
      </p>
      <label className="field">
        <span>用户名</span>
        <input
          type="text"
          autoComplete="username"
          autoFocus
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          required
        />
      </label>
      <label className="field">
        <span>恢复码</span>
        <input
          type="text"
          className="mono"
          autoComplete="off"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          required
        />
      </label>
      {err && <div className="form-error">{err}</div>}
      <div className="modal-actions">
        <button type="button" className="btn btn-ghost" onClick={onBack} disabled={busy}>
          返回登录
        </button>
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? '验证中…' : '验证恢复码'}
        </button>
      </div>
    </form>
  );
}

function StepPassword({ recoveryToken, onNext }) {
  const [pw1, setPw1] = useState('');
  const [pw2, setPw2] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    if (pw1.length < 8) return setErr('新密码至少 8 位');
    if (pw1 !== pw2) return setErr('两次输入不一致');
    setBusy(true);
    setErr('');
    try {
      const res = await api.recoverComplete({ recoveryToken, newPassword: pw1 });
      onNext(res);
    } catch (ex) {
      setErr(ex.message || '重置失败，请重新开始');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <p className="muted small" style={{ marginBottom: 14 }}>
        恢复码验证通过。请设置新密码（至少 8 位）。
      </p>
      <label className="field">
        <span>新密码（≥8 位）</span>
        <input
          type="password"
          autoComplete="new-password"
          autoFocus
          minLength={8}
          value={pw1}
          onChange={(e) => setPw1(e.target.value)}
          required
        />
      </label>
      <label className="field">
        <span>再次输入</span>
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
      <div className="modal-actions">
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? '重置中…' : '重置密码'}
        </button>
      </div>
    </form>
  );
}

function StepResult({ result, onDone }) {
  const [saved, setSaved] = useState(false);

  // 防止误关闭：确认保存前拦截离开
  useEffect(() => {
    if (saved) return;
    const onBeforeUnload = (e) => e.preventDefault();
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [saved]);

  if (!result) return null;

  return (
    <div>
      <p className="muted small" style={{ marginBottom: 14 }}>
        密码已重置。以下恢复码<strong>仅展示一次</strong>，请立即抄写并妥善保存，关闭本页后将无法再次查看。
      </p>

      <div className="recovery-code-box">
        <span className="small muted">新恢复码</span>
        <div className="code">{result.newRecoveryCode}</div>
      </div>

      <label className="saved-confirm">
        <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
        <span>我已抄写并妥善保存新的恢复码</span>
      </label>

      <div className="modal-actions">
        <button className="btn btn-primary btn-block" disabled={!saved} onClick={onDone}>
          前往登录
        </button>
      </div>
    </div>
  );
}
