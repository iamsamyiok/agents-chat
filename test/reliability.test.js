// 可靠性增强回归：幂等提交 claim / 审批持久化与中断恢复 / 成果清单惰性引用
// 单元部分：store 落盘 + orchestrator 清单与上下文注入；集成部分：真实服务子进程走网络栈
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

// ---------- 单元：store（claims / pending-approvals） ----------
process.env.AGENTS_CHAT_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'reli-store-'));
const store = require('../app/lib/store');

test('claims：upsert → 读取 → settle → 删除', () => {
  store.upsertClaim('cid-1', { scope: 'chat', status: 'pending', createdAt: new Date().toISOString() });
  assert.strictEqual(store.getClaims()['cid-1'].status, 'pending');
  store.upsertClaim('cid-1', { status: 'done', result: { taskId: 't' } });
  const c = store.getClaims()['cid-1'];
  assert.strictEqual(c.status, 'done');
  assert.strictEqual(c.result.taskId, 't');
  assert.ok(c.createdAt && c.updatedAt);
  store.deleteClaim('cid-1');
  assert.strictEqual(store.getClaims()['cid-1'], undefined);
});

test('claims：超上限淘汰最旧（ updatedAt ）', () => {
  for (let i = 0; i < 510; i++) {
    store.upsertClaim(`bulk-${i}`, { scope: 'chat', status: 'done', updatedAt: new Date(Date.now() + i).toISOString() });
  }
  const keys = Object.keys(store.getClaims());
  assert.ok(keys.length <= 500, `claims 数量应被限制在 500 以内，实际 ${keys.length}`);
  assert.strictEqual(store.getClaims()['bulk-0'], undefined); // 最旧被淘汰
  assert.ok(store.getClaims()['bulk-509']); // 最新保留
});

test('claims：损坏文件回退为空表（不抛异常）', () => {
  fs.writeFileSync(path.join(store.DATA_DIR, 'submit-claims.json'), '{broken json!!');
  assert.deepStrictEqual(store.getClaims(), {});
});

test('pending-approvals：save → markInterrupted → remove 全链路', () => {
  const id = 'apr-test-1';
  store.savePendingApproval(id, { kind: 'plan', label: '调度方案', taskId: 't1', runId: 'run-1', createdAt: new Date().toISOString(), deadline: new Date(Date.now() + 60000).toISOString(), status: 'pending' });
  assert.strictEqual(store.getPendingApprovals()[id].status, 'pending');
  store.markApprovalInterrupted(id, new Date().toISOString());
  const rec = store.getPendingApprovals()[id];
  assert.strictEqual(rec.status, 'interrupted');
  assert.ok(rec.interruptedAt);
  assert.strictEqual(rec.runId, 'run-1'); // 断点重跑锚点保留
  store.removePendingApproval(id);
  assert.strictEqual(store.getPendingApprovals()[id], undefined);
});

// ---------- 单元：orchestrator（成果清单 / 惰性注入 / 审批透传） ----------
const orch = require('../app/lib/orchestrator');

function mkSession() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reli-sess-'));
  const artifact = path.join(dir, 'report.md');
  fs.writeFileSync(artifact, '# 报告\n内容');
  return { dir, artifact };
}

test('registerArtifacts：产出文件进清单 + 去重 + 不存在文件跳过', () => {
  const { dir, artifact } = mkSession();
  const agent = { name: '工程师' };
  const output = `完成\n\n【产出文件】\n${artifact}`;
  const ap = orch.testRegisterArtifacts(dir, [{ agent, output }], 'task-1');
  assert.ok(ap, '应返回清单路径');
  let body = fs.readFileSync(ap, 'utf8');
  assert.ok(body.includes(`- ${artifact} ｜ 工程师 ｜`), `清单行格式不符：\n${body}`);
  // 重复注册：不产生重复行
  orch.testRegisterArtifacts(dir, [{ agent, output }], 'task-1');
  body = fs.readFileSync(ap, 'utf8');
  assert.strictEqual(body.split('\n').filter(l => l.startsWith(`- ${artifact} `)).length, 1);
  // 不存在的文件不进清单
  const ghost = orch.testRegisterArtifacts(dir, [{ agent, output: `【产出文件】\n${dir}/no-such.md` }], 'task-1');
  assert.ok(!fs.readFileSync(ghost, 'utf8').includes('no-such.md'));
});

