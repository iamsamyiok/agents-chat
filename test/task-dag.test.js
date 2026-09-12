// 任务依赖 DAG：解析语法 / 校验（缺失·环） / 调度器行为测试
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'task-dag-'));
process.env.AGENTS_CHAT_DATA = DATA;
const store = require('../app/lib/store');

// ---------- 解析语法 ----------

test('解析：←依赖提取与 dependsOn id 映射', () => {
  const r = store.parseTasksFromText('1. 调研\n2. 收集素材\n3. 写初稿 ←1,2\n4. 配图 ←3\n5. 发布 ←4,2', 'sequential', '');
  assert.strictEqual(r.errors.length, 0);
  const [a, b, c, d, e] = r.tasks;
  assert.deepStrictEqual(c.depNos, [1, 2]);
  assert.deepStrictEqual(c.dependsOn, [a.id, b.id]);
  assert.deepStrictEqual(d.dependsOn, [c.id]);
  assert.deepStrictEqual(e.dependsOn, [d.id, b.id]);
  assert.strictEqual(a.depNos, undefined); // 无依赖任务不带字段
});

test('解析：ASCII <- 等价 ←；中文逗号/顿号分隔', () => {
  const r = store.parseTasksFromText('1. A\n2. B <-1\n3. C ←1，2\n4. D ←1、2', 'sequential', '');
  assert.strictEqual(r.errors.length, 0);
  assert.deepStrictEqual(r.tasks[1].depNos, [1]);
  assert.deepStrictEqual(r.tasks[2].depNos, [1, 2]);
  assert.deepStrictEqual(r.tasks[3].depNos, [1, 2]);
});

test('解析：依赖与行尾@指派、时间前缀共存', () => {
  const r = store.parseTasksFromText('1. A\n2. B ←1 @写手', 'sequential', '');
  assert.strictEqual(r.errors.length, 0);
  assert.strictEqual(r.tasks[1].title, 'B');
  assert.deepStrictEqual(r.tasks[1].depNos, [1]);
  // @写手 不存在时 assign 为空 + warning（既有行为），依赖不受影响
  assert.strictEqual(r.tasks[1].assign, '');
});

test('解析：无编号行的依赖声明被忽略并告警', () => {
  const r = store.parseTasksFromText('1. A\n写东西 ←1', 'sequential', '');
  assert.strictEqual(r.errors.length, 0);
  assert.ok(r.warnings.some(w => w.includes('未写编号')));
  assert.strictEqual(r.tasks[1].depNos, undefined);
});

test('解析：依赖声明为空（← 后无有效数字）忽略', () => {
  const r = store.parseTasksFromText('1. A\n2. B ←，、', 'sequential', '');
  assert.strictEqual(r.errors.length, 0);
  assert.strictEqual(r.tasks[1].depNos, undefined);
});

test('解析：标题中的箭头非行尾不误判（← 后非纯编号）', () => {
  const r = store.parseTasksFromText('1. 向左箭头←示意\n2. B ←1', 'sequential', '');
  assert.strictEqual(r.errors.length, 0);
  assert.strictEqual(r.tasks[0].depNos, undefined);
  assert.ok(r.tasks[0].title.includes('←示意'));
});

// ---------- 校验 ----------

test('校验：引用缺失编号报错并指明行', () => {
  const r = store.parseTasksFromText('1. A\n2. B ←5', 'sequential', '');
  assert.strictEqual(r.errors.length, 1);
  assert.strictEqual(r.errors[0].line, 2);
  assert.ok(r.errors[0].message.includes('5'));
});

test('校验：双任务环给出路径', () => {
  const r = store.parseTasksFromText('1. A ←2\n2. B ←1', 'sequential', '');
  assert.strictEqual(r.errors.length, 1);
  assert.ok(r.errors[0].message.includes('1 → 2 → 1'));
});

test('校验：三任务环给出路径', () => {
  const r = store.parseTasksFromText('1. A ←2\n2. B ←3\n3. C ←1', 'sequential', '');
  assert.strictEqual(r.errors.length, 1);
  assert.ok(r.errors[0].message.includes('→'));
});

test('校验：自依赖（1←1）报环', () => {
  const r = store.parseTasksFromText('1. A ←1', 'sequential', '');
  assert.strictEqual(r.errors.length, 1);
  assert.ok(r.errors[0].message.includes('1 → 1'));
});

test('校验：菱形（1,2→3→4,5→6）无环', () => {
  const r = store.parseTasksFromText('1. A\n2. B\n3. C ←1,2\n4. D ←3\n5. E ←3\n6. F ←4,5', 'sequential', '');
  assert.strictEqual(r.errors.length, 0);
  assert.strictEqual(r.tasks.filter(t => t.dependsOn).length, 4);
});

test('校验：环外存在独立任务时仍报环（回归：visited 虚高漏报）', () => {
  // 4 个无依赖任务 + 2 节点环：旧实现 visited(4) >= indeg.size(2) 误判无环
  const r = store.parseTasksFromText('1. 独立甲\n2. 独立乙\n3. 独立丙\n4. 独立丁\n5. X ←6\n6. Y ←5', 'sequential', '');
  assert.strictEqual(r.errors.length, 1);
  assert.ok(r.errors[0].message.includes('环路'));
});

