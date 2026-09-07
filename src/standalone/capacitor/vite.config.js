import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const DISCOVER = fileURLToPath(new URL('../discover.js', import.meta.url));
const DISCOVER_WEB = fileURLToPath(new URL('../discover.web.js', import.meta.url));
const PROVIDERS_WEB = fileURLToPath(new URL('../providers.web.js', import.meta.url));

// WebView 打包时替换两处 Node-only 依赖：
//  • discover.js → 空实现（依赖 node:fs）
//  • standalone/providers/index.js → 静态注册表（避免运行时动态 import 在打包后解析不到哈希文件名）
function webShims() {
  return {
    name: 'web-shims',
    enforce: 'pre',
    resolveId(source) {
      if (source.endsWith('discover.js')) return DISCOVER;
      if (source.endsWith('standalone/providers/index.js')) return PROVIDERS_WEB;
      return null;
    },
    load(id) {
      if (id === DISCOVER) return `export * from ${JSON.stringify(DISCOVER_WEB)};`;
      return null;
    },
  };
}

// Capacitor webDir 构建：入口本目录 index.html（capacitor-entry.jsx → 引擎直连）；base './' 供 WebView 相对加载。
export default defineConfig({
  root: here,
  base: './',
  plugins: [webShims(), react()],
  publicDir: fileURLToPath(new URL('../../web/public', import.meta.url)),
  build: {
    outDir: 'www',
    emptyOutDir: true,
    sourcemap: false,
  },
});
