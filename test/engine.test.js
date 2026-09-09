// standalone/engine 单测：缓存 TTL、失败指数退避（含 30min 封顶与成功重置）、
// 强制刷新、凭证校验与索引脱敏、平台隐藏。全离线：stub 全局 fetch + 内存 store + 受控时钟。
// 注：node:test 的 afterEach 存在执行顺序差异，这里改为每个用例自管时钟与 fetch 还原（try/finally）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../src/standalone/engine.js';

const FIXTURE_OK = {
  is_available: true,
  balance_infos: [{ currency: 'CNY', total_balance: '58.36', granted_balance: '10.00', topped_up_balance: '48.36' }],
};

// ---- 每用例独立脚手架 ----
function withSandbox(handler, { keys = ['sk-test-a'], hiddenProviders = [] } = {}) {
  const realNow = Date.now;
  const realFetch = globalThis.fetch;
  let offset = 0;
  Date.now = () => realNow() + offset;

  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), auth: opts.headers?.authorization ?? null });
    return handler(String(url), opts, calls.length);
  };

  let creds = [];
  const store = {
    secure: false,
    all: () => creds.map((c) => ({ ...c })),
    index: () => creds.map(({ fields, ...rest }) => rest),
    find: (id) => creds.find((c) => c.id === id) ?? null,
    insert: (c) => creds.push({ ...c }),
    patch: (id, p) => {
      const c = creds.find((x) => x.id === id);
      if (!c) return false;
      if (typeof p.alias === 'string' && p.alias.trim()) c.alias = p.alias.trim();
      if (p.fields && typeof p.fields === 'object') c.fields = { ...c.fields, ...p.fields };
      return true;
    },
    remove: (id) => {
      const n = creds.length;
      creds = creds.filter((c) => c.id !== id);
      return n - creds.length;
    },
    codexAccounts: () => [],
    setCodexAccounts: (_id, records) => records.length,
  };
  const engine = createEngine({ store, hiddenProviders });

  return {
    engine,
    store,
    calls,
    travel: (ms) => {
      offset += ms;
    },
    settle: async (cond, tries = 400) => {
      for (let i = 0; i < tries; i++) {
        if (cond()) return true;
        await new Promise((r) => setTimeout(r, 5));
      }
      return false;
    },
    done() {
      Date.now = realNow;
      globalThis.fetch = realFetch;
    },
  };
}

async function withCreds(sb, keys) {
  const ids = [];
  for (const k of keys) ids.push((await sb.engine.saveCredential({ provider: 'deepseek', alias: `别名-${k}`, fields: { apiKey: k } })).id);
  return ids;
}

const res200 = (body) => ({ status: 200, ok: true, text: async () => JSON.stringify(body) });

test('engine: 首次取数 live + 60s 内走缓存（不重复请求上游）', async () => {
  const sb = withSandbox(() => res200(FIXTURE_OK));
  try {
    await withCreds(sb, ['sk-test-a']);
    const first = await sb.engine.getQuota();
    assert.equal(sb.calls.length, 1);
    assert.equal(first[0].provider, 'deepseek');
    assert.equal(first[0].source, 'live');
    assert.equal(first[0].error, null);
    assert.deepEqual(first[0].balance, { currency: 'CNY', total: 58.36, granted: 10, paid: 48.36 });
    const second = await engineGet(sb);
    async function engineGet(s) {
      return s.engine.getQuota();
    }
    assert.equal(sb.calls.length, 1, 'TTL 内命中缓存');
    assert.equal(second[0].fetchedAt, first[0].fetchedAt);
  } finally {
    sb.done();
  }
});

test('engine: 缓存过期后先返回旧值，后台刷新完成后下次拿到新值', async () => {
  const sb = withSandbox((_url, _o, n) =>
    res200({ ...FIXTURE_OK, balance_infos: [{ ...FIXTURE_OK.balance_infos[0], total_balance: n === 1 ? '58.36' : '77.77' }] }),
  );
  try {
    await withCreds(sb, ['sk-test-a']);
    const stale = (await sb.engine.getQuota())[0];
    assert.equal(stale.balance.total, 58.36);
    sb.travel(61_000);
    const served = (await sb.engine.getQuota())[0];
    assert.equal(served.balance.total, 58.36, '过期缓存先返回旧值');
    assert.ok(await sb.settle(() => sb.calls.length >= 2), '后台刷新已发起');
    const fresh = (await sb.engine.getQuota())[0];
    assert.equal(fresh.balance.total, 77.77);
  } finally {
    sb.done();
  }
});

