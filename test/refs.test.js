// 参考资料注入测试：清单净化与 prompt 块构建
const test = require('node:test');
const assert = require('node:assert');
const { normalizeRefs, buildRefsBlock, REF_MAX_COUNT, REF_MAX_LEN } = require('../app/lib/refs');

test('normalizeRefs：去空/去重/截断/上限', () => {
  assert.deepStrictEqual(normalizeRefs([]), []);
  assert.deepStrictEqual(normalizeRefs(''), []);
  assert.deepStrictEqual(normalizeRefs(null), []);
  assert.deepStrictEqual(normalizeRefs('  /tmp/a.md  \n\n/tmp/b.md\n'), ['/tmp/a.md', '/tmp/b.md']); // trim+去空行
  assert.deepStrictEqual(normalizeRefs(['/x', '/x', '/y']), ['/x', '/y']); // 去重
  const long = 'a'.repeat(REF_MAX_LEN + 100);
  const r = normalizeRefs([long]);
  assert.strictEqual(r[0].length, REF_MAX_LEN + '…（已截断）'.length);
  assert.ok(r[0].endsWith('…（已截断）'));
  // 超上限：保留前 N 条 + 提示行
  const many = Array.from({ length: REF_MAX_COUNT + 5 }, (_, i) => `/f${i}`);
  const rm = normalizeRefs(many);
  assert.strictEqual(rm.length, REF_MAX_COUNT + 1);
  assert.ok(rm[REF_MAX_COUNT].includes('超过上限'));
});

test('buildRefsBlock：空清单为空串，非空含指引与编号', () => {
  assert.strictEqual(buildRefsBlock([]), '');
  assert.strictEqual(buildRefsBlock(undefined), '');
  const b = buildRefsBlock(['/tmp/report.md', 'https://example.com/doc']);
  assert.ok(b.includes('【参考资料（可直接读取）】'));
  assert.ok(b.includes('1. /tmp/report.md'));
  assert.ok(b.includes('2. https://example.com/doc'));
  assert.ok(b.includes('不要凭空编造'));
});
