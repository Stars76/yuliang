// WebView/Capacitor 专用 provider 注册表：静态 import 全部 adapter，避免 providers/index.js 的
// 运行时动态 import(new URL(`./${f}`, import.meta.url)) 在打包后的浏览器里解析不到哈希文件名而失败
// （Electron 真 Node 能跑，WebView 不行）。仅经 capacitor vite 配置别名替换 server/providers/index.js。
import codex from './providers/codex.js';
import codexDirect from './providers/codex-direct.js';
import ollama from './providers/ollama.js';
import commandCode from './providers/command-code.js';
import opencodeGo from './providers/opencode-go.js';
import kimi from './providers/kimi.js';
import zai, { bigmodel } from './providers/zhipu.js';
import deepseek from './providers/deepseek.js';
import openrouter from './providers/openrouter.js';
import sub2api from './providers/sub2api.js';
import newapi from './providers/newapi.js';

const registry = new Map();
for (const a of [codex, codexDirect, ollama, commandCode, opencodeGo, kimi, zai, bigmodel, deepseek, openrouter, sub2api, newapi]) {
  if (a && typeof a.id === 'string') registry.set(a.id, a);
}

export async function getAdapter(providerId) {
  return registry.get(providerId) ?? null;
}

export async function listProviderMeta() {
  return [...registry.values()].map((a) => ({
    id: a.id,
    displayName: a.displayName,
    kind: a.kind,
    credentialFields: a.credentialFields ?? [],
  }));
}
