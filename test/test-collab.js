// 协作通道单测：node test/test-collab.js（零测试框架）
// 覆盖：共享看板(init/append/note提取/read截断)、中途委派解析(各格式/长度保护)、
//       审批关卡(模式匹配/停止联动/拒绝路径)、审批基础设施由 e2e 覆盖
process.env.AGENTS_CHAT_DATA = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'collab-test-'));
delete process.env.AGENTS_CHAT_APPROVAL;

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const orch = require('../app/lib/orchestrator');

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failed++; console.error(`  FAIL - ${name}\n    ${e.message}`); }
}
const noopEmit = () => {};

(async () => {
  console.log('collab（看板/委派/审批）单测：');

  // parseHandoff 未见导出——通过模块级函数测试需导出；先验证行为约定
  await t('模块导出协作原语', async () => {
    assert.strictEqual(typeof orch.runButler, 'function');
  });

  await t('看板：init 写头部 + append 追加进展与看板更新 + read 读回', () => {
    const dir = path.join(process.env.AGENTS_CHAT_DATA, 'sess1');
    orch.testBoardInit(dir, '做一个 hello 页面', '工程师、研究员');
    let text = orch.testBoardRead(dir);
    assert.ok(text.includes('# 共享看板'));
    assert.ok(text.includes('hello 页面'));
    assert.ok(text.includes('## 进展'));
    orch.testBoardAppend(dir, '阶段1', '工程师', '完成了页面骨架', '已确定用原生 JS，不要框架', ['/tmp/a.js']);
    text = orch.testBoardRead(dir);
    assert.ok(text.includes('[阶段1] 工程师：完成了页面骨架'));
    assert.ok(text.includes('已确定用原生 JS，不要框架'));
    assert.ok(text.includes('/tmp/a.js'));
  });

  await t('看板：read 截断到上限', () => {
    const dir = path.join(process.env.AGENTS_CHAT_DATA, 'sess2');
    orch.testBoardInit(dir, 'x'.repeat(500), 'a');
    for (let i = 0; i < 30; i++) orch.testBoardAppend(dir, `阶段${i}`, '智能体', '进展内容'.repeat(20), '', []);
    const text = orch.testBoardRead(dir, 800);
    assert.ok(text.length <= 900, `长度 ${text.length}`);
    assert.ok(text.includes('…（更早已截断）'));
  });

  await t('看板更新提取：块边界与缺失', () => {
    assert.strictEqual(orch.testExtractBoardNote('结果如下…\n\n【看板更新】\n1. 决定用 pnpm\n2. 测试跑 vitest'), '1. 决定用 pnpm 2. 测试跑 vitest');
    assert.strictEqual(orch.testExtractBoardNote('普通输出没有看板块'), '');
    assert.strictEqual(orch.testExtractBoardNote('【看板更新】' + '长'.repeat(900)).length <= 602, true, '超长看板更新应截断');
  });

  await t('委派解析：代码块 JSON / 裸 JSON / 带前后缀', () => {
    const a = orch.testParseHandoff('职责错配，转交\n\n```json\n{"handoff":"研究员","reason":"需要检索"}\n```');
    assert.deepStrictEqual(a, { to: '研究员', reason: '需要检索' });
    const b = orch.testParseHandoff('{"handoff":"工程师","reason":"要写代码"}');
    assert.deepStrictEqual(b, { to: '工程师', reason: '要写代码' });
    const c = orch.testParseHandoff('说明文字 {"handoff":"文案","reason":"x"} 结尾');
    assert.ok(c && c.to === '文案');
  });

  await t('委派解析：长输出/无 handoff 键/坏 JSON 一律不认', () => {
    assert.strictEqual(orch.testParseHandoff('【产出文件】\n- /x/y.md\n\n详细的正式产出内容'.repeat(30)), null);
    assert.strictEqual(orch.testParseHandoff('{"steps":[]}'), null);
    assert.strictEqual(orch.testParseHandoff('{"handoff": 123}'), null);
    assert.strictEqual(orch.testParseHandoff('文字 {broken json}'), null);
    assert.strictEqual(orch.testParseHandoff(''), null);
  });

  await t('审批关卡：off 与未配置直接放行', async () => {
    assert.strictEqual(await orch.testApprovalGate('plan', 'x', { approval: 'off' }, noopEmit, () => false, ''), true);
    assert.strictEqual(await orch.testApprovalGate('plan', 'x', {}, noopEmit, () => false, ''), true);
    assert.strictEqual(await orch.testApprovalGate('plan', 'x', { approval: 'plan' }, noopEmit, () => false, ''), true, '未注入 requestApproval 应放行');
  });

  await t('审批关卡：模式匹配（plan/verify/all）', async () => {
    let asked = 0;
    const req = async () => { asked++; return true; };
    assert.strictEqual(await orch.testApprovalGate('plan', 'x', { approval: 'plan', requestApproval: req }, noopEmit, () => false, ''), true);
    assert.strictEqual(await orch.testApprovalGate('verify', 'x', { approval: 'plan', requestApproval: req }, noopEmit, () => false, ''), true, 'plan 模式不放行 verify 关卡也直接过');
    assert.strictEqual(asked, 1);
    assert.strictEqual(await orch.testApprovalGate('verify', 'x', { approval: 'all', requestApproval: req }, noopEmit, () => false, ''), true);
    assert.strictEqual(asked, 2);
  });

  await t('审批关卡：拒绝返回 false', async () => {
    const req = async () => false;
    assert.strictEqual(await orch.testApprovalGate('plan', 'x', { approval: 'all', requestApproval: req }, noopEmit, () => false, ''), false);
  });

  await t('审批关卡：等待期间用户点停止 → 视为拒绝', async () => {
    const req = () => new Promise(() => {}); // 永不决议
    let stopped = false;
    setTimeout(() => { stopped = true; }, 60);
    const r = await orch.testApprovalGate('plan', 'x', { approval: 'all', requestApproval: req }, noopEmit, () => stopped, '');
    assert.strictEqual(r, false);
  });

  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
