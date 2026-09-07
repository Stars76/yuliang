import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useToast, Spinner } from '../components/Toast.jsx';

function fmtTime(ts) {
  if (!ts) return '从未';
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}

// 用户管理（仅管理员可见）：只有元信息，管理员无法接触任何用户的密钥
export default function Users({ me }) {
  const [users, setUsers] = useState(null);
  const [busy, setBusy] = useState('');
  const toast = useToast();

  const load = useCallback(async () => {
    try {
      const r = await api.listUsers();
      setUsers(r.users);
    } catch (ex) {
      toast(ex.message || '加载失败');
    }
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  async function act(kind, username) {
    const label = { disable: '禁用', enable: '启用', delete: '删除' }[kind];
    if (kind === 'delete' && !window.confirm(`确定删除用户「${username}」？其全部数据将被永久删除，无法恢复。`)) return;
    setBusy(`${kind}:${username}`);
    try {
      await api[{ disable: 'disableUser', enable: 'enableUser', delete: 'deleteUser' }[kind]](username);
      toast(`已${label} ${username}`, 'ok');
      await load();
    } catch (ex) {
      toast(ex.message || `${label}失败`);
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="users-page">
      <h2 className="page-title">用户管理</h2>

      <div className="card privacy-card">
        <h3>隐私承诺</h3>
        <p className="muted small">
          每个用户的密钥都由其各自的登录密码加密（scrypt + AES-256-GCM）。没有用户的密码，任何人——包括你（管理员）——都无法解密其数据。
          这里只能看到用户名、状态与时间等元信息；系统没有查看、导出或重置他人密钥的入口。忘记密码的用户只能凭自己的恢复码自助重置。
        </p>
      </div>

      {users === null ? (
        <Spinner label="加载用户列表…" />
      ) : (
        <div className="card">
          <table className="users-table">
            <thead>
              <tr>
                <th>用户名</th>
                <th>角色</th>
                <th>状态</th>
                <th>注册时间</th>
                <th>最近登录</th>
                <th className="ops">操作</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.username}>
                  <td className="mono">{u.username}</td>
                  <td>
                    <span className={`badge${u.role === 'admin' ? ' badge-blue' : ' badge-gray'}`}>
                      {u.role === 'admin' ? '管理员' : '用户'}
                    </span>
                  </td>
                  <td>
                    <span className={`badge${u.status === 'active' ? ' badge-green' : ' badge-red'}`}>
                      {u.status === 'active' ? '正常' : '已禁用'}
                    </span>
                  </td>
                  <td className="small muted">{fmtTime(u.createdAt)}</td>
                  <td className="small muted">{fmtTime(u.lastLoginAt)}</td>
                  <td className="ops">
                    {u.username.toLowerCase() !== me?.toLowerCase() && u.role !== 'admin' && (
                      <>
                        {u.status === 'active' ? (
                          <button
                            className="btn btn-ghost btn-xs"
                            disabled={busy}
                            onClick={() => act('disable', u.username)}
                          >
                            禁用
                          </button>
                        ) : (
                          <button
                            className="btn btn-ghost btn-xs"
                            disabled={busy}
                            onClick={() => act('enable', u.username)}
                          >
                            启用
                          </button>
                        )}
                        <button
                          className="btn btn-ghost btn-xs danger"
                          disabled={busy}
                          onClick={() => act('delete', u.username)}
                        >
                          删除
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
