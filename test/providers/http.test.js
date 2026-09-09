// http.js 共享辅助单测：httpStatusToError / parseJson（各 provider 的解析都复用它们）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuotaError, httpStatusToError, parseJson } from '../../src/standalone/providers/http.js';

const throwsKind = (fn, kind) => {
  assert.throws(fn, (e) => e instanceof QuotaError && e.kind === kind);
};

test('httpStatusToError：401/403 → auth_expired', () => {
  throwsKind(() => httpStatusToError(401, 'x'), 'auth_expired');
  throwsKind(() => httpStatusToError(403, 'x'), 'auth_expired');
});

test('httpStatusToError：429 → rate_limited', () => {
  throwsKind(() => httpStatusToError(429, 'x'), 'rate_limited');
});

test('httpStatusToError：其它非 200 → unavailable（不区分 502/500/302 等）', () => {
  for (const s of [200, 404, 500, 502, 302]) {
    if (s === 200) {
      assert.doesNotThrow(() => httpStatusToError(s, 'x'));
    } else {
      throwsKind(() => httpStatusToError(s, 'x'), 'unavailable');
    }
  }
});

test('parseJson：200 + 合法 JSON → 返回解析结果', () => {
  assert.deepEqual(parseJson(200, '{"a":1}', 'lbl'), { a: 1 });
});

test('parseJson：200 + 非 JSON → upstream_changed', () => {
  throwsKind(() => parseJson(200, 'oops', 'lbl'), 'upstream_changed');
  throwsKind(() => parseJson(200, '', 'lbl'), 'upstream_changed');
  throwsKind(() => parseJson(200, '{bad json', 'lbl'), 'upstream_changed');
});

test('parseJson：非 200 先抛对应错误（不进入 JSON 解析）', () => {
  throwsKind(() => parseJson(401, 'oops', 'lbl'), 'auth_expired');
  throwsKind(() => parseJson(429, 'oops', 'lbl'), 'rate_limited');
  throwsKind(() => parseJson(404, 'oops', 'lbl'), 'unavailable');
});

test('parseJson：错误消息可定制（jsonMessage 覆盖默认）', () => {
  assert.throws(() => parseJson(200, 'bad', 'lbl', 'custom: not json'), (e) => e.message === 'custom: not json');
  assert.throws(() => parseJson(200, 'bad', 'lbl'), (e) => e.message === 'lbl: body is not json');
});
