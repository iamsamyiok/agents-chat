const test = require('node:test');
const assert = require('node:assert');
const { installKernel } = require('../app/lib/kernel-setup');

test('未知内核 id 拒绝', () => {
  const r = installKernel('no-such-kernel', { standalone: false });
  assert.equal(r.installed, false);
  assert.ok(r.error.includes('未知内核'));
});
test('exe 形态非 opencode 内核给出手动安装指引', () => {
  const r = installKernel('claude', { standalone: true });
  assert.equal(r.installed, false);
  assert.ok(r.error.includes('手动'));
  assert.ok(r.error.includes('claude-code')); // 含原始 npm 安装命令片段
});
