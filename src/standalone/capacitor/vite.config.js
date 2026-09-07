import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const DISCOVER = fileURLToPath(new URL('../discover.js', import.meta.url));
const DISCOVER_WEB = fileURLToPath(new URL('../discover.web.js', import.meta.url));
const PROVIDERS_WEB = fileURLToPath(new URL('../providers.web.js', import.meta.url));

// WebView 打包时替换两处 Node-only 依赖：
//  • discover.js → 空实现（依赖 node:fs）
//  • providers/index.js → 静态注册表（动态 import 在打包后的 WebView 里解析不到哈希文件名）
//  注意：resolveId 收到的是相对源串（'./providers/index.js'），必须按短后缀匹配——
//  曾经写成 'standalone/providers/index.js' 导致引擎搬家后 shim 静默失效、手机端 provider 全空。
function webShims() {
  return {
    name: 'web-shims',
    enforce: 'pre',
    resolveId(source) {
      if (source.endsWith('discover.js')) return DISCOVER;
      if (source.endsWith('providers/index.js')) return PROVIDERS_WEB;
      return null;
    },
    load(id) {
      if (id === DISCOVER) return `export * from ${JSON.stringify(DISCOVER_WEB)};`;
      return null;
    },
  };
}

// 构建后从 www/ 删除 Web 专属死文件（sw.js 在 Capacitor 壳从未注册；manifest 是 PWA 用）
function dropWebOnlyFiles() {
  return {
    name: 'drop-web-only',
    closeBundle() {
      const www = resolve(here, 'www');
      for (const f of ['sw.js', 'manifest.webmanifest']) {
        try { rmSync(resolve(www, f), { force: true }); } catch {}
      }
    },
  };
}

// Capacitor webDir 构建：入口本目录 index.html（capacitor-entry.jsx → 引擎直连）；base './' 供 WebView 相对加载。
const appVersion = JSON.parse(readFileSync(fileURLToPath(new URL('../../../package.json', import.meta.url)), 'utf8')).version;

export default defineConfig({
  root: here,
  base: './',
  plugins: [webShims(), dropWebOnlyFiles(), react()],
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  publicDir: fileURLToPath(new URL('../../web/public', import.meta.url)),
  build: {
    outDir: 'www',
    emptyOutDir: true,
    sourcemap: false,
  },
});
