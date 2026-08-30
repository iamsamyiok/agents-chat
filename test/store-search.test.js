// store：全历史搜索 / 用量统计 / 空间统计测试
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'store-search-'));
process.env.AGENTS_CHAT_DATA = DATA;
process.env.AGENTS_CHAT_MSG_LIMIT = '0'; // 关上限，避免干扰
const store = require('../app/lib/store');

test('searchMessages：跨分片关键词命中与排序', () => {
  fs.mkdirSync(path.join(DATA, 'messages'), { recursive: true });
  fs.writeFileSync(path.join(DATA, 'messages', '_main.json'), JSON.stringify([
    { role: 'user', content: '早期 alpha-needle 记录', timestamp: '2026-08-01T00:00:00.000Z' }
  ]));
  // 特殊字符会话 id 走 hex 分片名
  const hex = Buffer.from('任务#A', 'utf8').toString('hex');
  fs.writeFileSync(path.join(DATA, 'messages', `_${hex}.json`), JSON.stringify([
    { role: 'assistant', agentName: '工程师', content: '后来命中 alpha-needle 的回复', timestamp: '2026-08-02T00:00:00.000Z' }
  ]));
  const r = store.searchMessages('alpha-needle', { limit: 10 });
  assert.strictEqual(r.length, 2);
  assert.strictEqual(r[0].sessionId, '任务#A'); // 时间倒序
  assert.strictEqual(r[1].sessionId, '');
  assert.ok(r[0].snippet.includes('alpha-needle'));
});

test('searchMessages：空关键词/无匹配', () => {
  assert.deepStrictEqual(store.searchMessages(''), []);
  assert.deepStrictEqual(store.searchMessages('不存在的词'), []);
});

test('usage：按消息携带 usage 累计', () => {
  store.addMessage({ role: 'assistant', content: 'a', taskId: 'u1', usage: 1500 });
  store.addMessage({ role: 'assistant', content: 'b', taskId: 'u1', usage: 2.9 });
  store.addMessage({ role: 'assistant', content: '无用量', taskId: 'u1' });
  const s = store.getUsageStats();
  assert.strictEqual(s.today.tokens, 1502); // 2.9 取整为 2
  assert.strictEqual(s.today.requests, 2);
  assert.ok(s.total.tokens >= 1502);
  assert.ok(s.recent.length >= 1);
});

test('dataStats：返回目录占用（沙箱目录至少可统计）', () => {
  const s = store.dataStats();
  assert.strictEqual(typeof s.total, 'number');
  assert.ok(s.total > 0); // messages 已有文件
  assert.ok('outputs' in s && 'workspace' in s);
});
