// store.js 消息分片 + 迁移 + 损坏保护测试
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'store-test-'));
process.env.AGENTS_CHAT_DATA = DATA;
const store = require('../app/lib/store');

const MSG_DIR = path.join(DATA, 'messages');

test('旧版 messages.json 一次性迁移到分片', () => {
  // 手写旧版单文件（主会话 + 两个任务会话）
  const legacy = [
    { role: 'user', content: 'hi', taskId: '', timestamp: '2026-01-01T00:00:01.000Z' },
    { role: 'assistant', content: 'a1', taskId: 't1', timestamp: '2026-01-01T00:00:02.000Z' },
    { role: 'assistant', content: 'a2', taskId: 't1', timestamp: '2026-01-01T00:00:03.000Z' },
    { role: 'user', content: 'b1', taskId: 't2', timestamp: '2026-01-01T00:00:04.000Z' }
  ];
  fs.writeFileSync(path.join(DATA, 'messages.json'), JSON.stringify(legacy), 'utf8');

  // 首次访问触发迁移
  const t1 = store.getMessages('t1');
  assert.strictEqual(t1.length, 2);
  assert.strictEqual(t1[0].content, 'a1');
  assert.strictEqual(store.getMessages('t2').length, 1);
  assert.strictEqual(store.getMessages('').length, 1);

  // 旧文件改名保留，分片落盘
  assert.strictEqual(fs.existsSync(path.join(DATA, 'messages.json.migrated')), true);
  assert.strictEqual(fs.existsSync(path.join(MSG_DIR, 't1.json')), true);
  assert.strictEqual(fs.existsSync(path.join(MSG_DIR, '_main.json')), true);

  // 全量视图：合并所有分片且按时间排序
  const all = store.getMessages();
  assert.strictEqual(all.length, 4);
  assert.strictEqual(all[0].content, 'hi');
  assert.strictEqual(all[3].content, 'b1');
});

test('addMessage 写入各自分片，互不串扰', () => {
  store.addMessage({ role: 'user', content: 't1-new', taskId: 't1' });
  store.addMessage({ role: 'user', content: 'main-new', taskId: '' });
  assert.strictEqual(store.getMessages('t1').length, 3);
  assert.strictEqual(store.getMessages('').length, 2);
  assert.strictEqual(store.getMessages('t2').length, 1);
  // 各分片内容隔离
  assert.ok(store.getMessages('t1').every(m => m.taskId === 't1'));
});

test('特殊字符 taskId 编码为安全文件名', () => {
  store.addMessage({ role: 'user', content: 'x', taskId: '任/务:ID' });
  assert.strictEqual(store.getMessages('任/务:ID').length, 1);
  const names = fs.readdirSync(MSG_DIR);
  assert.ok(names.every(n => /^[A-Za-z0-9_.~-]+$/.test(n))); // 文件名全部 ASCII 安全
});

test('deleteOcSession 只删自己的分片', () => {
  store.upsertOcSession('s1', { title: 'x' });
  store.addMessage({ role: 'user', content: 'oc1', taskId: 's1' });
  store.deleteOcSession('s1');
  assert.strictEqual(store.getMessages('s1').length, 0);
  assert.strictEqual(store.getMessages('t1').length, 3); // 其余不受影响
});

test('tasks.json 损坏：getTasks 返回空、saveTasks 拒绝写、备份存在', () => {
  const tp = path.join(DATA, 'tasks.json');
  fs.writeFileSync(tp, '[broken', 'utf8');
  assert.deepStrictEqual(store.getTasks(), []);
  assert.throws(() => store.saveTasks([{ id: 'x' }]), /已损坏/);
  const backups = fs.readdirSync(DATA).filter(n => n.startsWith('tasks.json.corrupt-'));
  assert.strictEqual(backups.length, 1);
  assert.strictEqual(fs.readFileSync(tp, 'utf8'), '[broken'); // 原文件未被覆盖
});

test('clearMessages 清空所有分片', () => {
  store.clearMessages();
  assert.strictEqual(store.getMessages().length, 0);
  assert.strictEqual(store.getMessages('t1').length, 0);
  assert.strictEqual(store.getMessages('').length, 0);
  // 主会话分片保留为空文件（后续写入直接可用）
  assert.strictEqual(fs.existsSync(path.join(MSG_DIR, '_main.json')), true);
});

test('pruneOldData 清孤儿分片与过期主会话消息', () => {
  // 重置环境：清掉上面损坏的 tasks.json 保护状态影响（新沙箱目录）
  const DATA2 = fs.mkdtempSync(path.join(os.tmpdir(), 'store-prune-'));
  process.env.AGENTS_CHAT_DATA = DATA2;
  delete require.cache[require.resolve('../app/lib/store')];
  const store2 = require('../app/lib/store');

  const old = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  store2.saveTasks([
    { id: 'keep-t', title: '存活任务', status: 'done', createdAt: Date.now(), updatedAt: Date.now() },
    { id: 'old-t', title: '过期任务', status: 'done', createdAt: 1, updatedAt: 1 }
  ]);
  store2.addMessage({ role: 'user', content: 'keep', taskId: 'keep-t' });
  store2.addMessage({ role: 'user', content: 'orphan', taskId: 'ghost' });
  store2.addMessage({ role: 'user', content: 'old-main', taskId: '', timestamp: old });
  store2.addMessage({ role: 'user', content: 'new-main', taskId: '' });

  const stat = store2.pruneOldData(15);
  assert.strictEqual(stat.tasks, 1);                      // 过期完结任务被清
  assert.strictEqual(store2.getMessages('keep-t').length, 1);   // 存活任务消息保留
  assert.strictEqual(store2.getMessages('ghost').length, 0);    // 孤儿分片删除
  const main = store2.getMessages('');
  assert.strictEqual(main.length, 1);
  assert.strictEqual(main[0].content, 'new-main');        // 过期主会话消息被清
});
