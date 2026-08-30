// Git 隔离执行端到端：导入 isolated 任务 → mock 执行落盘到 worktree → diff 查看改动 → 合并 → 丢弃
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile, spawn } = require('child_process');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'wtflow-data-'));
const WS = path.join(DATA, 'workspace'); // 默认共享工作目录 → init 为 git 仓库
fs.mkdirSync(WS, { recursive: true });
process.env.AGENTS_CHAT_DATA = DATA;

const git = (args, cwd) => new Promise((r, j) => execFile('git', args, { cwd: cwd || WS }, (e, so, se) => e ? j(new Error(se || e.message)) : r(so)));

test('工作目录初始化为 git 仓库', async () => {
  await git(['init', '-q']);
  await git(['config', 'user.email', 't@t']);
  await git(['config', 'user.name', 't']);
  fs.writeFileSync(path.join(WS, 'readme.md'), '# demo\n');
  await git(['add', '-A']);
  await git(['commit', '-qm', 'init']);
});

let BASE = '';
let server;
test('启动 mock 服务', async () => {
  const port = 3800 + Math.floor(Math.random() * 100);
  BASE = `http://localhost:${port}`;
  server = spawn(process.execPath, [path.join(__dirname, '..', 'app', 'server.js'), '--port', String(port)], {
    env: { ...process.env, AGENTS_CHAT_MOCK: '1', AGENTS_CHAT_AUTOSTOP: '0', AGENTS_CHAT_DATA: DATA, PORT: String(port) },
    stdio: ['ignore', 'ignore', 'ignore']
  });
  let ok = false;
  for (let i = 0; i < 40 && !ok; i++) {
    await new Promise(r => setTimeout(r, 250));
    try { ok = (await fetch(BASE + '/api/health')).ok; } catch { /* not up */ }
  }
  assert.ok(ok, '服务应就绪');
});

let taskId = '';
test('导入 Git 隔离单聊任务（isolated）', async () => {
  const r = await fetch(BASE + '/api/tasks/import', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '1. 写一份演示产出', mode: 'sequential', runner: 'solo', isolated: true })
  });
  const b = await r.json();
  assert.ok(b.success);
  assert.strictEqual(b.isolated, 1, '应成功创建 1 个隔离区');
  taskId = (b.addedTasks || b.tasks.find(t => t.title.includes('演示产出')) || {}).id || b.tasks.find(t => t.title.includes('演示产出')).id;
  const t = b.tasks.find(x => x.id === taskId);
  assert.ok(t.worktree && t.worktree.dir, '任务应携带 worktree 信息');
  assert.ok(fs.existsSync(t.worktree.dir));
});

test('执行任务：mock 产出落在隔离区', async () => {
  const r = await fetch(BASE + '/api/tasks/run', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scope: 'solo', taskIds: [taskId] })
  });
  assert.strictEqual(r.status, 200);
  const text = await r.text(); // SSE 到 all_done 结束
  assert.ok(text.includes('all_done'), '批次应完成');
  await new Promise(r2 => setTimeout(r2, 300));
  const t = (await (await fetch(BASE + '/api/tasks')).json()).tasks.find(x => x.id === taskId);
  assert.strictEqual(t.status, 'done');
  const wt = t.worktree;
  assert.ok(fs.existsSync(path.join(wt.dir, 'demo-solo-output.md')), 'mock 产出应写入隔离区');
  assert.ok(!fs.existsSync(path.join(WS, 'demo-solo-output.md')), '主工作目录应保持干净');
});

test('diff：隔离区改动可查', async () => {
  const b = await (await fetch(BASE + '/api/tasks/diff?id=' + taskId)).json();
  assert.ok(b.success);
  const files = b.diff.stat.map(s => s.file);
  assert.ok(files.includes('demo-solo-output.md'), 'diff 应含 mock 产出文件');
  const f = b.diff.files.find(x => x.path === 'demo-solo-output.md');
  assert.ok(f && f.patch.includes('单聊任务'), 'patch 应有内容');
});

test('merge：改动合并回主工作目录', async () => {
  const r = await fetch(BASE + '/api/tasks/merge', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: taskId })
  });
  const b = await r.json();
  assert.ok(b.success, b.error || '应合并成功');
  assert.ok(fs.existsSync(path.join(WS, 'demo-solo-output.md')), '主工作目录应出现产出文件');
});

test('discard：丢弃隔离区', async () => {
  const t0 = (await (await fetch(BASE + '/api/tasks')).json()).tasks.find(x => x.id === taskId);
  const r = await fetch(BASE + '/api/tasks/discard', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: taskId })
  });
  const b = await r.json();
  assert.ok(b.success, b.error || '应丢弃成功');
  assert.ok(!fs.existsSync(t0.worktree.dir), 'worktree 目录应删除');
  const t = (await (await fetch(BASE + '/api/tasks')).json()).tasks.find(x => x.id === taskId);
  assert.ok(!t.worktree, '任务上隔离信息应清除');
  assert.strictEqual(t.status, 'done', '任务本身保留');
});

test('收尾', async () => {
  server.kill('SIGKILL');
  server.unref();
});
