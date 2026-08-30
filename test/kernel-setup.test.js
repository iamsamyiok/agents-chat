// kernel-setup：自动安装决策纯函数测试
const test = require('node:test');
const assert = require('node:assert');
const { shouldAutoInstall } = require('../app/lib/kernel-setup');

const map = (ok) => ({ opencode: { ok }, claude: { ok: false }, codex: { ok: false }, pi: { ok: false } });

test('全无内核才需要自动安装', () => {
  assert.deepStrictEqual(shouldAutoInstall(map(false)), { need: true, reason: 'none' });
  assert.strictEqual(shouldAutoInstall(map(true)).need, false);           // opencode 在
});

test('任一内核存在则跳过（含非 opencode）', () => {
  const m = { opencode: { ok: false }, claude: { ok: true }, codex: { ok: false }, pi: { ok: false } };
  assert.deepStrictEqual(shouldAutoInstall(m), { need: false, reason: 'has-kernel' });
});

test('exe 形态与用户关闭均跳过', () => {
  assert.deepStrictEqual(shouldAutoInstall(map(false), { standalone: true }), { need: false, reason: 'standalone' });
  assert.deepStrictEqual(shouldAutoInstall(map(false), { disabled: true }), { need: false, reason: 'disabled' });
});

test('异常输入容错', () => {
  assert.strictEqual(shouldAutoInstall(null).need, false);
  assert.strictEqual(shouldAutoInstall(undefined).need, false);
  assert.strictEqual(shouldAutoInstall({}).need, false); // 空对象无 ok 字段 → anyOk=false 反而该装？规范：空 map 视为坏输入跳过
});
