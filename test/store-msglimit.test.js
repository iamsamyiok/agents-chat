// store.js 会话消息上限滚动清理 + 分片计数测试
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

// 用小上限验证裁剪逻辑（环境变量须在 require 前设置）
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'store-limit-test-'));
process.env.AGENTS_CHAT_DATA = DATA;
process.env.AGENTS_CHAT_MSG_LIMIT = '5';
const store = require('../app/lib/store');

test('任务会话超过上限：滚动裁剪 + 开头系统标记', () => {
  for (let i = 1; i <= 7; i++) {
    store.addMessage({ role: 'assistant', content: 'msg-' + i, taskId: 't1' });
  }
  const list = store.getMessages('t1');
  assert.strictEqual(list.length, 6); // 5 条上限 + 1 条系统标记
  assert.strictEqual(list[0].role, 'sys');
  assert.ok(/自动滚动清理/.test(list[0].content));
  assert.strictEqual(list[1].content, 'msg-3');  // 最旧两条被裁
  assert.strictEqual(list[list.length - 1].content, 'msg-7');
});

test('继续追加：标记不重复插入', () => {
  store.addMessage({ role: 'assistant', content: 'msg-8', taskId: 't1' });
  const list = store.getMessages('t1');
  assert.strictEqual(list.length, 6);
  assert.strictEqual(list.filter(m => m.role === 'sys').length, 1);
});

test('主会话豁免上限', () => {
  for (let i = 1; i <= 8; i++) {
    store.addMessage({ role: 'user', content: 'main-' + i, taskId: '' });
  }
  assert.strictEqual(store.getMessages('').length, 8);
});

test('countMessagesByTask：逐分片计数正确', () => {
  store.addMessage({ role: 'user', content: 'x', taskId: 't2' });
  const stat = store.countMessagesByTask();
  assert.strictEqual(stat.counts.t1, 6);
  assert.strictEqual(stat.counts.t2, 1);
  assert.strictEqual(stat.main, 8);
  const total = stat.main + Object.values(stat.counts).reduce((a, b) => a + b, 0);
  const all = store.getMessages(); // 全量合并数与计数一致
  assert.strictEqual(total, all.length);
});
