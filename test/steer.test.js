// 插话（Steering）队列单测
const test = require('node:test');
const assert = require('node:assert');
const { SteerQueue } = require('../app/lib/steer');

test('push/drain 基本流转：按序拼接后清空', () => {
  const q = new SteerQueue();
  assert.strictEqual(q.drain(), '');
  assert.ok(q.push('第一条'));
  assert.ok(q.push('第二条'));
  assert.strictEqual(q.size, 2);
  assert.strictEqual(q.drain(), '第一条\n\n第二条');
  assert.strictEqual(q.size, 0);
  assert.strictEqual(q.drain(), '');
});

test('上限保护：默认 10 条，超出拒绝', () => {
  const q = new SteerQueue();
  for (let i = 0; i < 10; i++) assert.ok(q.push(`m${i}`));
  assert.strictEqual(q.push('第11条'), false);
  assert.strictEqual(q.size, 10);
  const q2 = new SteerQueue({ max: 2 });
  assert.ok(q2.push('a'));
  assert.ok(q2.push('b'));
  assert.strictEqual(q2.push('c'), false);
});

test('clear 清空', () => {
  const q = new SteerQueue();
  q.push('x');
  q.clear();
  assert.strictEqual(q.size, 0);
  assert.strictEqual(q.drain(), '');
});

test('自定义拼接符', () => {
  const q = new SteerQueue();
  q.push('a');
  q.push('b');
  assert.strictEqual(q.drain('\n'), 'a\nb');
});
