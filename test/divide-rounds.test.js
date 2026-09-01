// 分工多轮循环单测：结构化产出 / 研判（mock）/ 轮次循环 / 聊天背景构建与压缩
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

process.env.AGENTS_CHAT_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'divide-round-'));
process.env.AGENTS_CHAT_MOCK = '1'; // 分工/研判/执行全走确定性演示路径
const orch = require('../app/lib/orchestrator');
const store = require('../app/lib/store');

const A = (id, name) => ({ id, name, icon: '🤖', desc: name + '职责' });
const MEMBERS = [A('fin', '财务经理'), A('rd', '研发经理'), A('sale', '销售经理')];

function collector() {
  const notices = [];
  const messages = [];
  return {
    emit: (e) => { if (e.type === 'notice') notices.push(e.content); },
    onMessage: (m) => messages.push(m),
    notices, messages
  };
}

test('runDivideCore：返回结构化 outputs（含成员名与产出）', async () => {
  const c = collector();
  const plan = [MEMBERS[0], MEMBERS[1]].map((a, i) => ({ agent: a, task: `任务${i}` }));
  const r = await orch.testRunDivideCore(plan, {}, c.emit, c.onMessage, async (item) => {
    return { agent: item.agent, output: `${item.agent.name}的产出`, hop: item.hop };
  });
  assert.strictEqual(r.ok, true);
  assert.ok(Array.isArray(r.outputs) && r.outputs.length === 2);
  assert.ok(r.outputs.every(o => o.name && o.output));
  assert.ok(r.outputs.some(o => o.name === '财务经理' && o.output.includes('财务经理')));
});

test('divideReview（mock）：首轮即判定完成，返回汇总', async () => {
  const r = await orch.testDivideReview(MEMBERS, '做预算', '', [{ id: 'fin', name: '财务经理', output: '预算完成' }], 1, 3);
  assert.strictEqual(r.done, true);
  assert.deepStrictEqual(r.next, []);
  assert.ok(r.summary.includes('演示研判'));
});

test('runDivide（mock）：执行后研判完成，发出最终汇报消息', async () => {
  const c = collector();
  const r = await orch.runDivide(MEMBERS, '做一份预算表', { taskId: '', history: '' }, c.emit, c.onMessage);
  assert.strictEqual(r.ok, true);
  // 研判结论提示 + 分工研判汇报消息（assistant 角色）
  assert.ok(c.notices.some(n => n.includes('研判结论')));
  const report = c.messages.find(m => m.role === 'assistant' && m.agentName === '分工研判');
  assert.ok(report && report.content.length > 0 && report.phase === 'divide');
});

test('buildDivideHistory：正式对话进入背景，sys 提示与计划卡排除', async () => {
  const tid = 'hist-case-' + Date.now();
  store.addMessage({ role: 'user', content: '用户需求A', taskId: tid, timestamp: new Date().toISOString() });
  store.addMessage({ role: 'sys', content: '系统提示不应出现', taskId: tid, timestamp: new Date().toISOString() });
  store.addMessage({ role: 'assistant', agentName: '财务经理', phase: 'divide', content: '成员产出B', taskId: tid, timestamp: new Date().toISOString() });
  store.addMessage({ role: 'assistant', agentName: '管家', phase: 'plan', content: '计划卡不应出现', plan: { thought: 'x', phases: [] }, taskId: tid, timestamp: new Date().toISOString() });
  const text = await orch.buildDivideHistory(tid);
  assert.ok(text.includes('用户需求A'));
  assert.ok(text.includes('成员产出B'));
  assert.ok(!text.includes('系统提示'));
  assert.ok(!text.includes('计划卡'));
});

test('buildDivideHistory：超长历史触发自动压缩（保留摘要标记）', async () => {
  const tid = 'hist-long-' + Date.now();
  const long = '长'.repeat(500);
  for (let i = 0; i < 200; i++) {
    store.addMessage({ role: i % 2 ? 'assistant' : 'user', agentName: '成员', phase: i % 2 ? 'divide' : undefined, content: long, taskId: tid, timestamp: new Date().toISOString() });
  }
  // 10 万字符 > 默认 6 万预算 → 压缩路径（mock 下由演示 LLM 或兜底截断产出）
  const text = await orch.buildDivideHistory(tid);
  assert.ok(typeof text === 'string' && text.length > 0);
  assert.ok(text.includes('聊天记录'), '超长背景应带压缩/兜底标记');
});
