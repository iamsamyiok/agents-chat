// 分工模式单测：分工解析 / 调度循环（@ 传导、回灌唤醒、去重、上限、停止）
const test = require('node:test');
const assert = require('node:assert');

process.env.AGENTS_CHAT_DATA = process.env.AGENTS_CHAT_DATA || require('os').tmpdir() + '/divide-test-' + Date.now();
const orch = require('../app/lib/orchestrator');

const A = (id, name) => ({ id, name, icon: '🤖', desc: name + '职责' });
const MEMBERS = [A('fin', '财务经理'), A('sale', '销售经理'), A('prod', '生产经理'), A('rd', '研发经理')];

// 事件收集器：模拟 emit/onMessage
function collector() {
  const notices = [];
  const messages = [];
  return {
    emit: (e) => { if (e.type === 'notice') notices.push(e.content); },
    onMessage: (m) => messages.push(m),
    notices, messages
  };
}

test('divideMentions：@ 名字/id 解析、去重、名单外忽略', () => {
  const hits = orch.testDivideMentions('请 @生产经理 反馈产能，同时 @fin 给预算，@销售经理 也看看 @生产经理', MEMBERS);
  assert.deepStrictEqual(hits.map(a => a.id), ['prod', 'fin', 'sale']);
  assert.strictEqual(orch.testDivideMentions('@不存在的角色', MEMBERS).length, 0);
  assert.strictEqual(orch.testDivideMentions('没有点名', MEMBERS).length, 0);
});

test('runDivideCore：初始并行执行 + 无 @ 直接结束', async () => {
  const c = collector();
  const plan = MEMBERS.map((a, i) => ({ agent: a, task: i < 2 ? `任务${i}` : '' })); // 2 干活 2 旁听
  const ran = [];
  const r = await orch.testRunDivideCore(plan, {}, c.emit, c.onMessage, async (item) => {
    ran.push(item.agent.id);
    return { agent: item.agent, output: `${item.agent.name} 干完了`, hop: item.hop };
  });
  assert.deepStrictEqual(ran.sort(), ['fin', 'sale']);
  assert.strictEqual(r.ok, true);
  // 分工表 + 2 条产出
  const roles = c.messages.map(m => m.role);
  assert.ok(c.messages.some(m => m.role === 'sys' && m.content.includes('分工表') && m.content.includes('旁听')));
  assert.strictEqual(c.messages.filter(m => m.role === 'assistant').length, 2);
  assert.ok(c.messages.every(m => m.phase === 'divide'));
});

test('runDivideCore：@ 传导——被@者执行、结果回灌、原@者被唤醒继续', async () => {
  const c = collector();
  const plan = [{ agent: MEMBERS[3], task: '研发任务' }]; // 研发经理
  const calls = [];
  const r = await orch.testRunDivideCore(plan, { participants: MEMBERS }, c.emit, c.onMessage, async (item) => {
    calls.push(item.agent.id + ':' + item.hop);
    if (item.agent.id === 'rd' && item.hop === 0) {
      return { agent: item.agent, output: '我需要产能数据，@生产经理 请反馈', hop: 0 };
    }
    if (item.agent.id === 'prod') {
      return { agent: item.agent, output: '产能充足，月产 1 万件', hop: item.hop };
    }
    // rd 第二轮（唤醒继续）
    return { agent: item.agent, output: `基于反馈的最终研发计划（收到：${item.context.slice(-20)}）`, hop: item.hop };
  });
  // 执行顺序：rd → prod → rd（唤醒）
  assert.deepStrictEqual(calls, ['rd:0', 'prod:1', 'rd:1']);
  assert.strictEqual(r.ok, true);
  // 唤醒轮上下文包含研发上轮产出与生产经理反馈
  const last = calls[calls.length - 1];
  assert.strictEqual(last, 'rd:1');
  assert.ok(r.finalText.includes('最终研发计划'));
});

test('runDivideCore：同轮多人 @ 同一人只执行一次，双方都收到回灌', async () => {
  const c = collector();
  const plan = [{ agent: MEMBERS[3], task: '研发' }, { agent: MEMBERS[0], task: '财务' }];
  const prodRuns = [];
  const r = await orch.testRunDivideCore(plan, { participants: MEMBERS }, c.emit, c.onMessage, async (item) => {
    if (item.agent.id === 'prod') { prodRuns.push(item.hop); return { agent: item.agent, output: '产能数据齐了', hop: item.hop }; }
    if (item.hop === 0) return { agent: item.agent, output: `${item.agent.name}开工，需要数据 @生产经理`, hop: 0 };
    return { agent: item.agent, output: `${item.agent.name}拿到数据完成`, hop: item.hop };
  });
  assert.strictEqual(prodRuns.length, 1); // 生产经理只跑一次
  // 研发与财务都被唤醒
  assert.ok(c.messages.some(m => m.content.includes('研发经理拿到数据完成')));
  assert.ok(c.messages.some(m => m.content.includes('财务经理拿到数据完成')));
});

test('runDivideCore：传导跳数上限（≤2）与总段数上限（≤8）', async () => {
  const c = collector();
  // 无限互相 @ 的脚本：A/B 互拉，应被 hop≤2 与 total≤8 截断
  const plan = [{ agent: MEMBERS[0], task: '开始' }];
  const r = await orch.testRunDivideCore(plan, { participants: MEMBERS }, c.emit, c.onMessage, async (item) => {
    const other = MEMBERS.find(m => m.id !== item.agent.id);
    return { agent: item.agent, output: `继续 @${other.name}`, hop: item.hop };
  });
  assert.ok(c.notices.some(n => n.includes('参与上限')));
  assert.ok(r.stopped === false);
  // 总段数 = 全部 onMessage assistant 条数 ≤ 8
  const work = c.messages.filter(m => m.role === 'assistant').length;
  assert.ok(work <= 8, `实际 ${work} 段`);
  assert.ok(work >= 4); // hop 0→1→2 各至少一段
});

