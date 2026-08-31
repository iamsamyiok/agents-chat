// HTTP 层回归：真实服务子进程 + fetch 走网络栈，覆盖核心路由契约
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execSync } = require('child_process');

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

// ---------- opencode 条件测试辅助：本机有 opencode 时起隔离服务（XDG 指向临时目录） ----------
function hasOc() {
  try { execSync('which opencode', { stdio: 'ignore', timeout: 5000 }); return true; } catch { return false; }
}
async function withOcServer(fn) {
  const XDG = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-xdg-'));
  const D2 = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-data-'));
  const P2 = 3900 + (process.pid % 100);
  const c2 = spawn(process.execPath, [path.join(__dirname, '..', 'app', 'server.js'), '--port', String(P2)], {
    env: { ...process.env, AGENTS_CHAT_MOCK: '', AGENTS_CHAT_DATA: D2, AGENTS_CHAT_AUTOSTOP: '0', XDG_CONFIG_HOME: XDG },
    stdio: 'ignore'
  });
  try {
    for (let i = 0; i < 50; i++) {
      if (c2.exitCode !== null) throw new Error('opencode 服务进程提前退出');
      try { await fetch(`http://127.0.0.1:${P2}/api/health`); break; } catch { await new Promise(r => setTimeout(r, 200)); }
    }
    await fn(`http://127.0.0.1:${P2}`);
  } finally {
    try { c2.kill('SIGKILL'); } catch { /* ignore */ }
    c2.unref();
  }
}

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

test('AI 编排与三标签角标路由（demo 拒绝 / 参数校验 / stats / batch）', async () => {
  // demo 模式：chat/plan 明确拒绝并给指引
  const c = await fetch(BASE + '/api/planner/chat', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: '做个官网' })
  });
  const cb = await c.json();
  assert.strictEqual(cb.success, false);
  assert.ok(cb.error.includes('真实执行内核'));
  const p = await fetch(BASE + '/api/planner/plan', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sid: 'pl-x' })
  });
  assert.strictEqual((await p.json()).success, false);
  // message 空 / 超长 → 400
  const c2 = await fetch(BASE + '/api/planner/chat', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: '  ' })
  });
  assert.strictEqual(c2.status, 400);
  const c3 = await fetch(BASE + '/api/planner/chat', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'x'.repeat(4001) })
  });
  assert.strictEqual(c3.status, 400);
  // session 恢复：不存在的 sid → found:false
  const s = await get('/api/planner/session?sid=pl-nope');
  assert.strictEqual(s.body.found, false);
  // 卡牌统计：字段齐全
  const st = await get('/api/cards/stats');
  assert.ok(st.body.success);
  const k = st.body.stats;
  for (const f of ['total', 'pending', 'running', 'done', 'failed']) assert.strictEqual(typeof k[f], 'number');
  assert.strictEqual(k.total, k.pending + k.running + k.done + k.failed);
  // 批量导入：append 建卡 + 批内依赖映射 + 环依赖跳过
  const batch = await fetch(BASE + '/api/cards/batch', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tasks: [
      { title: '步骤一', content: '先做', mode: 'new', deps: [] },
      { title: '步骤二', content: '再做', mode: 'continue', deps: [1] },
      { title: '环A', content: 'x', mode: 'new', deps: [4] },
      { title: '环B', content: 'y', mode: 'new', deps: [3] }
    ] })
  });
  const bb = await batch.json();
  assert.strictEqual(bb.success, true);
  assert.strictEqual(bb.cards.length, 4);
  assert.ok(bb.warnings.length >= 1, '环依赖应产生 warning');
  const step2 = bb.cards[1];
  assert.strictEqual(step2.mode, 'continue');
  assert.strictEqual(step2.chainId, bb.cards[0].id); // 续聊链首 = 第一个依赖
  assert.deepStrictEqual(step2.dependsOn, [bb.cards[0].id]);
  // 环依赖至少一跳被丢弃
  const cyc = bb.cards.map(x => x.dependsOn);
  const flat = [].concat(...cyc);
  assert.ok(flat.length <= 3);
  // replace 模式：清空再导入
  const rep = await fetch(BASE + '/api/cards/batch', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tasks: [{ title: '唯一', content: 'one', mode: 'new', deps: [] }], importMode: 'replace' })
  });
  const rb = await rep.json();
  assert.strictEqual(rb.success, true);
  assert.ok(rb.replaced >= 4);
  assert.strictEqual(rb.cards.length, 1);
  const after = await get('/api/cards/stats');
  assert.strictEqual(after.body.stats.total, 1);
  // 空 tasks → 400
  const bad = await fetch(BASE + '/api/cards/batch', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tasks: [] })
  });
  assert.strictEqual(bad.status, 400);
});

