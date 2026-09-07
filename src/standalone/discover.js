// 自动发现本机已有工具的配置文件 → 候选凭证（脱敏预览，由用户确认后入库）。
// 覆盖 Codex（~/.codex/auth.json → codex-direct）与 OpenCode（auth.json → opencode-go）；
// 其余 provider 无本地文件，走手动。纯 Node（fs/os），仅本机读取，不外发任何内容。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function mask(secret) {
  const s = String(secret ?? '');
  if (s.length <= 8) return '••••';
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

function codexCandidates(home) {
  const out = [];
  const auth = readJson(path.join(home, '.codex', 'auth.json'));
  if (!auth || typeof auth !== 'object') return out;
  const tokens = auth.tokens ?? auth;
  const accessToken = tokens.access_token ?? tokens.accessToken ?? auth.OPENAI_API_KEY ?? null;
  const accountId = tokens.account_id ?? tokens.accountId ?? auth.ACCOUNT_ID ?? null;
  if (accessToken && accountId) {
    out.push({
      provider: 'codex-direct',
      alias: 'Codex（本机）',
      source: path.join('~', '.codex', 'auth.json'),
      fields: { accessToken: String(accessToken), accountId: String(accountId) },
      preview: { accessToken: mask(accessToken), accountId: String(accountId) },
    });
  }
  return out;
}

function opencodeCandidates(home) {
  const out = [];
  const paths = [
    path.join(home, '.local', 'share', 'opencode', 'auth.json'),
    path.join(home, '.config', 'opencode', 'auth.json'),
    path.join(home, 'AppData', 'Roaming', 'opencode', 'auth.json'),
    path.join(home, 'AppData', 'Local', 'opencode', 'auth.json'),
  ];
  for (const p of paths) {
    const auth = readJson(p);
    if (!auth || typeof auth !== 'object' || Array.isArray(auth)) continue;
    for (const [name, entry] of Object.entries(auth)) {
      if (!entry || typeof entry !== 'object') continue;
      const key = entry.key ?? entry.apiKey ?? entry.api_key ?? entry.access ?? entry.token ?? null;
      if (typeof key !== 'string' || key.trim() === '') continue;
      if (!/opencode|zen|go/i.test(name)) continue;
      out.push({
        provider: 'opencode-go',
        alias: `OpenCode（本机 ${name}）`,
        source: relFrom(home, p),
        fields: { apiKey: key },
        preview: { apiKey: mask(key) },
      });
      break;
    }
  }
  return out;
}

function relFrom(home, abs) {
  const rel = path.relative(home, abs);
  return rel && !rel.startsWith('..') ? path.join('~', rel) : abs;
}

export function discoverLocalCredentials({ home = os.homedir() } = {}) {
  const candidates = [...codexCandidates(home), ...opencodeCandidates(home)];
  return { candidates };
}
