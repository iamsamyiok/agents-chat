// orchestrator.js 纯函数测试（调度方案解析与依赖拆分）
const test = require('node:test');
const assert = require('node:assert');
process.env.AGENTS_CHAT_DATA = require('fs').mkdtempSync(
  require('path').join(require('os').tmpdir(), 'orch-test-'));
const orch = require('../app/lib/orchestrator');

const AGENTS = [
  { id: 'butler', name: '管家' },
  { id: 'ag-eng', name: '工程师' },
  { id: 'ag-rs', name: '研究员' }
];

test('extractPlanJSON：围栏 JSON / 裸 JSON / 无效输入', () => {
  const plan = { steps: [[{ agent: '工程师', instruction: 'x' }]] };
  assert.deepStrictEqual(orch.testExtractPlanJSON('说明\n```json\n' + JSON.stringify(plan) + '\n```'), plan);
  assert.deepStrictEqual(orch.testExtractPlanJSON('前缀 ' + JSON.stringify(plan) + ' 后缀'), plan);
  assert.strictEqual(orch.testExtractPlanJSON('完全没有 JSON'), null);
});

test('resolveAgentRef：名称 / ID / @前缀 / 组合 / 包含匹配 / 未知', () => {
  assert.strictEqual(orch.testResolveAgentRef('工程师', AGENTS).id, 'ag-eng');
  assert.strictEqual(orch.testResolveAgentRef('ag-rs', AGENTS).id, 'ag-rs');
  assert.strictEqual(orch.testResolveAgentRef('@工程师', AGENTS).id, 'ag-eng');
  assert.strictEqual(orch.testResolveAgentRef('工程师（ag-eng）', AGENTS).id, 'ag-eng');
  assert.strictEqual(orch.testResolveAgentRef('资深工程师', AGENTS).id, 'ag-eng'); // 包含匹配
  assert.strictEqual(orch.testResolveAgentRef('不存在的人', AGENTS), null);
});

test('splitByDependency：引用同组他人的步骤拆到后续阶段', () => {
  const groups = [[
    { agentId: 'ag-eng', agentName: '工程师', instruction: '独立完成 A' },
    { agentId: 'ag-rs', agentName: '研究员', instruction: '等工程师完成后做 B' }
  ]];
  const out = orch.testSplitByDependency(groups);
  assert.strictEqual(out.length, 2);                     // 拆成两个串行阶段
  assert.strictEqual(out[0].length, 1);
  assert.strictEqual(out[0][0].agentName, '工程师');      // 被依赖者先行
  assert.strictEqual(out[1][0].agentName, '研究员');
});

test('splitByDependency：无依赖保持同组并行', () => {
  const groups = [[
    { agentId: 'a', agentName: '甲', instruction: '做 A' },
    { agentId: 'b', agentName: '乙', instruction: '做 B' }
  ]];
  const out = orch.testSplitByDependency(groups);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].length, 2);
});

test('normalizePhases：未知智能体剔除并告警，合法步骤归一化', () => {
  const warns = [];
  const phases = orch.testNormalizePhases(
    { steps: [[{ agent: '工程师', instruction: '干活' }, { agent: '路人甲', instruction: '??' }]] },
    AGENTS,
    m => warns.push(m)
  );
  assert.strictEqual(warns.length, 1);
  assert.strictEqual(phases.length, 1);
  assert.strictEqual(phases[0].length, 1);
  assert.strictEqual(phases[0][0].agentId, 'ag-eng');
  assert.strictEqual(phases[0][0].agentName, '工程师');
});
