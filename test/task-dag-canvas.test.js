// 可视化依赖编排画布：importTasksCanvas / updateTaskDeps / findDepCycle
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'task-dag-canvas-'));
process.env.AGENTS_CHAT_DATA = DATA;
const store = require('../app/lib/store');

// ---------- findDepCycle ----------

test('findDepCycle：无环返回 null，有环返回环路 id 路径', () => {
  const t = (id, deps) => ({ id, dependsOn: deps });
  assert.strictEqual(store.findDepCycle([t('a', []), t('b', ['a']), t('c', ['a'])]), null);
  const cycle = store.findDepCycle([t('a', ['c']), t('b', ['a']), t('c', ['b'])]);
  assert.ok(Array.isArray(cycle) && cycle.length === 3, '三节点环应返回长度 3 的路径');
});

test('findDepCycle：环外存在无依赖任务时仍能检出环（回归：visited 虚高漏报）', () => {
  const t = (id, deps) => ({ id, dependsOn: deps });
  // 5 个独立任务 + 3 节点环：旧实现 visited(5) >= indeg.size(3) 误判无环
  const g = [t('x1', []), t('x2', ['x1']), t('x3', []), t('x4', []), t('x5', []), t('a', ['c']), t('b', ['a']), t('c', ['b'])];
  const cycle = store.findDepCycle(g);
  assert.ok(Array.isArray(cycle), '应检出环');
  assert.deepStrictEqual([...cycle].sort(), ['a', 'b', 'c']);
});

// ---------- importTasksCanvas ----------

test('画布导入：deps 画布序号映射 dependsOn/depNos，任务入库', () => {
  const r = store.importTasksCanvas(
    [{ title: '调研' }, { title: '收集' }, { title: '写初稿', deps: [1, 2] }],
    'sequential', 'solo', '', []
  );
  assert.strictEqual(r.errors.length, 0);
  assert.strictEqual(r.added, 3);
  const [a, b, c] = r.addedTasks;
  assert.strictEqual(a.runner, 'solo');
  assert.deepStrictEqual(c.depNos, [1, 2]);
  assert.deepStrictEqual(c.dependsOn, [a.id, b.id]);
  assert.strictEqual(c.link, 'new');
  assert.strictEqual(store.getTasks().length, 3);
});

test('画布导入：空画布/空标题报错不入库', () => {
  const empty = store.importTasksCanvas([], 'sequential', '', '', []);
  assert.strictEqual(empty.added, 0);
  assert.ok(empty.errors[0].message.includes('画布为空'));
  const before = store.getTasks().length;
  const bad = store.importTasksCanvas([{ title: '  ' }, { title: 'B' }], 'sequential', '', '', []);
  assert.strictEqual(bad.added, 0);
  assert.ok(bad.errors.some(e => e.message.includes('标题为空')));
  assert.strictEqual(store.getTasks().length, before);
});

test('画布导入：越界/自引用序号剔除，重复依赖去重', () => {
  const r = store.importTasksCanvas(
    [{ title: 'A' }, { title: 'B', deps: [1, 1, 2, 9, 0] }],
    'sequential', '', '', []
  );
  assert.strictEqual(r.errors.length, 0);
  const [, b] = r.addedTasks;
  assert.deepStrictEqual(b.depNos, [1]);
  assert.deepStrictEqual(b.dependsOn, [r.addedTasks[0].id]);
});

test('画布导入：环拒绝整批不入库，错误带节点定位', () => {
  const before = store.getTasks().length;
  const r = store.importTasksCanvas(
    [{ title: 'A', deps: [3] }, { title: 'B', deps: [1] }, { title: 'C', deps: [2] }],
    'sequential', '', '', []
  );
  assert.strictEqual(r.added, 0);
  assert.strictEqual(r.errors.length, 1);
  assert.ok(r.errors[0].message.includes('环路'));
  assert.strictEqual(typeof r.errors[0].node, 'number');
  assert.strictEqual(store.getTasks().length, before);
});

test('画布导入：model 与 refs 落到每个任务', () => {
  const r = store.importTasksCanvas([{ title: 'A' }], 'sequential', 'solo', 'kimi-k2', ['/tmp/x.md']);
  const t = r.addedTasks[0];
  assert.strictEqual(t.model, 'kimi-k2');
  assert.deepStrictEqual(t.refs, ['/tmp/x.md']);
});

// ---------- updateTaskDeps ----------

test('依赖编辑：改 deps 重算 depNos，清空删除字段', () => {
  const r1 = store.importTasksCanvas([{ title: 'A' }, { title: 'B' }, { title: 'C', deps: [1] }], 'sequential', '', '', []);
  const [a, b, c] = r1.addedTasks;
  // 假设库中已有其他任务，按返回的 id 操作；seq 由 store 分配，depNos 取 seq+1
  const all1 = store.getTasks();
  const seqOf = id => all1.find(t => t.id === id).seq + 1;

  let r = store.updateTaskDeps([{ id: c.id, deps: [a.id, b.id] }]);
  assert.strictEqual(r.updated, 1);
  let cc = store.getTasks().find(t => t.id === c.id);
  assert.deepStrictEqual(cc.dependsOn, [a.id, b.id]);
  assert.deepStrictEqual(cc.depNos, [seqOf(a.id), seqOf(b.id)]);

  r = store.updateTaskDeps([{ id: c.id, deps: [] }]);
  assert.strictEqual(r.updated, 1);
  cc = store.getTasks().find(t => t.id === c.id);
  assert.strictEqual(cc.dependsOn, undefined);
  assert.strictEqual(cc.depNos, undefined);
});

test('依赖编辑：形成环整体拒绝不入库', () => {
  const r1 = store.importTasksCanvas([{ title: 'A' }, { title: 'B', deps: [1] }], 'sequential', '', '', []);
  const [a, b] = r1.addedTasks;
  const r = store.updateTaskDeps([{ id: a.id, deps: [b.id] }]); // A 依赖 B，而 B 已依赖 A → 环
  assert.strictEqual(r.updated, 0);
  assert.strictEqual(r.errors.length, 1);
  assert.ok(r.errors[0].message.includes('环路'));
  assert.strictEqual(store.getTasks().find(t => t.id === a.id).dependsOn, undefined);
});

test('依赖编辑：done/running 拒改；不存在 id 与自依赖报错', () => {
  const r1 = store.importTasksCanvas([{ title: 'A' }, { title: 'B' }, { title: 'C' }], 'sequential', '', '', []);
  const [a, b, c] = r1.addedTasks;
  store.updateTask(a.id, { status: 'done' });
  const r = store.updateTaskDeps([
    { id: a.id, deps: [b.id] },   // done 拒改
    { id: 't-nope', deps: [] },   // 不存在
    { id: b.id, deps: [b.id] },   // 自依赖
    { id: c.id, deps: [b.id] }    // 合法（但整体因前面报错不入库）
  ]);
  assert.strictEqual(r.updated, 0);
  assert.strictEqual(r.errors.length, 3);
  assert.strictEqual(store.getTasks().find(t => t.id === c.id).dependsOn, undefined);
});
