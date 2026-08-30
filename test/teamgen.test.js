// AI 智能组队纯函数单测：提示词构建 / JSON 容错提取 / 结果清洗 / 生成链路（注入 mock 内核）
const test = require('node:test');
const assert = require('node:assert');
const { buildPrompt, extractTeamJSON, cleanSuggestedTeam, suggestTeam, LIMITS, TEAM_MIN, TEAM_MAX, REQ_MAX } = require('../app/lib/teamgen');

const TEAM = [
  { name: '调研员', icon: '🔍', desc: '市场与竞品调研', systemPrompt: '你是资深调研分析师' },
  { name: '工程师', icon: '⚙️', desc: '编码实现', systemPrompt: '你是资深工程师' }
];

test('buildPrompt：包含需求文本、输出格式要求与命名避让', () => {
  const p = buildPrompt('做跨境电商独立站', ['管家', '调研员']);
  assert.ok(p.includes('做跨境电商独立站'));
  assert.ok(p.includes('JSON 数组'));
  assert.ok(p.includes('name'));
  assert.ok(p.includes('systemPrompt'));
  assert.ok(p.includes('调研员'));
  // 无现有智能体时不输出避让段
  const p2 = buildPrompt('写小说', []);
  assert.ok(!p2.includes('不得与之重复'));
});

test('extractTeamJSON：裸 JSON 数组', () => {
  assert.deepStrictEqual(extractTeamJSON(JSON.stringify(TEAM)), TEAM);
});

test('extractTeamJSON：markdown 代码块包裹', () => {
  const text = '好的，以下是团队设计：\n```json\n' + JSON.stringify(TEAM) + '\n```\n希望有帮助';
  assert.strictEqual(extractTeamJSON(text).length, 2);
});

test('extractTeamJSON：前后杂文 + 字符串含方括号', () => {
  const tricky = [{ name: '工程师[后端]', icon: '🛠', desc: 'x]y', systemPrompt: 'a[b]c' }];
  const text = '团队如下 ' + JSON.stringify(tricky) + ' 请查收';
  assert.deepStrictEqual(extractTeamJSON(text), tricky);
});

test('extractTeamJSON：对象而非数组 / 无 JSON / 空串 → null', () => {
  assert.strictEqual(extractTeamJSON('{"name":"x"}'), null);
  assert.strictEqual(extractTeamJSON('抱歉我无法生成'), null);
  assert.strictEqual(extractTeamJSON(''), null);
  assert.strictEqual(extractTeamJSON(null), null);
});

test('cleanSuggestedTeam：字段截断与归一', () => {
  const out = cleanSuggestedTeam([{
    name: '超'.repeat(30), icon: '🎉🎉🎉🎉', desc: '长'.repeat(200),
    systemPrompt: 'x'.repeat(9000), extra: '被丢弃'
  }], []);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].name.length, LIMITS.name);
  assert.strictEqual(out[0].icon.length, 8); // 🎉 为 2 码元 x4，保留完整 4 个
  assert.strictEqual(out[0].desc.length, LIMITS.desc);
  assert.strictEqual(out[0].systemPrompt.length, LIMITS.systemPrompt);
  assert.ok(!('extra' in out[0]));
});

test('cleanSuggestedTeam：空名补名 + 与现有名单重名加序号 + 数量上限', () => {
  const out = cleanSuggestedTeam([
    { name: '', icon: '' },
    { name: ' 调研员 ', icon: '' },
    { name: '调研员', icon: '' },
    { name: 'a' }, { name: 'b' }, { name: 'c' }, { name: 'd' }, { name: 'e' }
  ], ['管家', '调研员']);
  assert.strictEqual(out.length, TEAM_MAX); // 8 个候选截断为上限
  assert.strictEqual(out[0].name, '智能体1'); // 空名补位
  assert.strictEqual(out[1].name, '调研员2'); // 与现有「调研员」冲突
  assert.strictEqual(out[2].name, '调研员3'); // 与生成内部也冲突
  assert.ok(out[3].name.length > 0);
});

test('cleanSuggestedTeam：非数组输入 → 空数组', () => {
  assert.deepStrictEqual(cleanSuggestedTeam(null, []), []);
  assert.deepStrictEqual(cleanSuggestedTeam('oops', []), []);
});

test('suggestTeam：正常链路（mock 内核返回代码块包裹 JSON）', async () => {
  const runAgentFn = (agent, prompt, onChunk) => {
    assert.ok(prompt.includes('跨境电商'));
    assert.strictEqual(agent.id, 'teamgen');
    onChunk({ content: '设计如下：\n```json\n' + JSON.stringify(TEAM) + '\n```' });
    onChunk({ content: '', done: true });
    return null;
  };
  const r = await suggestTeam({ requirements: '跨境电商', existingNames: ['管家'], runAgentFn });
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.agents.length, 2);
  assert.strictEqual(r.agents[0].name, '调研员');
});

test('suggestTeam：内核报错 → 透传错误且不解析', async () => {
  const runAgentFn = (a, p, onChunk) => { onChunk({ content: '', done: true, error: '内核崩了' }); return null; };
  const r = await suggestTeam({ requirements: 'x', runAgentFn });
  assert.strictEqual(r.success, false);
  assert.ok(r.error.includes('内核崩了'));
});

test('suggestTeam：输出无法解析 → 明确提示', async () => {
  const runAgentFn = (a, p, onChunk) => { onChunk({ content: '我无法完成这个任务' }); onChunk({ done: true }); return null; };
  const r = await suggestTeam({ requirements: 'x', runAgentFn });
  assert.strictEqual(r.success, false);
  assert.ok(r.error.includes('无法解析'));
});

test('suggestTeam：数量不足 2 个 → 拒绝', async () => {
  const runAgentFn = (a, p, onChunk) => { onChunk({ content: JSON.stringify([TEAM[0]]) }); onChunk({ done: true }); return null; };
  const r = await suggestTeam({ requirements: 'x', runAgentFn });
  assert.strictEqual(r.success, false);
  assert.ok(r.error.includes('至少需要'));
});

test('suggestTeam：超时 → 报错且调 stopScope', async () => {
  let stopped = '';
  const origStop = require('../app/lib/agent').stopScope;
  const agentMod = require('../app/lib/agent');
  agentMod.stopScope = (s) => { stopped = s; return 0; };
  try {
    const runAgentFn = () => null; // 永不回调 done
    const r = await suggestTeam({ requirements: 'x', runAgentFn, timeoutMs: 30 });
    assert.strictEqual(r.success, false);
    assert.ok(r.error.includes('超时'));
    assert.strictEqual(stopped, 'teamgen');
  } finally {
    agentMod.stopScope = origStop;
  }
});

test('常量与现有保存链路约束一致', () => {
  assert.strictEqual(LIMITS.name, 20);
  assert.strictEqual(LIMITS.desc, 100);
  assert.strictEqual(LIMITS.systemPrompt, 8000);
  assert.strictEqual(TEAM_MIN, 2);
  assert.strictEqual(TEAM_MAX, 6);
  assert.strictEqual(REQ_MAX, 2000);
});
