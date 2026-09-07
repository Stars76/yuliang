import { useEffect, useRef, useState } from 'react';

// step-up 对话框：密码（+ TOTP，仅当该用户已开启时），调用 onConfirm({password, totp})，成功返回 true 才关闭
export default function StepUpModal({ title, desc, totpEnabled = true, onConfirm, onClose }) {
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const pwRef = useRef(null);

  useEffect(() => {
    pwRef.current?.focus();
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function submit(e) {
    e.preventDefault();
    if (!password || (totpEnabled && !/^\d{6}$/.test(totp))) {
      setErr(totpEnabled ? '请输入密码与 6 位动态验证码' : '请输入密码');
      return;
    }
    setBusy(true);
    setErr('');
    try {
      const ok = await onConfirm({ password, totp: totpEnabled ? totp : '' });
      if (ok !== false) onClose();
    } catch (ex) {
      setErr(ex.message || '验证失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="modal card" onSubmit={submit} role="dialog" aria-modal="true" aria-label={title}>
        <h3>{title}</h3>
        {desc && <p className="modal-desc">{desc}</p>}
        <label className="field">
          <span>密码</span>
          <input
            ref={pwRef}
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        {totpEnabled && (
          <label className="field">
            <span>动态验证码（TOTP）</span>
            <input
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              placeholder="6 位数字"
              value={totp}
              onChange={(e) => setTotp(e.target.value.replace(/\D/g, ''))}
              required
            />
          </label>
        )}
        {err && <div className="form-error">{err}</div>}
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? '验证中…' : '确认'}
          </button>
        </div>
      </form>
    </div>
  );
}