test('分工模式路由：空名单 400 / demo 正常路径 / 409 互斥', async () => {
  // 1) 空参与名单且消息无 @ → 400
  const empty = await fetch(BASE + '/api/chat', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: '分工做点事', mode: 'divide', participants: [] })
  });
  assert.strictEqual(empty.status, 400);

  // 2) demo 正常路径：SSE 流含分工表与成员产出（mock 演示分工 + mock 执行通道）
  const { body: ag } = await get('/api/agents');
  assert.ok(ag.success && ag.agents.length > 0);
  const ids = ag.agents.filter(a => a.id !== 'butler').slice(0, 3).map(a => a.id);
  assert.ok(ids.length >= 2, '默认团队应有可用子智能体');
  const r1 = await fetch(BASE + '/api/chat', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: '制定季度经营计划', mode: 'divide', participants: ids })
  });
  assert.strictEqual(r1.status, 200);
  assert.ok(/text\/event-stream/.test(r1.headers.get('content-type') || ''));

  // 3) 上一条 SSE 未结束（锁持有中）→ 409 互斥
  const r2 = await fetch(BASE + '/api/chat', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: '第二条消息', mode: 'divide', participants: ids })
  });
  assert.strictEqual(r2.status, 409);

  const text = await r1.text(); // 等待编排自然结束
  assert.ok(text.includes('分工表'));
  assert.ok(text.includes('演示分工')); // mock 演示分工任务文案
});

test('LLM 默认模型路由（demo 模式：GET 标注不支持 / POST 400）', async () => {
  const g = await get('/api/llm/config');
  assert.strictEqual(g.status, 200);
  assert.ok(g.body.success);
  assert.strictEqual(g.body.supported, false);
  assert.strictEqual(g.body.custom, null); // custom 字段契约：未配置/不支持时为 null
  const p = await fetch(BASE + '/api/llm/config', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'a/b' })
  });
  assert.strictEqual(p.status, 400);
});

test('LLM 自定义接入路由（demo 模式：POST custom / clearCustom 均 400）', async () => {
  const p1 = await fetch(BASE + '/api/llm/config', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ custom: { baseURL: 'https://a.com/v1', apiKey: 'k', model: 'm' } })
  });
  assert.strictEqual(p1.status, 400);
  assert.match((await p1.json()).error, /不支持网页端/);
  const p2 = await fetch(BASE + '/api/llm/config', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'clearCustom' })
  });
  assert.strictEqual(p2.status, 400);
});

test('LLM 自定义接入路由（真实 opencode：保存 → 回显脱敏 → 清除，XDG 隔离）', { skip: !hasOc() }, async () => {
  const t = await withOcServer(async (B) => {
    // 保存：三项落盘 + 默认模型联动
    const s = await fetch(B + '/api/llm/config', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ custom: { baseURL: 'https://api.e2e.com/v1', apiKey: 'sk-e2e-abcd1234', model: 'e2e-model' } })
    });
    assert.strictEqual(s.status, 200);
    const sd = await s.json();
    assert.ok(sd.success);
    assert.strictEqual(sd.model, 'custom/e2e-model');
    assert.strictEqual(sd.custom.apiKeyTail, '1234');
    assert.ok(!('apiKey' in sd.custom)); // 明文 Key 永不回传
    // GET 回显：脱敏
    const g = await fetch(B + '/api/llm/config');
    const gd = await g.json();
    assert.strictEqual(gd.supported, true);
    assert.strictEqual(gd.custom.baseURL, 'https://api.e2e.com/v1');
    assert.strictEqual(gd.custom.hasApiKey, true);
    assert.strictEqual(gd.custom.apiKeyTail, '1234');
    // 参数校验：非法 URL 400
    const bad = await fetch(B + '/api/llm/config', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ custom: { baseURL: 'not-a-url', apiKey: 'k', model: 'm' } })
    });
    assert.strictEqual(bad.status, 400);
    // 清除：恢复 null
    const c = await fetch(B + '/api/llm/config', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'clearCustom' })
    });
    const cd = await c.json();
    assert.ok(cd.success);
    assert.strictEqual(cd.custom, null);
    const g2 = await fetch(B + '/api/llm/config');
    assert.strictEqual((await g2.json()).custom, null);
  });
  await t;
});

test('404 未知路由', async () => {
  const r = await fetch(BASE + '/api/nonexistent');
  assert.strictEqual(r.status, 404);
});
