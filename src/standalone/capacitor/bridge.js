// Capacitor 启动桥：在 WebView 内装配引擎并注入 globalThis.__QUOTA_ENGINE__，
// 之后同一份 React 前端的 api.js 自动切换到引擎直连（见 src/web/src/api.js）。
import { installNativeFetch } from './fetchShim.js';
import { loadCapacitorStore } from './capacitorStore.js';
import { publishSnapshot } from './widget.js';
import { createEngine } from '../engine.js';

export async function bootstrapQuotaEngine(opts = {}) {
  installNativeFetch();
  const store = await loadCapacitorStore(opts);
  const cpaMgmtUrl = globalThis.__QD_ENV__ && globalThis.__QD_ENV__.cpaMgmtUrl;
  const engine = createEngine({
    store,
    cpaMgmtUrl,
    // codex(CPA) 在安卓也可用：凭证改为手填"管理地址 + key"（见 engine 的 baseUrl 字段），不再假定本机 127.0.0.1
  });
  // 每次取数后刷新桌面小组件快照（非阻塞）
  const _get = engine.getQuota.bind(engine);
  const _refresh = engine.refreshQuota.bind(engine);
  engine.getQuota = async () => {
    const a = await _get();
    publishSnapshot(a);
    return a;
  };
  engine.refreshQuota = async (id) => {
    const a = await _refresh(id);
    publishSnapshot(a);
    return a;
  };
  globalThis.__QUOTA_ENGINE__ = engine;
  return engine;
}
