// 分工会话续用：内核参数 -s 注入 / store 分工会话读写
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

process.env.AGENTS_CHAT_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'divide-ses-'));
const { buildKernelArgs } = require('../app/lib/agent');
const store = require('../app/lib/store');

const AG = { id: 'ag-x', name: 'X', model: '' };

test('buildKernelArgs：opencode 会话 ID 注入 -s（续聊）', () => {
  const noSes = buildKernelArgs('opencode', AG, '');
  assert.deepStrictEqual(noSes, ['run', '--format', 'json', '--auto']); // 无会话：新会话
  const withSes = buildKernelArgs('opencode', AG, 'ses_abc123');
  assert.deepStrictEqual(withSes, ['run', '--format', 'json', '-s', 'ses_abc123', '--auto']);
  // 模型 + 会话同时存在：分工模式 model 为空，但通用场景两者可叠加
  const both = buildKernelArgs('opencode', { ...AG, model: 'p/m' }, 'ses_abc123');
  assert.deepStrictEqual(both, ['run', '--format', 'json', '-m', 'p/m', '-s', 'ses_abc123', '--auto']);
});

test('buildKernelArgs：非法会话 ID 拒绝注入（安全字符校验）', () => {
  const bad = buildKernelArgs('opencode', AG, 'ses_x; rm -rf /'); // 含空格分号：拒绝
  assert.ok(!bad.includes('-s'), '非法 ID 不得进入命令行');
  assert.deepStrictEqual(bad, ['run', '--format', 'json', '--auto']);
});

test('buildKernelArgs：非 opencode 内核不受会话参数影响', () => {
  const claude = buildKernelArgs('claude', AG, 'ses_abc123');
  assert.ok(!claude.includes('-s'));
  assert.ok(claude.includes('-p'));
});

test('store 分工会话：写入 / 读回 / 合并 / 清空', () => {
  store.saveDivideSessions('main', { 'ag-a': 'ses_a1', 'ag-b': 'ses_b1' });
  assert.deepStrictEqual(store.getDivideSessionMap('main'), { 'ag-a': 'ses_a1', 'ag-b': 'ses_b1' });

  // 增量合并：只更新出现的键，不冲掉其他成员
  store.saveDivideSessions('main', { 'ag-a': 'ses_a2' });
  assert.deepStrictEqual(store.getDivideSessionMap('main'), { 'ag-a': 'ses_a2', 'ag-b': 'ses_b1' });

  // 空值删除该键
  store.saveDivideSessions('main', { 'ag-b': '' });
  assert.deepStrictEqual(store.getDivideSessionMap('main'), { 'ag-a': 'ses_a2' });

  // 任务会话与主会话隔离
  store.saveDivideSessions('t1', { 'ag-a': 'ses_t1a' });
  assert.strictEqual(store.getDivideSessionMap('t1')['ag-a'], 'ses_t1a');
  assert.strictEqual(store.getDivideSessionMap('main')['ag-a'], 'ses_a2');

  // 清空指定会话
  store.clearDivideSessions('t1');
  assert.deepStrictEqual(store.getDivideSessionMap('t1'), {});
  assert.strictEqual(store.getDivideSessionMap('main')['ag-a'], 'ses_a2');

  // 不存在的键返回空对象
  assert.deepStrictEqual(store.getDivideSessionMap('nonexistent'), {});
});