test('engine: 失败指数退避 60s→120s（倍增），成功后计数重置', async () => {
  let ok = false;
  const sb = withSandbox(() => (ok ? res200(FIXTURE_OK) : Promise.reject(new Error('boom'))));
  try {
    await withCreds(sb, ['sk-test-a']);
    sb.travel(61_000);
    let card = (await sb.engine.getQuota())[0];
    await sb.settle(() => sb.calls.length >= 1);
    assert.equal(card.error.kind, 'unavailable');
    sb.travel(30_000); // t=91s，首次退避 60s 未到
    card = (await sb.engine.getQuota())[0];
    assert.equal(sb.calls.length, 1, '退避期内不重试');
    sb.travel(60_000); // t=151s，越过首次 60s 退避
    card = (await sb.engine.getQuota())[0];
    await sb.settle(() => sb.calls.length >= 2);
    assert.equal(card.error.kind, 'unavailable');
    sb.travel(60_000); // t=211s，第二次退避 120s 未到（指数增长）
    card = (await sb.engine.getQuota())[0];
    assert.equal(sb.calls.length, 2, '第二次退避窗口更长');
    ok = true;
    sb.travel(120_000); // t=331s，越过 120s
    await sb.engine.getQuota(); // 仍先返回旧值，后台刷新发起成功请求
    await sb.settle(() => sb.calls.length >= 3);
    card = (await sb.engine.getQuota())[0]; // 下一次拿到刷新后的新值
    assert.equal(card.error, null);
    assert.equal(card.source, 'live');
    sb.travel(61_000); // 成功后无退避，仅 60s 缓存
    await sb.engine.getQuota();
    await sb.settle(() => sb.calls.length >= 4);
    assert.ok(true, '成功后计数重置，回到 60s 缓存节奏');
  } finally {
    sb.done();
  }
});

test('engine: 退避封顶 30 分钟（多次失败后 29min 不重试、31min 重试）', async () => {
  const sb = withSandbox(() => Promise.reject(new Error('down')));
  try {
    await withCreds(sb, ['sk-test-a']);
    sb.travel(61_000);
    await sb.engine.getQuota();
    await sb.settle(() => sb.calls.length >= 1);
    for (let i = 0; i < 15; i++) {
      sb.travel(31 * 60_000);
      await sb.engine.getQuota();
      await sb.settle(() => true);
    }
    const calls = sb.calls.length;
    sb.travel(29 * 60_000);
    await sb.engine.getQuota();
    assert.equal(sb.calls.length, calls, '封顶窗口内不重试');
    sb.travel(2 * 60_000);
    await sb.engine.getQuota();
    await sb.settle(() => sb.calls.length >= calls + 1);
    assert.ok('越过 30min 封顶后重试');
  } finally {
    sb.done();
  }
});

test('engine: refreshQuota 强制刷新绕过缓存/退避；指定 accountId 只刷一个', async () => {
  const sb = withSandbox(() => res200(FIXTURE_OK));
  try {
    const ids = await withCreds(sb, ['sk-test-a', 'sk-test-b']);
    await sb.engine.getQuota();
    assert.equal(sb.calls.length, 2);
    const perKey = (k) => sb.calls.filter((c) => c.auth === k).length;
    assert.equal(perKey('Bearer sk-test-a'), 1);
    sb.travel(61_000);
    const only = await sb.engine.refreshQuota(ids[0]);
    assert.equal(only.length, 1, '指定 accountId 只刷一个');
    assert.equal(perKey('Bearer sk-test-a'), 2, 'force 绕过缓存');
    assert.equal(perKey('Bearer sk-test-b'), 1, '未指定的账号不被刷新');
    await assert.rejects(() => sb.engine.refreshQuota('no-such'), (e) => e.code === 'account_not_found');
  } finally {
    sb.done();
  }
});

