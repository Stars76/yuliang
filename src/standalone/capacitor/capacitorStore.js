// Capacitor 凭证存储：内存态提供与 store.js 相同的同步接口（引擎按同步调用），
// 变更异步落盘到注入的 KV。默认用 @capacitor/preferences（Android 应用私有沙箱）。
// codec（Keystore AES-GCM，由 bridge.js 注入，encrypt/decrypt 均为异步）：
//  • load 时把存量密文【预解密】成明文初态——内存里始终是明文对象，引擎同步读零感知；
//  • 写入时 seal() 同步持有明文 + 异步生成密文，persist 链里统一 await 后落盘。
//    内存中的 fields 双轨：{enc:false,data:明文对象}（立即读）→ await 后 {enc:true,data:密文}（持久化形态），
//    避免任何时刻把明文之外的东西写盘，也避免同步读撞上未完成的 Promise。
const KEY = '***';

function makeMemoryStore(initial, codec, persist) {
  const data = {
    credentials: Array.isArray(initial.credentials) ? initial.credentials : [],
    codexAccounts: Array.isArray(initial.codexAccounts) ? initial.codexAccounts : [],
  };

  // 内存条目统一形态：fields = { enc:false, data:明文对象 }；密文只在 persist 边界出现
  const toMemory = (cred) => ({ ...cred, fields: { enc: false, data: cred.fields ?? {} } });

  const unseal = (c) => (c?.fields?.data ?? {});

  return {
    secure: Boolean(codec),
    all: () => data.credentials.map((c) => ({ ...c, fields: { ...unseal(c) } })),
    index: () => data.credentials.map((c) => ({ id: c.id, provider: c.provider, kind: c.kind, alias: c.alias, createdAt: c.createdAt })),
    find: (id) => {
      const c = data.credentials.find((x) => x.id === id);
      return c ? { ...c, fields: { ...unseal(c) } } : null;
    },
    insert: (cred) => {
      data.credentials.push(toMemory(cred));
      persist(data);
    },
    patch: (id, { alias, fields }) => {
      const c = data.credentials.find((x) => x.id === id);
      if (!c) return false;
      if (typeof alias === 'string' && alias.trim()) c.alias = alias.trim();
      if (fields && typeof fields === 'object') c.fields.data = { ...c.fields.data, ...fields };
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
  // 存量密文 → 预解密为明文内存态；解密失败（如 Keystore 密钥被清）→ 如实降级为空凭证
  if (Array.isArray(initial.credentials)) {
    for (const c of initial.credentials) {
      if (c?.fields?.enc === true) {
        let fields = {};
        if (codec && typeof c.fields.data === 'string') {
          try {
            fields = JSON.parse(await codec.decrypt(c.fields.data));
          } catch {}
        } else if (!c.fields.enc && c.fields.data && typeof c.fields.data === 'object') {
          fields = c.fields.data; // 旧明文数据平滑迁移
        }
        c.fields = { enc: false, data: fields };
      }
    }
  }
  // persist：把内存明文态序列化为持久化形态（无 codec=明文对象；有 codec=await 后的密文字符串）
  // sealFor 与 persist 同层（都需要 codec）——注意它不能放进 makeMemoryStore（那边拿不到 codec）
  const sealFor = (c) => {
    if (!codec) return { enc: false, data: c.fields.data ?? {} };
    return { enc: true, data: Promise.resolve(codec.encrypt(JSON.stringify(c.fields.data ?? {}))) };
  };
  const persist = (data) => {
    Promise.all(
      (data.credentials ?? []).map(async (c) => {
        const s = sealFor(c);
        if (s.enc) return { ...c, fields: { enc: true, data: await s.data } };
        return c;
      }),
    )
      .then((credentials) => {
        kv.setItem(KEY, JSON.stringify({ v: 1, secure: Boolean(codec), credentials, codexAccounts: data.codexAccounts })).catch(() => {});
      })
      .catch(() => {});
  };
  return makeMemoryStore(initial, codec, persist);
}
