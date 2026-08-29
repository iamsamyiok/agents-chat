// cards.js reorder 全量重编测试
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

process.env.AGENTS_CHAT_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cards-test-'));
const { CardStore } = require('../app/lib/cards');

function mk(id, order, priority) {
  return { id, title: id, content: id, mode: 'new', status: 'pending', order, priority, dependsOn: [], createdAt: Date.now(), updatedAt: Date.now() };
}

test('部分重排不再产生并列 order（全表唯一且连续）', () => {
  const list = [mk('a', 1, 1), mk('b', 2, 2), mk('c', 3, 3), mk('d', 4, 4)];
  fs.writeFileSync(path.join(process.env.AGENTS_CHAT_DATA, 'cards.json'), JSON.stringify(list), 'utf8');

  // 只传子集：c 提到最前
  CardStore.reorder(['c', 'a']);

  const after = CardStore.list();
  assert.strictEqual(after.length, 4);
  const orders = after.map(x => x.order).sort((x, y) => x - y);
  assert.deepStrictEqual(orders, [1, 2, 3, 4]);            // 唯一且连续
  const prios = after.map(x => x.priority).sort((x, y) => x - y);
  assert.deepStrictEqual(prios, [1, 2, 3, 4]);             // priority 同样唯一
  const c = after.find(x => x.id === 'c');
  const d = after.find(x => x.id === 'd');
  assert.strictEqual(c.order, 1);                          // 传入的 c 排最前
  assert.strictEqual(d.order, 4);                          // 未涉及的 d 排最后
});

test('全量重排保持传入顺序', () => {
  CardStore.reorder(['d', 'b', 'a', 'c']);
  const after = CardStore.list();
  assert.deepStrictEqual(after.map(x => x.id).sort((a, b) =>
    after.find(y => y.id === a).order - after.find(y => y.id === b).order), ['d', 'b', 'a', 'c']);
});

test('忽略不存在的 id', () => {
  CardStore.reorder(['ghost', 'a', 'b', 'c', 'd']);
  const orders = CardStore.list().map(x => x.order).sort((x, y) => x - y);
  assert.deepStrictEqual(orders, [1, 2, 3, 4]);
});
