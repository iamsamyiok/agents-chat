// HTTP 层回归：真实服务子进程 + fetch 走网络栈，覆盖核心路由契约
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const PORT = 3800 + (process.pid % 100);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'server-routes-'));
let child = null;
let childDead = '';

test.before(async () => {
  // stdio 全 ignore：子进程不持有本测试的输出管道（否则 node --test 退出后管道悬挂）
  child = spawn(process.execPath, [path.join(__dirname, '..', 'app', 'server.js'), '--port', String(PORT)], {
    env: { ...process.env, AGENTS_CHAT_MOCK: '1', AGENTS_CHAT_DATA: DATA, AGENTS_CHAT_AUTOSTOP: '0' },
    stdio: 'ignore'
  });
  child.on('exit', (code, sig) => { childDead = `code=${code} sig=${sig}`; });
  // 轮询就绪（最长 10s；进程死亡立即失败并带退出码）
  for (let i = 0; i < 50; i++) {
    if (childDead) throw new Error(`服务进程提前退出（${childDead}）`);
    try { await fetch(`${BASE}/api/health`); return; } catch { await new Promise(r => setTimeout(r, 200)); }
  }
  throw new Error('服务启动超时');
});
test.after(() => {
  if (child) { try { child.kill('SIGKILL'); } catch { /* ignore */ } child.unref(); }
});

const get = async (p) => {
  const r = await fetch(BASE + p);
  return { status: r.status, body: await r.json().catch(() => null) };
};

test('GET / 页面与内嵌资源', async () => {
  const r = await fetch(BASE + '/');
  assert.strictEqual(r.status, 200);
  const html = await r.text();
  assert.ok(html.includes('PAGE_VERSION'));
  assert.ok(/text\/html/.test(r.headers.get('content-type')));
});

test('GET /manifest.json PWA 清单', async () => {
  const r = await fetch(BASE + '/manifest.json');
  assert.strictEqual(r.status, 200);
  const m = await r.json();
  assert.strictEqual(m.name, 'Agents Chat');
});

test('GET /api/health 契约字段', async () => {
  const { status, body } = await get('/api/health');
  assert.strictEqual(status, 200);
  assert.ok(body.success);
  assert.match(body.version, /^\d+\.\d+\.\d+$/);
  assert.strictEqual(typeof body.updateAvailable, 'boolean');
  assert.strictEqual(body.runner, 'demo');
  assert.ok(Array.isArray(body.kernels));
});

test('GET /api/cards 含版本与计数', async () => {
  const { status, body } = await get('/api/cards');
  assert.strictEqual(status, 200);
  assert.ok(body.success);
  assert.ok(typeof body.msgCounts === 'object');
  assert.strictEqual(typeof body.standalone, 'boolean');
});

test('POST /api/chat mock 聊天（SSE 流）', async () => {
  const r = await fetch(BASE + '/api/chat', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'route-test' })
  });
  assert.strictEqual(r.status, 200);
  assert.ok(/text\/event-stream/.test(r.headers.get('content-type') || ''));
  const text = await r.text(); // mock 编排快速完成，SSE 自然结束
  assert.ok(text.includes('data:'));
});

test('GET /api/search 关键词检索', async () => {
  // 直接写主分片制造可搜索数据（比跑一轮聊天更可控）
  fs.mkdirSync(path.join(DATA, 'messages'), { recursive: true });
  fs.writeFileSync(path.join(DATA, 'messages', '_main.json'), JSON.stringify([
    { id: 't1', role: 'user', content: 'route-searchable-needle-xyz', timestamp: '2026-08-30T00:00:00.000Z' }
  ]));
  const { body } = await get('/api/search?q=needle-xyz');
  assert.ok(body.success);
  assert.ok(body.results.length >= 1);
  assert.ok(body.results[0].snippet.includes('needle-xyz'));
});

test('Git 隔离路由边界：无隔离区返回 404', async () => {
  // 先导入一个普通（非隔离）任务
  const imp = await fetch(BASE + '/api/tasks/import', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '1. 普通任务', mode: 'sequential', runner: 'solo' })
  });
  const ib = await imp.json();
  assert.ok(ib.success);
  const tid = ib.tasks.find(t => t.title.includes('普通任务')).id;
  // diff：任务存在但无隔离区 → 404
  const d = await get('/api/tasks/diff?id=' + tid);
  assert.strictEqual(d.status, 404);
  // merge/discard：同上
  const m = await fetch(BASE + '/api/tasks/merge', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: tid }) });
  assert.strictEqual(m.status, 404);
  const dc = await fetch(BASE + '/api/tasks/discard', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: tid }) });
  assert.strictEqual(dc.status, 404);
  // 不存在的任务 id → 404
  const d2 = await get('/api/tasks/diff?id=not-exist');
  assert.strictEqual(d2.status, 404);
});

test('GET /api/usage 与 /api/data/stats', async () => {
  const u = await get('/api/usage');
  assert.ok(u.body.usage && u.body.usage.total);
  const d = await get('/api/data/stats');
  assert.strictEqual(typeof d.body.stats.total, 'number');
  assert.ok(d.body.dataDir.includes('server-routes-'));
});

test('POST /api/data/prune 手动清理', async () => {
  const r = await fetch(BASE + '/api/data/prune', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
  });
  const body = await r.json();
  assert.ok(body.success);
  assert.ok(body.stat);
});

test('POST /api/agents/suggest 演示模式拒绝 + 参数校验', async () => {
  // 演示模式（服务以 AGENTS_CHAT_MOCK=1 启动）→ 明确拒绝并给出指引，不返回模拟团队
  const r = await fetch(BASE + '/api/agents/suggest', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requirements: '做一个电商网站团队' })
  });
  const body = await r.json();
  assert.strictEqual(r.status, 200);
  assert.strictEqual(body.success, false);
  assert.ok(body.error.includes('真实执行内核'));
  assert.ok(!Array.isArray(body.agents) || body.agents.length === 0);
  // 需求为空 → 400
  const r2 = await fetch(BASE + '/api/agents/suggest', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requirements: '   ' })
  });
  assert.strictEqual(r2.status, 400);
  // 需求超长 → 400
  const r3 = await fetch(BASE + '/api/agents/suggest', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requirements: '长'.repeat(2001) })
  });
  assert.strictEqual(r3.status, 400);
});

test('404 未知路由', async () => {
  const r = await fetch(BASE + '/api/nonexistent');
  assert.strictEqual(r.status, 404);
});
