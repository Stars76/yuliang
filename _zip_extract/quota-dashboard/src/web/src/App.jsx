import { useCallback, useEffect, useState } from 'react';
import { api, setUnauthorizedHandler } from './api.js';
import { getTheme, setTheme } from './util.js';
import { Spinner } from './components/Toast.jsx';
import Login from './views/Login.jsx';
import Dashboard from './views/Dashboard.jsx';
import Credentials from './views/Credentials.jsx';
import Security from './views/Security.jsx';
import Audit from './views/Audit.jsx';
import Users from './views/Users.jsx';
import Recover from './views/Recover.jsx';

const NAV = [
  { id: 'dashboard', label: '仪表盘' },
  { id: 'credentials', label: '凭证管理' },
  { id: 'security', label: '安全' },
  { id: 'audit', label: '审计' },
  { id: 'users', label: '用户管理', admin: true },
];

export default function App() {
  // boot: 探测中；login: 登录页；recover: 恢复视图；app: 已登录
  const [phase, setPhase] = useState('boot');
  const [status, setStatus] = useState(null);
  const [view, setView] = useState('dashboard');
  const [theme, setThemeState] = useState(getTheme);

  function toggleTheme() {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    setThemeState(next);
  }

  const checkStatus = useCallback(async () => {
    try {
      const s = await api.status();
      setStatus(s);
      setPhase(s.authenticated ? 'app' : 'login');
    } catch {
      setPhase('login');
    }
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setStatus((s) => (s ? { ...s, authenticated: false } : s));
      setPhase('login');
    });
    checkStatus();
  }, [checkStatus]);

  // keepalive：标签页开着就每 5 分钟探一次，配合服务端滑动续期，session 不过期
  useEffect(() => {
    if (phase !== 'app') return;
    const ping = () => api.status().catch(() => {});
    const id = setInterval(ping, 5 * 60 * 1000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') ping();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [phase]);

  async function handleLogout() {
    try {
      await api.logout();
    } catch {}
    setStatus((s) => (s ? { ...s, authenticated: false } : s));
    setPhase('login');
  }

  if (phase === 'boot') {
    return (
      <div className="boot">
        <Spinner label="正在连接服务器…" />
      </div>
    );
  }

  if (phase === 'recover') {
    return <Recover onBack={() => setPhase('login')} onDone={checkStatus} />;
  }

  if (phase === 'login') {
    return (
      <Login
        initialized={status?.initialized !== false}
        onSuccess={checkStatus}
        onRecover={() => setPhase('recover')}
      />
    );
  }

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <img className="brand-logo" src="/icons/logo.png" alt="EntropicEcho" />
          EntropicEcho额度聚合面板
        </div>
        <nav className="nav" aria-label="主导航">
          {NAV.filter((n) => !n.admin || status?.user?.role === 'admin').map((n) => (
            <button
              key={n.id}
              className={`nav-btn${view === n.id ? ' active' : ''}`}
              onClick={() => setView(n.id)}
            >
              {n.label}
            </button>
          ))}
        </nav>
        <button
          className="theme-toggle"
          onClick={toggleTheme}
          title={theme === 'dark' ? '切换到浅色主题' : '切换到深色主题'}
          aria-label="切换主题"
        >
          {theme === 'dark' ? (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <circle cx="12" cy="12" r="4" />
              <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
            </svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
            </svg>
          )}
        </button>
        <div className="topbar-user" title="当前登录用户">
          <span className="topbar-username">{status?.user?.username}</span>
          {status?.user?.role === 'admin' && <span className="badge badge-blue">管理员</span>}
        </div>
      </header>
      <main className="main">
        {view === 'dashboard' && <Dashboard onLogout={handleLogout} />}
        {view === 'credentials' && <Credentials />}
        {view === 'security' && <Security user={status?.user} onUserChange={checkStatus} onGoRecover={() => setPhase('recover')} />}
        {view === 'audit' && <Audit />}
        {view === 'users' && status?.user?.role === 'admin' && <Users me={status?.user?.username} />}
      </main>
    </div>
  );
}
