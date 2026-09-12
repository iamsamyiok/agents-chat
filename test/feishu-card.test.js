'use strict';
// 飞书交互卡片：卡片构建器 + 卡片按钮回调分发（白名单/去重/toast 响应）
const test = require('node:test');
const assert = require('node:assert');
const feishu = require('../app/lib/bridge-feishu');

test('buildApprovalCard: 橙头 + 编号 + 批准/驳回按钮 value', () => {
  const card = feishu.buildApprovalCard({ seq: 3, kind: 'plan', label: '重构 store 模块', timeoutMin: 10 });
  assert.equal(card.header.template, 'orange');
  assert.equal(card.header.title.content, '⏸ 审批请求 #3');
  const action = card.elements.find((e) => e.tag === 'action');
  assert.ok(action);
  const [okBtn, noBtn] = action.actions;
  assert.deepEqual(okBtn.value, { act: 'approve', n: 3 });
  assert.deepEqual(noBtn.value, { act: 'reject', n: 3 });
  const md = card.elements.find((e) => e.tag === 'div');
  assert.ok(md.text.content.includes('方案确认'));
  assert.ok(md.text.content.includes('重构 store 模块'));
  assert.ok(md.text.content.includes('10 分钟'));
});

test('buildApprovalCard: label 截断到 300 字符', () => {
  const long = 'x'.repeat(500);
  const card = feishu.buildApprovalCard({ seq: 1, kind: 'delivery', label: long, timeoutMin: 5 });
  const md = card.elements.find((e) => e.tag === 'div');
  assert.ok(md.text.content.length < 500);
  assert.ok(md.text.content.includes('交付验收'));
});

test('buildBatchDoneCard: 全成功绿头，有失败橙头', () => {
  const okCard = feishu.buildBatchDoneCard({ scope: '群聊', total: 2, done: 2, failed: 0, blocked: 0, titles: ['a', 'b'] });
  assert.equal(okCard.header.template, 'green');
  const badCard = feishu.buildBatchDoneCard({ scope: '群聊', total: 3, done: 1, failed: 1, blocked: 1, titles: ['a'] });
  assert.equal(badCard.header.template, 'orange');
  const md = badCard.elements.find((e) => e.tag === 'div');
  assert.ok(md.text.content.includes('失败 1'));
  assert.ok(md.text.content.includes('阻塞 1'));
});

test('buildBatchDoneCard: 清单超过 10 条截断并提示总数', () => {
  const titles = Array.from({ length: 12 }, (_, i) => '任务' + i);
  const card = feishu.buildBatchDoneCard({ scope: '', total: 12, done: 12, failed: 0, blocked: 0, titles });
  const md = card.elements.find((e) => e.tag === 'div');
  assert.ok(md.text.content.includes('…等共 12 个任务'));
});

test('dispatchCardAction: 非白名单会话拒绝且不执行', async () => {
  let called = 0;
  const hooks = { cardAction: async () => { called++; return 'ok'; } };
  const data = { context: { open_chat_id: 'oc_other', open_message_id: 'om_1' }, operator: { open_id: 'ou_1' }, action: { value: { act: 'status' } } };
  const r = await feishu.dispatchCardAction(data, hooks, { allowedChats: ['oc_ok'] });
  assert.equal(r.ok, false);
  assert.equal(r.toast.type, 'error');
  assert.equal(called, 0);
});

test('dispatchCardAction: 分发到 hooks.cardAction 并返回 toast', async () => {
  const seen = [];
  const hooks = { cardAction: async (val) => { seen.push(val); return '✅ 已通过审批 #7'; } };
  const data = { context: { open_chat_id: 'oc_ok', open_message_id: 'om_' + Date.now() }, operator: { open_id: 'ou_1' }, action: { value: { act: 'approve', n: 7 } } };
  const r = await feishu.dispatchCardAction(data, hooks, { allowedChats: ['oc_ok'] });
  assert.equal(r.ok, true);
  assert.equal(r.toast.type, 'success');
  assert.deepEqual(seen, [{ act: 'approve', n: 7 }]);
  assert.ok(r.toast.content.includes('已通过审批'));
});

test('dispatchCardAction: 同一点击重投去重，二次不执行', async () => {
  let called = 0;
  const hooks = { cardAction: async () => { called++; return 'done'; } };
  const mid = 'om_dup_' + Math.random().toString(36).slice(2, 8);
  const data = { context: { open_chat_id: 'oc_ok', open_message_id: mid }, operator: { open_id: 'ou_1' }, action: { value: { act: 'stop' } } };
  const r1 = await feishu.dispatchCardAction(data, hooks, { allowedChats: ['oc_ok'] });
  const r2 = await feishu.dispatchCardAction(data, hooks, { allowedChats: ['oc_ok'] });
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, false);
  assert.equal(r2.toast, null);
  assert.equal(called, 1);
});

test('dispatchCardAction: hooks 抛错时返回 error toast', async () => {
  const hooks = { cardAction: async () => { throw new Error('审批已超时'); } };
  const data = { context: { open_chat_id: 'oc_ok', open_message_id: 'om_err_' + Math.random().toString(36).slice(2, 8) }, operator: { open_id: 'ou_1' }, action: { value: { act: 'reject', n: 9 } } };
  const r = await feishu.dispatchCardAction(data, hooks, { allowedChats: ['oc_ok'] });
  assert.equal(r.ok, true);
  assert.equal(r.toast.type, 'error');
  assert.ok(r.toast.content.includes('审批已超时'));
});

test('dispatchCardAction: status 动作回 info toast', async () => {
  const hooks = { cardAction: async () => '群聊编排：空闲' };
  const data = { context: { open_chat_id: 'oc_ok', open_message_id: 'om_st_' + Math.random().toString(36).slice(2, 8) }, operator: { open_id: 'ou_1' }, action: { value: { act: 'status' } } };
  const r = await feishu.dispatchCardAction(data, hooks, { allowedChats: ['oc_ok'] });
  assert.equal(r.toast.type, 'info');
});

test('dispatchCardAction: 未连接时留痕发送静默失败不阻塞响应', async () => {
  const hooks = { cardAction: async () => 'ok-reply' };
  const data = { context: { open_chat_id: 'oc_ok', open_message_id: 'om_nc_' + Math.random().toString(36).slice(2, 8) }, operator: { open_id: 'ou_1' }, action: { value: { act: 'status' } } };
  const r = await feishu.dispatchCardAction(data, hooks, { allowedChats: ['oc_ok'] });
  assert.equal(r.ok, true);
});