test('registerArtifacts：无产出文件不创建清单', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reli-empty-'));
  const r = orch.testRegisterArtifacts(dir, [{ agent: { name: 'x' }, output: '纯文本' }], 'task-2');
  assert.strictEqual(r, '');
  assert.ok(!fs.existsSync(path.join(dir, 'ARTIFACTS.md')));
});

test('appendWorkContext：full 模式有清单时注入句柄而非全文', () => {
  process.env.AGENTS_CHAT_HANDOFF = 'full';
  try {
    const { artifact } = mkSession();
    // 清单必须落在该 taskId 的会话产出目录（sessionOutDir = DATA/outputs/<taskId>），句柄才能被找到
    const sessDir = path.join(store.DATA_DIR, 'outputs', 'task-3');
    fs.mkdirSync(sessDir, { recursive: true });
    orch.testRegisterArtifacts(sessDir, [{ agent: { name: '工程师' }, output: `【产出文件】\n${artifact}` }], 'task-3');
    const prev = { agent: { name: '工程师' }, output: 'A'.repeat(3000), phase: 'work' };
    // 无清单（taskId 无对应会话）：回退摘要
    const fallback = orch.testAppendWorkContext('PROMPT', [prev], '', 'task-none');
    assert.ok(fallback.includes('【工作背景：前序智能体的产出摘要'));
    // 有清单：句柄 + 状态行，不展开产出正文
    const out = orch.testAppendWorkContext('PROMPT', [prev], '', 'task-3');
    assert.ok(out.includes('【成果清单】'), '应注入清单句柄');
    assert.ok(out.includes('ARTIFACTS.md'));
    assert.ok(out.includes('工程师（完成）'));
    assert.ok(!out.includes('A'.repeat(100)), '不应内嵌产出正文');
  } finally {
    delete process.env.AGENTS_CHAT_HANDOFF;
  }
});

test('appendWorkContext：doc 模式保持交接文档不变', () => {
  const prev = { agent: { name: '工程师' }, output: '完成内容', phase: 'work', instruction: '做某事' };
  const out = orch.testAppendWorkContext('PROMPT', [prev], '', 'task-4');
  assert.ok(out.includes('【交接文档'));
  assert.ok(!out.includes('【成果清单】'));
});

test('approvalGate：runId 透传到 requestApproval（持久化锚点）', async () => {
  const calls = [];
  const opts = { approval: 'plan', requestApproval: (kind, label, taskId, runId) => { calls.push({ kind, label, taskId, runId }); return true; } };
  const ok = await orch.testApprovalGate('plan', '调度方案', opts, () => {}, () => false, 'task-5', 'run-abc');
  assert.strictEqual(ok, true);
  assert.deepStrictEqual(calls[0], { kind: 'plan', label: '调度方案', taskId: 'task-5', runId: 'run-abc' });
});

// ---------- 集成：真实服务子进程（启动恢复 / discard / 幂等重放） ----------
const PORT = 4200 + (process.pid % 100);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'reli-http-'));
let child = null;
let childDead = '';

test.before(async () => {
  // 预置上次进程遗留的未决审批：一条未超时（应标记 interrupted）、一条已超时（应被清除）
  const aid = 'apr-boot-1';
  fs.writeFileSync(path.join(DATA, 'pending-approvals.json'), JSON.stringify({
    approvals: {
      [aid]: { kind: 'plan', label: '调度方案：2 个阶段', taskId: '', runId: 'run-boot-1', createdAt: new Date(Date.now() - 60000).toISOString(), deadline: new Date(Date.now() + 300000).toISOString(), status: 'pending' },
      'apr-boot-expired': { kind: 'verify', label: '交付确认', taskId: '', runId: '', createdAt: new Date(Date.now() - 7200000).toISOString(), deadline: new Date(Date.now() - 3600000).toISOString(), status: 'pending' }
    }
  }, null, 2));
  child = spawn(process.execPath, [path.join(__dirname, '..', 'app', 'server.js'), '--port', String(PORT)], {
    env: { ...process.env, AGENTS_CHAT_MOCK: '1', AGENTS_CHAT_DATA: DATA, AGENTS_CHAT_AUTOSTOP: '0' },
    stdio: 'ignore'
  });
  child.on('exit', (code, sig) => { childDead = `code=${code} sig=${sig}`; });
  for (let i = 0; i < 50; i++) {
    if (childDead) throw new Error(`服务进程提前退出（${childDead}）`);
    try { await fetch(`${BASE}/api/health`); return; } catch { await new Promise(r => setTimeout(r, 200)); }
  }
  throw new Error('服务启动超时');
});
test.after(() => {
  if (child) { try { child.kill('SIGKILL'); } catch { /* ignore */ } child.unref(); }
});

