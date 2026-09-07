// adapter 注册表：动态 import 惰性加载，文件缺失时 warn 跳过
// zhipu.js 默认导出 zai、命名导出 bigmodel，两个都注册

const ADAPTER_FILES = [
  'codex.js',
  'codex-direct.js',
  'ollama.js',
  'command-code.js',
  'opencode-go.js',
  'kimi.js',
  'zhipu.js',
  'deepseek.js',
  'openrouter.js',
  'sub2api.js',
  'newapi.js',
];

const registry = new Map();
let loadPromise = null;

function register(adapter) {
  if (adapter && typeof adapter.id === 'string') registry.set(adapter.id, adapter);
}

async function loadAll() {
  await Promise.all(
    ADAPTER_FILES.map(async (file) => {
      let mod;
      try {
        mod = await import(new URL(`./${file}`, import.meta.url).href);
      } catch (e) {
        console.warn(`[providers] ${file} 不可用，跳过（${e.code ?? e.message}）`);
        return;
      }
      register(mod.default);
      if (file === 'zhipu.js') register(mod.bigmodel);
    }),
  );
}

function ensureLoaded() {
  loadPromise ??= loadAll();
  return loadPromise;
}

export async function getAdapter(providerId) {
  await ensureLoaded();
  return registry.get(providerId) ?? null;
}

export async function listProviderMeta() {
  await ensureLoaded();
  return [...registry.values()].map((a) => ({
    id: a.id,
    displayName: a.displayName,
    kind: a.kind,
    credentialFields: a.credentialFields ?? [],
  }));
}