test('runDivideCore：手动停止立即终止传导', async () => {
  const c = collector();
  let stopped = false;
  const plan = [{ agent: MEMBERS[0], task: '开始' }];
  await orch.testRunDivideCore(plan, { participants: MEMBERS, isStopped: () => stopped }, c.emit, c.onMessage, async (item) => {
    if (item.hop === 0) { stopped = true; return { agent: item.agent, output: `@销售经理 请接手`, hop: 0 }; }
    return { agent: item.agent, output: '不该执行到这里', hop: item.hop };
  });
  assert.ok(c.notices.some(n => n.includes('手动停止')));
  assert.strictEqual(c.messages.filter(m => m.content.includes('不该执行')).length, 0);
});

test('runDivideCore：被 @ 者执行失败时错误结果照常回灌', async () => {
  const c = collector();
  const plan = [{ agent: MEMBERS[3], task: '研发' }];
  const r = await orch.testRunDivideCore(plan, { participants: MEMBERS }, c.emit, c.onMessage, async (item) => {
    if (item.agent.id === 'prod') return { agent: item.agent, error: '内核超时', hop: item.hop };
    if (item.hop === 0) return { agent: item.agent, output: '@生产经理 请反馈', hop: 0 };
    return { agent: item.agent, output: '没有反馈也给出保守计划', hop: item.hop };
  });
  assert.ok(r.ok); // 研发最终仍给出回答
  assert.ok(c.messages.some(m => m.content.includes('[执行出错] 内核超时')));
});

test('runDivideCore：同事忙时 @ 不共享其手头产出，完成后专门响应一轮', async () => {
  const c = collector();
  // A、B 同批各有初始任务；A 产出 @B 请求支持（B 此刻在执行初始任务）
  const plan = [{ agent: MEMBERS[3], task: '研发' }, { agent: MEMBERS[2], task: '生产' }];
  const calls = [];
  let aWakeupCtx = '';
  await orch.testRunDivideCore(plan, { participants: MEMBERS }, c.emit, c.onMessage, async (item) => {
    calls.push(item.agent.id + ':' + item.hop + (item.wakeUp === 'pending' ? 'R' : ''));
    if (item.agent.id === 'rd' && item.hop === 0) {
      return { agent: item.agent, output: '研发需要产能数据，@生产经理 请提供', hop: 0 };
    }
    if (item.agent.id === 'prod' && item.wakeUp !== 'pending') {
      return { agent: item.agent, output: '生产初始工作结论（与请求无关的内容）', hop: 0 };
    }
    if (item.agent.id === 'prod') {
      // 响应轮：必须针对请求给回应，而非拿初始产出搪塞
      return { agent: item.agent, output: '专门响应：月产能 1 万件', hop: item.hop };
    }
    // rd 唤醒轮
    aWakeupCtx = item.context;
    return { agent: item.agent, output: '研发收到反馈完成', hop: item.hop };
  });
  // 执行序列：初始并行 → B 响应轮 → A 唤醒收尾
  assert.deepStrictEqual(calls.sort(), ['prod:0', 'prod:1R', 'rd:0', 'rd:1']);
  // A 唤醒轮收到的是 B 的专门响应，而非其初始任务产出
  assert.ok(aWakeupCtx.includes('专门响应：月产能 1 万件'), '唤醒上下文应含专门响应');
  assert.ok(!aWakeupCtx.includes('与请求无关的内容'), '唤醒上下文不应混入初始产出');
  // A 唤醒轮上下文包含 A 自己的初始任务（--no-session 下需自包含）
  assert.ok(aWakeupCtx.includes('研发'), '唤醒上下文应含初始任务背景');
});

test('runDivideCore：传导达上限后请求者仍能收尾（final 轮豁免跳数）', async () => {
  const c = collector();
  // A 每轮都 @ B 要数据；B 每轮响应；hop 到 2 后 B 响应被拒 → A 必须还能给出最终回答
  const plan = [{ agent: MEMBERS[0], task: '财务分析' }];
  const r = await orch.testRunDivideCore(plan, { participants: MEMBERS }, c.emit, c.onMessage, async (item) => {
    if (item.agent.id === 'fin') {
      if (item.final) return { agent: item.agent, output: '基于已有信息的最终财务结论', hop: item.hop };
      return { agent: item.agent, output: '@销售经理 请给销售预测数据', hop: item.hop };
    }
    return { agent: item.agent, output: '销售预测：约 500 万', hop: item.hop };
  });
  assert.ok(c.notices.some(n => n.includes('参与上限')));
  // 最终收尾轮发生且产出进入结果
  assert.ok(r.finalText.includes('最终财务结论'), '请求者应完成收尾');
  const work = c.messages.filter(m => m.role === 'assistant').length;
  assert.ok(work <= 8 && work >= 4, `段数 ${work}`);
});

test('dividePlan：mock 模式返回确定性演示分工', async () => {
  process.env.AGENTS_CHAT_MOCK = '1';
  try {
    const plan = await orch.testDividePlan(MEMBERS, '做一份经营计划', '');
    assert.strictEqual(plan.length, MEMBERS.length);
    assert.ok(plan[0].task.includes('演示分工'));
    assert.strictEqual(plan[2].task, ''); // 后排成员旁听
  } finally { delete process.env.AGENTS_CHAT_MOCK; }
});
