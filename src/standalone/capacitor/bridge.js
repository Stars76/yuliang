// Capacitor 启动桥：在 WebView 内装配引擎并注入 globalThis.__QUOTA_ENGINE__，
// 之后同一份 React 前端的 api.js 自动切换到引擎直连（见 src/web/src/api.js）。
import { registerPlugin } from '@capacitor/core';
import { installNativeFetch } from './fetchShim.js';
import { loadCapacitorStore } from './capacitorStore.js';
import { publishSnapshot } from './widget.js';
import { createEngine } from '../engine.js';

const SecureCodec = registerPlugin('SecureCodec');

// Android Keystore 加密 codec（AES-256-GCM，密钥不可导出）。
// store 层只需首次加载时的同步 decrypt，因此启动时先把存量密文批量解密成明文初态，
// 之后 seal() 直接用异步加密再落盘（异步持久化本就是 fire-and-forget）。
async function makeKeystoreCodec() {
  const enc = (s) => SecureCodec.encrypt({ plain: s }).then((r) => r.data);
  const dec = (b) => SecureCodec.decrypt({ data: b }).then((r) => r.plain);
  let cache = new Map(); // enc(base64) -> plain，避免同一密文重复走原生桥
  return {
    available: true,
    encrypt: (s) => enc(s),
    decrypt: (b) => {
      if (cache.has(b)) return cache.get(b);
      const p = dec(b).catch((e) => {
        cache.delete(b);
        throw e;
      });
      cache.set(b, p);
      return p;
    },
  };
}

export async function bootstrapQuotaEngine(opts = {}) {
  installNativeFetch();
  let codec = null;
  try {
    codec = await makeKeystoreCodec();
  } catch {
    codec = null; // 插件缺失（如 Web 预览）→ 明文降级，仅本机
  }
  const store = await loadCapacitorStore({ ...opts, codec });
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
