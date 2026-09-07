import { useEffect, useState } from 'react';
import { getTheme, setTheme, isLite } from './util.js';
import Dashboard from './views/Dashboard.jsx';
import Credentials from './views/Credentials.jsx';
import Widgets from './views/Widgets.jsx';

const NAV = [
  { id: 'dashboard', label: '仪表盘' },
  { id: 'credentials', label: '凭证管理' },
];
// 桌面小组件管理仅安卓（Capacitor）可用
const mobile = typeof window !== 'undefined' && !!window.Capacitor;
if (mobile) NAV.push({ id: 'widgets', label: '小组件' });

export default function App() {
  const [view, setView] = useState('dashboard');
  const [theme, setThemeState] = useState(getTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    if (isLite()) document.documentElement.classList.add('lite'); // 安卓 WebView 关闭毛玻璃/固定背景/持续动画
  }, []);

  function toggleTheme() {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    setThemeState(next);
    // 桌面小组件跟随主题（仅 Capacitor）
    try {
      window.Capacitor?.Plugins?.QuotaWidget?.setTheme({ theme: next }).catch(() => {});
    } catch {}
  }

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <img className="brand-logo" src="/icons/logo.png" alt="余量" />
          余量
        </div>
        <nav className="nav" aria-label="主导航">
          {NAV.map((n) => (
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
      </header>
      <main className="main">
        {view === 'dashboard' && <Dashboard />}
        {view === 'credentials' && <Credentials />}
        {view === 'widgets' && mobile && <Widgets />}
      </main>
    </div>
  );
}
