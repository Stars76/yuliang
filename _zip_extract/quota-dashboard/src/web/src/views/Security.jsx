import { useEffect, useRef, useState } from 'react';
import { api, exportBackup } from '../api.js';
import StepUpModal from '../components/StepUpModal.jsx';
import { useToast } from '../components/Toast.jsx';

// user: {username, role, totpEnabled}；onUserChange 在 TOTP 开关后刷新全局状态
export default function Security({ user, onUserChange, onGoRecover }) {
  const [modal, setModal] = useState(null); // 'changePw' | 'revoke' | 'export' | 'totpDisable' | {type, ...}
  const toast = useToast();
  const importFileRef = useRef(null);
  const totpEnabled = Boolean(user?.totpEnabled);

  async function onPickImportFile(e) {
    const file = e.target.files?.[0];
    e.target.value = ''; // 允许重复选择同一文件
    if (!file) return;
    if (file.size > 64 * 1024) {
      toast('备份文件过大');
      return;
    }
    const backup = await file.text();
    setModal({ type: 'import', backup, name: file.name });
  }

  return (
    <div className="security-page">
      <h2 className="page-title">安全设置</h2>

      <div className="card security-item">
        <div>
          <h3>两步验证（TOTP，可选）</h3>
          <p className="muted small">
            {totpEnabled
              ? '已开启。导出备份、修改密码等敏感操作需要额外输入动态验证码。'
              : '未开启。开启后敏感操作需额外输入 Authenticator 动态验证码。'}
          </p>
        </div>
        {totpEnabled ? (
          <button className="btn btn-ghost" onClick={() => setModal('totpDisable')}>关闭</button>
        ) : (
          <button className="btn btn-primary" onClick={() => setModal('totpEnable')}>开启</button>
        )}
      </div>

      <div className="card security-item">
        <div>
          <h3>修改密码</h3>
          <p className="muted small">至少 8 位，修改后其他设备需要重新登录。</p>
        </div>
        <button className="btn btn-primary" onClick={() => setModal('changePw')}>修改密码</button>
      </div>

      <div className="card security-item">
        <div>
          <h3>注销其他会话</h3>
          <p className="muted small">保留当前会话，强制其他设备下线。</p>
        </div>
        <button className="btn btn-primary" onClick={() => setModal('revoke')}>注销其他会话</button>
      </div>

      <div className="card security-item">
        <div>
          <h3>导出加密备份</h3>
          <p className="muted small">使用独立导出密码加密，可离线保存。</p>
        </div>
        <button className="btn btn-primary" onClick={() => setModal('export')}>导出备份</button>
      </div>

      <div className="card security-item">
        <div>
          <h3>导入备份</h3>
          <p className="muted small">从加密备份文件恢复。警告：导入将覆盖当前全部凭证与 Codex 账号选择（登录会话不受影响）。</p>
        </div>
        <button className="btn btn-primary" onClick={() => importFileRef.current?.click()}>选择备份文件</button>
        <input
          ref={importFileRef}
          type="file"
          accept=".enc,.json,application/octet-stream,application/json"
          hidden
          onChange={onPickImportFile}
        />
      </div>

      <div className="card security-item">
        <div>
          <h3>恢复账户</h3>
          <p className="muted small">忘记密码时，可使用注册（或初始化）时保存的恢复码重置密码。</p>
        </div>
        <button className="btn btn-ghost" onClick={onGoRecover}>前往恢复视图</button>
      </div>

      {modal === 'totpEnable' && (
        <StepUpModal
          title="开启两步验证"
          desc="验证密码后，将生成绑定密钥。"
          totpEnabled={false}
          onConfirm={async ({ password }) => {
            const r = await api.totpBegin({ password });
            setModal({ type: 'totpConfirm', ...r });
            return true;
          }}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.type === 'totpConfirm' && (
        <TotpConfirmModal
          secret={modal.totpSecret}
          uri={modal.totpUri}
          onConfirm={async (code) => {
            await api.totpConfirm({ code });
            toast('两步验证已开启', 'ok');
            onUserChange?.();
            return true;
          }}
          onClose={() => setModal(null)}
        />
      )}
      {modal === 'totpDisable' && (
        <StepUpModal
          title="关闭两步验证"
          desc="验证密码即可关闭。关闭后敏感操作只需密码。"
          totpEnabled={false}
          onConfirm={async ({ password }) => {
            await api.totpDisable({ password });
            toast('两步验证已关闭', 'ok');
            onUserChange?.();
            return true;
          }}
          onClose={() => setModal(null)}
        />
      )}
      {modal === 'changePw' && (
        <StepUpModal
          title="修改密码"
          desc={totpEnabled ? '请输入当前密码与动态验证码。' : '请输入当前密码。'}
          totpEnabled={totpEnabled}
          onConfirm={async ({ password, totp }) => {
            setModal({ type: 'changePw2', password, totp });
            return true;
          }}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.type === 'changePw2' && (
        <NewPasswordModal
          onConfirm={async (newPassword) => {
            await api.changePassword({ password: modal.password, totp: modal.totp, newPassword });
            toast('密码已修改', 'ok');
            return true;
          }}
          onClose={() => setModal(null)}
        />
      )}
      {modal === 'revoke' && (
        <StepUpModal
          title="注销其他会话"
          desc="除当前会话外的所有会话将被强制下线。"
          totpEnabled={totpEnabled}
          onConfirm={async ({ password, totp }) => {
            await api.revokeOthers({ password, totp });
            toast('已注销其他会话', 'ok');
            return true;
          }}
          onClose={() => setModal(null)}
        />
      )}
      {modal === 'export' && (
        <StepUpModal
          title="导出加密备份"
          desc="下一步设置导出密码。"
          totpEnabled={totpEnabled}
          onConfirm={async ({ password, totp }) => {
            setModal({ type: 'export2', password, totp });
            return true;
          }}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.type === 'export2' && (
        <ExportPasswordModal
          onConfirm={async (exportPassword) => {
            await exportBackup({ password: modal.password, totp: modal.totp, exportPassword });
            toast('备份已开始下载', 'ok');
            return true;
          }}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.type === 'import' && (
        <ImportModal
          fileName={modal.name}
          totpEnabled={totpEnabled}
          onConfirm={async ({ password, totp, exportPassword }) => {
            const r = await api.importBackup({ password, totp, exportPassword, backup: modal.backup });
            toast(`已导入 ${r.imported.credentials} 条凭证、${r.imported.codexAccounts} 个 Codex 账号，请刷新页面`, 'ok');
            return true;
          }}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}

// 开启 TOTP 第二步：展示密钥，输入 Authenticator 里的 6 位验证码完成绑定
function TotpConfirmModal({ secret, uri, onConfirm, onClose }) {
  const [code, setCode] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  async function submit(e) {
    e.preventDefault();
    if (!/^\d{6}$/.test(code)) return setErr('请输入 6 位动态验证码');
    setBusy(true);
    setErr('');
    try {
      await onConfirm(code);
      onClose();
    } catch (ex) {
      setErr(ex.message || '绑定失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="modal card" onSubmit={submit} role="dialog" aria-modal="true" aria-label="绑定两步验证">
        <h3>绑定 Authenticator</h3>
        <p className="modal-desc">把下面的密钥录入 Authenticator 应用（或扫码工具导入 URI），然后输入生成的 6 位验证码完成绑定。</p>
        <div className="secret-box">
          <span className="small muted">TOTP 密钥</span>
          <span className="secret-value">{secret}</span>
          <span className="small muted">otpauth URI</span>
          <span className="secret-value" style={{ fontSize: 11 }}>{uri}</span>
        </div>
        <label className="saved-confirm">
          <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
          <span>我已保存该密钥</span>
        </label>
        <label className="field">
          <span>动态验证码</span>
          <input
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            placeholder="6 位数字"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            required
          />
        </label>
        {err && <div className="form-error">{err}</div>}
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>取消</button>
          <button type="submit" className="btn btn-primary" disabled={busy || !saved}>{busy ? '绑定中…' : '完成绑定'}</button>
        </div>
      </form>
    </div>
  );
}

function NewPasswordModal({ onConfirm, onClose }) {
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
      await onConfirm(pw1);
      onClose();
    } catch (ex) {
      setErr(ex.message || '修改失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="modal card" onSubmit={submit} role="dialog" aria-modal="true">
        <h3>设置新密码</h3>
        <label className="field">
          <span>新密码（≥8 位）</span>
          <input type="password" autoComplete="new-password" value={pw1} onChange={(e) => setPw1(e.target.value)} minLength={8} required />
        </label>
        <label className="field">
          <span>再次输入</span>
          <input type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} minLength={8} required />
        </label>
        {err && <div className="form-error">{err}</div>}
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>取消</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? '提交中…' : '确认修改'}</button>
        </div>
      </form>
    </div>
  );
}

function ExportPasswordModal({ onConfirm, onClose }) {
  const [pw1, setPw1] = useState('');
  const [pw2, setPw2] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    if (pw1.length < 8) return setErr('导出密码至少 8 位');
    if (pw1 !== pw2) return setErr('两次输入不一致');
    setBusy(true);
    setErr('');
    try {
      await onConfirm(pw1);
      onClose();
    } catch (ex) {
      setErr(ex.message || '导出失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="modal card" onSubmit={submit} role="dialog" aria-modal="true">
        <h3>设置导出密码</h3>
        <p className="modal-desc">备份文件将使用该密码加密，请妥善保存，恢复时需要。</p>
        <label className="field">
          <span>导出密码（≥8 位）</span>
          <input type="password" autoComplete="new-password" value={pw1} onChange={(e) => setPw1(e.target.value)} minLength={8} required />
        </label>
        <label className="field">
          <span>再次输入</span>
          <input type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} minLength={8} required />
        </label>
        {err && <div className="form-error">{err}</div>}
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>取消</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? '导出中…' : '导出'}</button>
        </div>
      </form>
    </div>
  );
}

// 导入弹窗：密码（+ TOTP 若已开启）+ 导出密码（备份文本由文件选择阶段读入，经 onConfirm 提交）
function ImportModal({ fileName, totpEnabled, onConfirm, onClose }) {
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [exportPassword, setExportPassword] = useState('');
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
      return setErr(totpEnabled ? '请输入密码与 6 位动态验证码' : '请输入密码');
    }
    if (!exportPassword) return setErr('请输入导出密码');
    setBusy(true);
    setErr('');
    try {
      await onConfirm({ password, totp, exportPassword });
      onClose();
    } catch (ex) {
      setErr(ex.message || '导入失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="modal card" onSubmit={submit} role="dialog" aria-modal="true" aria-label="导入备份">
        <h3>导入备份</h3>
        <p className="modal-desc">将恢复「{fileName}」中的凭证与 Codex 账号选择，并覆盖当前数据。</p>
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
        <label className="field">
          <span>导出密码（备份时设置）</span>
          <input
            type="password"
            autoComplete="off"
            value={exportPassword}
            onChange={(e) => setExportPassword(e.target.value)}
            required
          />
        </label>
        {err && <div className="form-error">{err}</div>}
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>取消</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? '导入中…' : '导入'}</button>
        </div>
      </form>
    </div>
  );
}
