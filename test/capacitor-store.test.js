// capacitorStore 加密链路单测：模拟 SecureCodec 插件（内存 AES 语义替换为可逆变换），
// 验证 ①存量密文预解密 ②新写入落盘为密文 ③解密失败如实降级 ④secure 标志。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCapacitorStore } from '../src/standalone/capacitor/capacitorStore.js';

// 可逆伪加密（测试用）：base64-ish 包裹，非真 AES——只验证链路与形态
const enc = (s) => Buffer.from(`ENC[${s}]`, 'utf8').toString('base64');
const dec = (b) => {
  const s = Buffer.from(b, 'base64').toString('utf8');
  if (!s.startsWith('ENC[') || !s.endsWith(']')) throw new Error('bad ciphertext');
  return s.slice(4, -1);
};
const codec = { available: true, encrypt: async (s) => enc(s), decrypt: async (b) => dec(b) };

function memoryKv(initial = {}) {
  const bag = new Map(Object.entries(initial));
  return {
    getItem: async (k) => bag.get(k) ?? null,
    setItem: async (k, v) => bag.set(k, v),
    dump: () => Object.fromEntries(bag),
  };
}

test('store: 无 codec → 明文落盘、secure=false（旧行为不变）', async () => {
  const kv = memoryKv();
  const store = await loadCapacitorStore({ kv });
  assert.equal(store.secure, false);
  store.insert({ id: 'a', provider: 'deepseek', kind: 'balance', alias: 'x', fields: { apiKey: 'sk-1' }, createdAt: 0 });
  await new Promise((r) => setTimeout(r, 10)); // persist 异步链
  const saved = JSON.parse(kv.dump()['***']);
  assert.equal(saved.secure, false);
  assert.deepEqual(saved.credentials[0].fields.data, { apiKey: 'sk-1' });
  assert.deepEqual(store.all()[0].fields, { apiKey: 'sk-1' });
});

test('store: 有 codec → 落盘是密文、读回明文', async () => {
  const kv = memoryKv();
  const store = await loadCapacitorStore({ kv, codec });
  assert.equal(store.secure, true);
  store.insert({ id: 'a', provider: 'deepseek', kind: 'balance', alias: 'x', fields: { apiKey: 'sk-secret' }, createdAt: 0 });
  await new Promise((r) => setTimeout(r, 20)); // persist 异步链
  const saved = JSON.parse(kv.dump()['***']);
  assert.equal(saved.secure, true);
  const f = saved.credentials[0].fields;
  assert.equal(f.enc, true);
  assert.ok(!JSON.stringify(saved).includes('sk-secret'), '明文不得出现在落盘数据');
  assert.equal(dec(f.data), '{"apiKey":"sk-secret"}');
  assert.deepEqual(store.all()[0].fields, { apiKey: 'sk-secret' });
});

test('store: 存量密文启动时预解密成明文初态', async () => {
  const sealed = { enc: true, data: enc('{"apiKey":"sk-old"}') };
  const kv = memoryKv({ '***': JSON.stringify({ v: 1, secure: true, credentials: [{ id: 'old', provider: 'kimi', kind: 'quota', alias: 'k', fields: sealed, createdAt: 0 }], codexAccounts: [] }) });
  const store = await loadCapacitorStore({ kv, codec });
  assert.deepEqual(store.find('old').fields, { apiKey: 'sk-old' });
});

test('store: 存量密文解密失败 → 如实降级为空凭证（不崩）', async () => {
  const kv = memoryKv({ '***': JSON.stringify({ v: 1, secure: true, credentials: [{ id: 'bad', provider: 'kimi', kind: 'quota', alias: 'k', fields: { enc: true, data: 'not-valid' }, createdAt: 0 }], codexAccounts: [] }) });
  const store = await loadCapacitorStore({ kv, codec });
  assert.deepEqual(store.find('bad').fields, {});
});

test('store: patch 合并后仍加密落盘', async () => {
  const kv = memoryKv();
  const store = await loadCapacitorStore({ kv, codec });
  store.insert({ id: 'p', provider: 'deepseek', kind: 'balance', alias: 'x', fields: { apiKey: 'sk-1' }, createdAt: 0 });
  store.patch('p', { fields: { apiKey: 'sk-2' } });
  await new Promise((r) => setTimeout(r, 20));
  const saved = JSON.parse(kv.dump()['***']);
  assert.equal(dec(saved.credentials[0].fields.data), '{"apiKey":"sk-2"}');
  assert.deepEqual(store.find('p').fields, { apiKey: 'sk-2' });
});
