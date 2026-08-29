// CardRunner.getProcesses 进程识别准确性测试
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

process.env.AGENTS_CHAT_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cards-proc-test-'));
const { CardRunner } = require('../app/lib/cards');

const r = new CardRunner();

test('占位条目（spawn 前）：child=null 保留展示，pid 为 null，working=true', () => {
  r.procs.set('c1', { pid: null, child: null, lastActive: Date.now() });
  const out = r.getProcesses();
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].cardId, 'c1');
  assert.strictEqual(out[0].pid, null);
  assert.strictEqual(out[0].working, true);
});

test('活跃窗口：15s 内有活动 = 工作中，超窗 = 等待输出', () => {
  r.procs.set('c2', { pid: 123, child: null, lastActive: Date.now() - 3000 });   // 3s 前：工作中
  r.procs.set('c3', { pid: 456, child: null, lastActive: Date.now() - 60000 });  // 60s 前：等待输出
  const out = r.getProcesses();
  assert.strictEqual(out.find(p => p.cardId === 'c2').working, true);
  assert.strictEqual(out.find(p => p.cardId === 'c3').working, false);
});

test('死进程过滤：已退出（exitCode 非 null）或已 kill 的子进程不展示', () => {
  r.procs.set('c4', { pid: 111, child: { exitCode: 0, killed: false }, lastActive: Date.now() });   // 正常退出
  r.procs.set('c5', { pid: 222, child: { exitCode: null, killed: true }, lastActive: Date.now() }); // 被 kill
  r.procs.set('c6', { pid: 333, child: { exitCode: null, killed: false }, lastActive: Date.now() }); // 存活
  const ids = r.getProcesses().map(p => p.cardId);
  assert.ok(!ids.includes('c4'), '已退出进程不应展示');
  assert.ok(!ids.includes('c5'), '被 kill 进程不应展示');
  assert.ok(ids.includes('c6'), '存活进程应展示');
});

test('登记表清空后输出为空', () => {
  r.procs.clear();
  assert.deepStrictEqual(r.getProcesses(), []);
});