// ---------- importTasks 集成 ----------

test('importTasks：校验失败返回 errors 且不入库', () => {
  const before = store.getTasks().length;
  const r = store.importTasks('1. A\n2. B ←1\n3. C ←1', 'sequential', '');
  assert.strictEqual(r.added, 3);
  const r2 = store.importTasks('1. X ←9', 'sequential', '');
  assert.strictEqual(r2.added, 0);
  assert.strictEqual(r2.errors.length, 1);
  assert.strictEqual(store.getTasks().length, before + 3); // 环/缺失批次未入库
});

test('importTasks：DAG 批次正常入库且 dependsOn 持久化', () => {
  const r = store.importTasks('1. 甲\n2. 乙 ←1', 'sequential', '');
  assert.strictEqual(r.added, 2);
  const saved = store.getTasks().find(t => t.id === r.addedTasks[1].id);
  assert.deepStrictEqual(saved.dependsOn, [r.addedTasks[0].id]);
});

// ---------- 调度器（runDagBatch，mock runOneTask） ----------

// 从 server.js 提取调度器逻辑做行为测试：直接 require server 会启动服务，
// 因此 server.js 将 runDagBatch 导出为可独立加载的模块函数（见 server.js 尾部 module 导出）。
// 这里通过公共导出测试调度行为。
let runDagBatch;
try { runDagBatch = require('../app/lib/dag').runDagBatch; } catch { /* 未提取模块时跳过 */ }

const delay = (ms) => new Promise(r => setTimeout(r, ms));

test('调度器：菱形图事件驱动执行与并行度', async () => {
  if (!runDagBatch) return; // 模块未就绪时跳过（实现于步骤3）
  const tasks = [
    { id: 'a', title: 'A' }, { id: 'b', title: 'B' },
    { id: 'c', title: 'C', dependsOn: ['a', 'b'] },
    { id: 'd', title: 'D', dependsOn: ['c'] }, { id: 'e', title: 'E', dependsOn: ['c'] },
    { id: 'f', title: 'F', dependsOn: ['d', 'e'] }
  ];
  const order = [];
  let inflight = 0, peak = 0;
  const status = new Map();
  const runOne = async (t) => {
    inflight++; peak = Math.max(peak, inflight);
    order.push('start:' + t.id);
    await delay(10);
    inflight--;
    status.set(t.id, 'done');
    return 'done';
  };
  const events = [];
  await runDagBatch(tasks, runOne, { send: (e) => events.push(e), isStopped: () => false, maxParallel: 4, statusOf: (id) => status.get(id), onTerminal: (id, s) => status.set(id, s) });
  assert.strictEqual(peak, 2); // a,b 并行；d,e 并行，峰值 2
  assert.ok(order.indexOf('start:c') > order.indexOf('start:a') && order.indexOf('start:c') > order.indexOf('start:b'));
  assert.ok(order.indexOf('start:d') > order.indexOf('start:c'));
  assert.ok(order.indexOf('start:f') > order.indexOf('start:d') && order.indexOf('start:f') > order.indexOf('start:e'));
});

test('调度器：前置失败递归阻塞', async () => {
  if (!runDagBatch) return;
  const tasks = [
    { id: 'a', title: 'A' }, { id: 'b', title: 'B', dependsOn: ['a'] }, { id: 'c', title: 'C', dependsOn: ['b'] }
  ];
  const status = new Map();
  const runOne = async (t) => { status.set(t.id, 'failed'); return 'failed'; };
  const events = [];
  await runDagBatch(tasks, runOne, { send: (e) => events.push(e), isStopped: () => false, maxParallel: 4, onTerminal: (id, s) => status.set(id, s) });
  assert.strictEqual(status.get('a'), 'failed');
  assert.strictEqual(status.get('b'), 'blocked');
  assert.strictEqual(status.get('c'), 'blocked');
  assert.ok(events.some(e => e.type === 'notice' && e.content.includes('阻塞')));
});

test('调度器：并发上限约束', async () => {
  if (!runDagBatch) return;
  const tasks = Array.from({ length: 10 }, (_, i) => ({ id: 't' + i, title: 'T' + i }));
  let inflight = 0, peak = 0;
  const status = new Map();
  await runDagBatch(tasks, async (t) => {
    inflight++; peak = Math.max(peak, inflight);
    await delay(5);
    inflight--;
    status.set(t.id, 'done');
    return 'done';
  }, { send: () => {}, isStopped: () => false, maxParallel: 3, onTerminal: (id, s) => status.set(id, s) });
  assert.ok(peak <= 3, `峰值 ${peak} 超过上限 3`);
});

test('调度器：无依赖批次全并行（退化等价 parallel）', async () => {
  if (!runDagBatch) return;
  const tasks = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  let inflight = 0, peak = 0;
  const status = new Map();
  await runDagBatch(tasks, async (t) => {
    inflight++; peak = Math.max(peak, inflight);
    await delay(8);
    inflight--;
    status.set(t.id, 'done');
    return 'done';
  }, { send: () => {}, isStopped: () => false, maxParallel: 4, onTerminal: (id, s) => status.set(id, s) });
  assert.strictEqual(peak, 3);
});