const post = async (p, body) => {
  const r = await fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  return { status: r.status, ct: r.headers.get('content-type') || '', body: await r.json().catch(() => null) };
};

test('启动恢复：未决审批标记 interrupted（带 runId），超时项被清除', async () => {
  const r = await fetch(BASE + '/api/approvals').then(x => x.json());
  assert.strictEqual(r.success, true);
  const items = r.approvals.filter(a => a.id === 'apr-boot-1');
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].status, 'interrupted');
  assert.strictEqual(items[0].runId, 'run-boot-1');
  assert.strictEqual(r.approvals.filter(a => a.id === 'apr-boot-expired').length, 0);
});

test('discard：忽略中断审批 → 列表消失；重复 discard 404', async () => {
  const ok = await post('/api/approval', { id: 'apr-boot-1', discard: true });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.body.discarded, true);
  const r = await fetch(BASE + '/api/approvals').then(x => x.json());
  assert.strictEqual(r.approvals.filter(a => a.id === 'apr-boot-1').length, 0);
  const dup = await post('/api/approval', { id: 'apr-boot-1', discard: true });
  assert.strictEqual(dup.status, 404);
});

test('幂等重放：cards/run 同 cid 第二次返回 replayed', async () => {
  const r1 = await post('/api/cards/run', { clientSubmitId: 'cid-cards-1' });
  assert.strictEqual(r1.status, 200);
  assert.strictEqual(r1.body.success, true);
  assert.ok(!r1.body.replayed);
  const r2 = await post('/api/cards/run', { clientSubmitId: 'cid-cards-1' });
  assert.strictEqual(r2.status, 200);
  assert.strictEqual(r2.body.success, true);
  assert.strictEqual(r2.body.replayed, true);
  const r3 = await post('/api/cards/run', { clientSubmitId: 'cid-cards-2' });
  assert.strictEqual(r3.body.success, true);
  assert.ok(!r3.body.replayed);
});

test('幂等 + 校验失败：chat 空 message 落 failed claim，重试同 cid 返回同一错误', async () => {
  const r1 = await post('/api/chat', { clientSubmitId: 'cid-bad-1' });
  assert.strictEqual(r1.status, 400);
  const r2 = await post('/api/chat', { clientSubmitId: 'cid-bad-1' });
  assert.strictEqual(r2.status, 200);
  assert.strictEqual(r2.body.replayed, true);
  assert.strictEqual(r2.body.success, false);
  assert.ok(r2.body.error.includes('message'));
});

test('幂等重放：chat 同 cid 完成后重发返回 replayed JSON（不再跑 SSE）', async () => {
  const cid = 'cid-chat-ok-1';
  const r1 = await fetch(BASE + '/api/chat', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'reli-test', clientSubmitId: cid })
  });
  assert.ok(/text\/event-stream/.test(r1.headers.get('content-type') || ''));
  await r1.text(); // mock 编排快速完成
  const r2 = await fetch(BASE + '/api/chat', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'reli-test', clientSubmitId: cid })
  });
  assert.ok(/application\/json/.test(r2.headers.get('content-type') || ''));
  const b = await r2.json();
  assert.strictEqual(b.replayed, true);
  assert.strictEqual(b.success, true);
  assert.ok(b.result && b.result.taskId !== undefined);
});

test('幂等在途：claim 为 pending 时同 cid 提交返回 409（不二派）', async () => {
  // 直接预置一条 pending claim（等价于「首个请求在途」），确保判定窗口确定
  const cid = 'cid-conc-1';
  fs.writeFileSync(path.join(DATA, 'submit-claims.json'), JSON.stringify({
    claims: { [cid]: { scope: 'chat', status: 'pending', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } }
  }, null, 2));
  const r2 = await post('/api/chat', { message: 'conc-test', clientSubmitId: cid });
  assert.strictEqual(r2.status, 409);
  assert.strictEqual(r2.body.claimStatus, 'pending');
  // 清理：删除该 claim 后同 cid 可正常重新发起
  fs.writeFileSync(path.join(DATA, 'submit-claims.json'), JSON.stringify({ claims: {} }, null, 2));
  const r3 = await fetch(BASE + '/api/chat', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'conc-test-2', clientSubmitId: cid })
  });
  assert.ok(/text\/event-stream/.test(r3.headers.get('content-type') || ''));
  await r3.text();
});