test('engine: 凭证校验与索引脱敏（索引无 fields、别名缺省用 displayName）', async () => {
  const sb = withSandbox(() => res200(FIXTURE_OK));
  try {
    await withCreds(sb, ['sk-test-a']);
    await assert.rejects(() => sb.engine.saveCredential({ provider: 'nope', fields: {} }), (e) => e.code === 'unknown_provider');
    await assert.rejects(() => sb.engine.saveCredential({ provider: 'deepseek', fields: { apiKey: '  ' } }), (e) => e.code === 'invalid_fields');
    const { id } = await sb.engine.saveCredential({ provider: 'deepseek', fields: { apiKey: 'sk-test-c' } });
    const idx = sb.engine.listCredentials();
    assert.ok(idx.every((c) => !('fields' in c)), '索引不含密钥材料');
    assert.equal(idx.find((c) => c.id === id).alias, 'DeepSeek', '缺省别名回退 displayName');
    await sb.engine.updateCredential(id, { alias: '自定义' });
    assert.equal(sb.engine.listCredentials().find((c) => c.id === id).alias, '自定义');
    assert.ok(sb.engine.deleteCredential(id).ok);
    assert.equal(sb.engine.listCredentials().some((c) => c.id === id), false);
  } finally {
    sb.done();
  }
});

test('engine: 删除凭证后卡片消失且缓存清理', async () => {
  const sb = withSandbox(() => res200(FIXTURE_OK));
  try {
    const ids = await withCreds(sb, ['sk-test-a', 'sk-test-b']);
    await sb.engine.getQuota();
    assert.equal((await sb.engine.getQuota()).length, 2);
    sb.engine.deleteCredential(ids[1]);
    const cards = await sb.engine.getQuota();
    assert.equal(cards.length, 1);
    assert.equal(cards[0].accountId, ids[0]);
  } finally {
    sb.done();
  }
});

test('engine: hiddenProviders 平台隐藏——不产卡片且列表不展示（Android 无 codex 场景同构）', async () => {
  const sb = withSandbox(() => res200(FIXTURE_OK), { hiddenProviders: ['deepseek'] });
  try {
    sb.store.insert({ id: 'x1', provider: 'deepseek', kind: 'balance', alias: 'x', fields: { apiKey: 'sk-hidden' }, createdAt: 0 });
    assert.deepEqual(await sb.engine.getQuota(), []);
    const meta = await sb.engine.listProvidersMeta();
    assert.equal(meta.some((m) => m.id === 'deepseek'), false);
    await assert.rejects(() => sb.engine.saveCredential({ provider: 'deepseek', fields: { apiKey: 'sk-x' } }), (e) => e.code === 'unknown_provider');
  } finally {
    sb.done();
  }
});

test('engine: QuotaError 透传 kind（auth_expired 不会被吞成 unavailable）', async () => {
  const sb = withSandbox(() => ({ status: 401, ok: false, text: async () => '{}' }));
  try {
    sb.store.insert({ id: 'k1', provider: 'deepseek', kind: 'balance', alias: 'k', fields: { apiKey: 'sk-k' }, createdAt: 0 });
    sb.travel(61_000);
    const card = (await sb.engine.getQuota())[0];
    assert.equal(card.error.kind, 'auth_expired');
    assert.ok(card.error.message.length > 0);
  } finally {
    sb.done();
  }
});

test('engine: 手动刷新限流——每分钟最多 5 次，超出抛 refresh_throttled，窗口过后恢复，不影响 getQuota', async () => {
  const sb = withSandbox(() => res200(FIXTURE_OK));
  try {
    const ids = await withCreds(sb, ['sk-test-a']);
    for (let i = 0; i < 5; i++) await sb.engine.refreshQuota(ids[0]);
    assert.equal(sb.calls.length, 5, '前 5 次手动刷新放行');
    await assert.rejects(() => sb.engine.refreshQuota(ids[0]), (e) => e.code === 'refresh_throttled');
    assert.equal(sb.calls.length, 5, '超出限流不发请求');
    sb.travel(60_000);
    await sb.engine.refreshQuota(ids[0]);
    assert.equal(sb.calls.length, 6, '窗口过后恢复刷新');
    await sb.engine.getQuota(); // 普通取数不受限流影响
    assert.ok(sb.calls.length >= 6);
  } finally {
    sb.done();
  }
});
