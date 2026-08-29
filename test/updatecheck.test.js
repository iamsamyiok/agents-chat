// updatecheck：版本比较与更新检查模块测试
const test = require('node:test');
const assert = require('node:assert');
const { semverGt, checkLatest, UPDATE_COMMAND, currentVersion } = require('../app/lib/updatecheck');
const PKG = require('../package.json');

test('semverGt：基本比较', () => {
  assert.strictEqual(semverGt('3.26.0', '3.25.0'), true);
  assert.strictEqual(semverGt('3.25.0', '3.26.0'), false);
  assert.strictEqual(semverGt('3.25.0', '3.25.0'), false); // 相等不算更新
  assert.strictEqual(semverGt('4.0.0', '3.99.99'), true);
  assert.strictEqual(semverGt('3.10.0', '3.9.0'), true);  // 数字段比较非字符串
});

test('semverGt：容错输入', () => {
  assert.strictEqual(semverGt('3.26.0-beta.1', '3.25.0'), true); // prerelease 忽略后缀
  assert.strictEqual(semverGt('', '3.25.0'), false);
  assert.strictEqual(semverGt('3.26', '3.25.9'), true);          // 缺段按 0 补
  assert.strictEqual(semverGt(null, '1.0.0'), false);
});

test('模块导出一致性', () => {
  assert.strictEqual(currentVersion, PKG.version);
  assert.ok(UPDATE_COMMAND.includes(PKG.name));
  assert.ok(UPDATE_COMMAND.includes('@latest'));
});

test('checkLatest：正常返回或静默 null（不抛错）', async () => {
  const r = await checkLatest();
  assert.ok(r === null || (typeof r.latest === 'string' && typeof r.updateAvailable === 'boolean'));
  if (r) assert.strictEqual(r.updateAvailable, semverGt(r.latest, PKG.version));
});
