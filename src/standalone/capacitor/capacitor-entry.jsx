import ReactDOM from 'react-dom/client';
import App from '../../web/src/App.jsx';
import { ToastProvider } from '../../web/src/components/Toast.jsx';
import ErrorBoundary from '../../web/src/components/ErrorBoundary.jsx';
import { bootstrapQuotaEngine } from './bridge.js';
import '../../web/src/styles.css';

const el = document.getElementById('root');
ReactDOM.createRoot(el).render(
  <div className="boot">
    <span className="spinner" aria-hidden="true" />
    <span>正在初始化…</span>
  </div>,
);

// 状态栏：跟随主题设置背景色与图标明暗，消除顶部灰条（插件缺失则静默跳过）。
async function setupStatusBar() {
  try {
    const { StatusBar, Style } = await import('@capacitor/status-bar');
    const apply = () => {
      const light = document.documentElement.dataset.theme === 'light';
      StatusBar.setStyle({ style: light ? Style.LIGHT : Style.DARK }).catch(() => {});
      StatusBar.setBackgroundColor({ color: light ? '#edf0f8' : '#05070d' }).catch(() => {});
    };
    apply();
    new MutationObserver(apply).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  } catch {}
}

bootstrapQuotaEngine()
  .then(async (engine) => {
    el.replaceChildren();
    ReactDOM.createRoot(el).render(
      <ErrorBoundary>
        <ToastProvider>
          <App />
        </ToastProvider>
      </ErrorBoundary>,
    );
    setupStatusBar();
    // 小组件 ↻ 按钮：launch intent 携带 widget_refresh=1 → 打开 App 即自动刷新一轮额度。
    // Android 上 Capacitor 会把 intent extras 合入 window.launchExtras（新版桥）；读不到就静默跳过。
    try {
      const extras = globalThis.window?.launchExtras ?? null;
      if (extras && (extras.widget_refresh === true || extras.widget_refresh === 'true')) {
        setTimeout(() => engine.refreshQuota().catch(() => {}), 600);
      }
    } catch {}
  })
  .catch((e) => {
    el.replaceChildren();
    el.textContent = `启动失败：${e?.message ?? e}`;
  });
