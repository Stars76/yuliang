// 单机凭证本地存储：单用户、无密码、无信封。
// 密钥材料（credentials[].fields）经注入的 codec 加密后落盘；codec 缺省时降级为本机明文 JSON（仅供本机、不联网）。
// 索引（不含密钥材料）用于 UI 展示；codexAccounts 本身不含密钥，明文保存。
import fs from 'node:fs';
import path from 'node:path';

const FILE = 'credentials.json';

// codec: { available: true, encrypt(str): string, decrypt(str): string } —— 由平台注入（如 electron.safeStorage）
export function createFileStore({ dataDir, codec = null }) {
  const file = path.join(dataDir, FILE);
  const secure = Boolean(codec && codec.available);
  let cache = null;

  function seal(fields) {
    const plain = JSON.stringify(fields ?? {});
    return secure ? { enc: true, data: codec.encrypt(plain) } : { enc: false, data: fields ?? {} };
  }

  function unseal(entry) {
    if (!entry || entry.data == null) return {};
    if (entry.enc) return JSON.parse(codec.decrypt(entry.data));
    return typeof entry.data === 'string' ? JSON.parse(entry.data) : entry.data;
  }

  function loadRaw() {
    if (cache) return cache;
    try {
      const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
      cache = {
        v: 1,
        credentials: Array.isArray(obj.credentials) ? obj.credentials : [],
        codexAccounts: Array.isArray(obj.codexAccounts) ? obj.codexAccounts : [],
      };
    } catch {
      cache = { v: 1, credentials: [], codexAccounts: [] };
    }
    return cache;
  }

  function persist() {
    fs.mkdirSync(dataDir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    const body = JSON.stringify(
      {
        v: 1,
        secure,
        credentials: cache.credentials,
        codexAccounts: cache.codexAccounts,
      },
      null,
      2,
    );
    fs.writeFileSync(tmp, body, { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  return {
    secure,
    // 全量凭证（fields 已解密，仅在内存/引擎内使用，绝不回传前端）
    all() {
      return loadRaw().credentials.map((c) => ({ ...c, fields: unseal(c.fields) }));
    },
    index() {
      return loadRaw().credentials.map((c) => ({
        id: c.id,
        provider: c.provider,
        kind: c.kind,
        alias: c.alias,
        createdAt: c.createdAt,
      }));
    },
    find(id) {
      const c = loadRaw().credentials.find((x) => x.id === id);
      return c ? { ...c, fields: unseal(c.fields) } : null;
    },
    insert(cred) {
      loadRaw().credentials.push({ ...cred, fields: seal(cred.fields) });
      persist();
    },
    replace(cred) {
      const list = loadRaw().credentials;
      const i = list.findIndex((x) => x.id === cred.id);
      if (i < 0) return false;
      list[i] = { ...list[i], alias: cred.alias, fields: seal(cred.fields) };
      persist();
      return true;
    },
    patch(id, { alias, fields }) {
      const c = loadRaw().credentials.find((x) => x.id === id);
      if (!c) return false;
      if (typeof alias === 'string' && alias.trim()) c.alias = alias.trim();
      if (fields && typeof fields === 'object') {
        const merged = { ...unseal(c.fields) };
        for (const [k, v] of Object.entries(fields)) {
          if (typeof v === 'string' && v !== '') merged[k] = v;
        }
        c.fields = seal(merged);
      }
      persist();
      return true;
    },
    remove(id) {
      const data = loadRaw();
      const before = data.credentials.length;
      data.credentials = data.credentials.filter((x) => x.id !== id);
      data.codexAccounts = data.codexAccounts.filter((a) => a.credId !== id);
      if (data.credentials.length !== before) persist();
      return before - data.credentials.length;
    },
    codexAccounts(credId = null) {
      const list = loadRaw().codexAccounts;
      return credId ? list.filter((a) => a.credId === credId) : list.slice();
    },
    setCodexAccounts(credId, records) {
      const data = loadRaw();
      data.codexAccounts = data.codexAccounts.filter((a) => a.credId !== credId).concat(records);
      persist();
      return records.length;
    },
  };
}
