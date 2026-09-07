// Capacitor 凭证存储：内存态提供与 store.js 相同的同步接口（引擎按同步调用），
// 变更异步落盘到注入的 KV。默认用 @capacitor/preferences（Android 应用私有沙箱）；
// 若要真正的 SecureStorage/Keystore 加密，注入 kv（getItem/setItem）与 codec（encrypt/decrypt）即可，无需改引擎。
const KEY = '***';

function makeMemoryStore(initial, codec, persist) {
  const data = {
    credentials: Array.isArray(initial.credentials) ? initial.credentials : [],
    codexAccounts: Array.isArray(initial.codexAccounts) ? initial.codexAccounts : [],
  };
  const seal = (fields) => (codec ? { enc: true, data: codec.encrypt(JSON.stringify(fields ?? {})) } : { enc: false, data: fields ?? {} });
  const unseal = (e) => (e == null ? {} : e.enc ? JSON.parse(codec.decrypt(e.data)) : typeof e.data === 'string' ? JSON.parse(e.data) : e.data);

  return {
    secure: Boolean(codec),
    all: () => data.credentials.map((c) => ({ ...c, fields: unseal(c.fields) })),
    index: () => data.credentials.map((c) => ({ id: c.id, provider: c.provider, kind: c.kind, alias: c.alias, createdAt: c.createdAt })),
    find: (id) => {
      const c = data.credentials.find((x) => x.id === id);
      return c ? { ...c, fields: unseal(c.fields) } : null;
    },
    insert: (cred) => {
      data.credentials.push({ ...cred, fields: seal(cred.fields) });
      persist(data);
    },
    patch: (id, { alias, fields }) => {
      const c = data.credentials.find((x) => x.id === id);
      if (!c) return false;
      if (typeof alias === 'string' && alias.trim()) c.alias = alias.trim();
      if (fields && typeof fields === 'object') c.fields = seal({ ...unseal(c.fields), ...fields });
      persist(data);
      return true;
    },
    remove: (id) => {
      const before = data.credentials.length;
      data.credentials = data.credentials.filter((x) => x.id !== id);
      data.codexAccounts = data.codexAccounts.filter((a) => a.credId !== id);
      persist(data);
      return before - data.credentials.length;
    },
    codexAccounts: (credId = null) => (credId ? data.codexAccounts.filter((a) => a.credId === credId) : data.codexAccounts.slice()),
    setCodexAccounts: (credId, records) => {
      data.codexAccounts = data.codexAccounts.filter((a) => a.credId !== credId).concat(records);
      persist(data);
      return records.length;
    },
  };
}

export async function loadCapacitorStore({ kv, codec = null } = {}) {
  if (!kv) {
    const { Preferences } = await import('@capacitor/preferences');
    kv = {
      getItem: async (k) => (await Preferences.get({ key: k })).value,
      setItem: async (k, v) => Preferences.set({ key: k, value: v }),
    };
  }
  let initial = { credentials: [], codexAccounts: [] };
  try {
    const raw = await kv.getItem(KEY);
    if (raw) initial = JSON.parse(raw);
  } catch {}
  const persist = (data) => {
    kv.setItem(KEY, JSON.stringify({ v: 1, secure: Boolean(codec), ...data })).catch(() => {});
  };
  return makeMemoryStore(initial, codec, persist);
}
