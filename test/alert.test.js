// 阈值提醒判定 evaluateAlerts 单测（纯函数，无 DOM/网络）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateAlerts } from '../src/web/src/util.js';

const acct = (id, windows, alias = `A-${id}`, error = null) => ({ accountId: id, alias, windows, error });

test('阈值: 用量达到阈值且未提醒 → fire 一次', () => {
  const { fire } = evaluateAlerts([acct('x', [{ name: '5小时', usedPercent: 90, resetAt: 1000 }])], 90, new Set());
  assert.equal(fire.length, 1);
  assert.equal(fire[0].key, 'x|5小时|1000');
  assert.equal(fire[0].used, 90);
});

test('阈值: 已提醒过不重复 fire', () => {
  const { fire } = evaluateAlerts([acct('x', [{ name: '5小时', usedPercent: 95, resetAt: 1000 }])], 90, new Set(['x|5小时|1000']));
  assert.equal(fire.length, 0);
});

test('阈值: 新重置周期（resetAt 变化）→ 重新提醒', () => {
  const { fire } = evaluateAlerts([acct('x', [{ name: '5小时', usedPercent: 91, resetAt: 2000 }])], 90, new Set(['x|5小时|1000']));
  assert.equal(fire.length, 1);
  assert.equal(fire[0].key, 'x|5小时|2000');
});

test('阈值: 滞后区间——跌破阈值但未低于阈值-5 → 不 fire 也不 rearm', () => {
  const { fire, rearm } = evaluateAlerts([acct('x', [{ name: '周', usedPercent: 87, resetAt: 1000 }])], 90, new Set(['x|周|1000']));
  assert.equal(fire.length, 0);
  assert.equal(rearm.length, 0);
});

test('阈值: 用量回落到阈值-5 以下 → rearm 重新武装', () => {
  const { fire, rearm } = evaluateAlerts([acct('x', [{ name: '周', usedPercent: 84, resetAt: 1000 }])], 90, new Set(['x|周|1000']));
  assert.equal(fire.length, 0);
  assert.deepEqual(rearm, ['x|周|1000']);
});

test('阈值: 多账号多窗口混合 + 错误卡与空百分比跳过', () => {
  const accounts = [
    acct('a', [{ name: '5小时', usedPercent: 92, resetAt: 1 }, { name: '周', usedPercent: 50, resetAt: 1 }]),
    acct('b', [{ name: '5小时', usedPercent: null, resetAt: 1 }]),
    acct('c', [], 'C', { kind: 'unavailable', message: 'x' }),
    acct('d', [{ name: '月', usedPercent: 99.4, resetAt: 1 }]),
  ];
  const { fire } = evaluateAlerts(accounts, 90, new Set());
  assert.deepEqual(fire.map((f) => f.key), ['a|5小时|1', 'd|月|1']);
});

test('阈值: 无 resetAt 的窗口 key 用 none 兜底且不会被误清理', () => {
  const alerted = new Set(['x|MCP(月)|none']);
  const { fire, stale } = evaluateAlerts([acct('x', [{ name: 'MCP(月)', usedPercent: 96 }])], 90, alerted);
  assert.equal(fire.length, 0);
  assert.equal(stale.length, 0);
});

test('阈值: 24h 前过期的旧周期 key 进 stale 清理列表', () => {
  const oldReset = Date.now() - 48 * 3600 * 1000;
  const alerted = new Set([`x|5小时|${oldReset}`]);
  const { stale } = evaluateAlerts([acct('x', [{ name: '5小时', usedPercent: 10, resetAt: 123 }])], 90, alerted);
  assert.deepEqual(stale, [`x|5小时|${oldReset}`]);
});

test('阈值: 空/畸形输入不抛错', () => {
  assert.deepEqual(evaluateAlerts([], 90, new Set()).fire, []);
  assert.deepEqual(evaluateAlerts(null, 90, new Set()).fire, []);
  assert.deepEqual(evaluateAlerts([acct('x', [{}])], 90, new Set()).fire, []);
});
