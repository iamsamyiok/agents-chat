// 单聊工作台（oc.js + store 扩展 + 任务 runner 分流）单测：node test/test-oc.js
// 覆盖：oc-sessions 增删改查、parseTasksFromText runner 字段、
//       chatSolo demo 链路（快照事件/会话回填/done 收口）、opencode 事件行解析、模型标识校验
process.env.AGENTS_CHAT_MOCK = '1';
process.env.AGENTS_CHAT_DATA = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'oc-test-'));

const assert = require('assert');
const store = require('../app/lib/store');
const oc = require('../app/lib/oc');

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failed++; console.error(`  FAIL - ${name}\n    ${e.stack || e.message}`); }
}

(async () => {
  console.log('oc.js / store 单测：');

  await t('oc 会话：新建/更新/查询/删除，updatedAt 排序', async () => {
    const a = store.upsertOcSession('oc-a', {});
    assert.ok(a.id === 'oc-a' && a.createdAt > 0);
    store.upsertOcSession('oc-a', { title: '第一个会话', ocSessionId: 'ses_abc123' });
    store.upsertOcSession('oc-b', { title: '第二个会话' });
    let list = store.getOcSessions();
    assert.strictEqual(list.length, 2);
    // 再碰一次 oc-a：updatedAt 刷新后排最前
    store.upsertOcSession('oc-a', {});
    list = store.getOcSessions();
    assert.strictEqual(list[0].id, 'oc-a');
    assert.strictEqual(store.getOcSession('oc-a').ocSessionId, 'ses_abc123');
    store.deleteOcSession('oc-a');
    list = store.getOcSessions();
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].id, 'oc-b');
    assert.strictEqual(store.getOcSession('oc-a'), null);
  });

  await t('oc 会话删除时连带清理其消息', async () => {
    store.addMessage({ role: 'user', content: 'hi', taskId: 'oc-b' });
    store.addMessage({ role: 'assistant', content: 'hello', taskId: 'oc-b', agentId: 'solo', phase: 'work' });
    store.addMessage({ role: 'user', content: '主会话消息' });
    store.deleteOcSession('oc-b');
    assert.strictEqual(store.getMessages('oc-b').length, 0);
    assert.ok(store.getMessages('').length >= 1); // 其他会话不受影响
  });

  await t('parseTasksFromText：runner=solo 标记任务', async () => {
    const { tasks } = store.parseTasksFromText('1. 写周报\n2. 发邮件', 'sequential', 'solo');
    assert.strictEqual(tasks.length, 2);
    assert.ok(tasks.every(x => x.runner === 'solo'));
    const g = store.parseTasksFromText('1. 写周报', 'sequential');
    assert.strictEqual(g.tasks[0].runner, '');
    const s = store.parseTasksFromText('20260819-0900 起床干活', 'scheduled', 'solo');
    assert.strictEqual(s.tasks[0].runner, 'solo');
    assert.strictEqual(s.tasks[0].kind, 'scheduled');
  });

  await t('chatSolo demo：快照事件累积 + 会话回填 + done 收口', async () => {
    const events = [];
    await new Promise((resolve) => {
      oc.chatSolo('demo', null, { prompt: '你好，演示单聊', behavior: 'solo-chat' }, (ev) => {
        events.push(ev);
        if (ev.type === 'done') resolve();
      });
    });
    assert.ok(events.some(e => e.type === 'session' && /^ses_demo-/.test(e.ocSessionId)));
    const texts = events.filter(e => e.type === 'text');
    assert.ok(texts.length >= 2, '快照事件应为多行累积');
    // 后一次快照包含前一次内容（覆盖式语义）
    const last = texts[texts.length - 1].text;
    assert.ok(last.includes('[单聊] 收到'), '最终快照应包含完整累积文本');
    const done = events.find(e => e.type === 'done');
    assert.ok(done && !done.error);
  });

  await t('chatSolo demo：solo-task 行为输出任务结果', async () => {
    const texts = [];
    await new Promise((resolve) => {
      oc.chatSolo('demo', null, { prompt: '生成日报', behavior: 'solo-task' }, (ev) => {
        if (ev.type === 'text') texts.push(ev.text);
        if (ev.type === 'done') resolve();
      });
    });
    assert.ok(texts[texts.length - 1].includes('任务完成'));
  });

  await t('opencode 事件行解析：text/reasoning/tool_use/error/sessionID', async () => {
    const out = [];
    const state = { ocSessionId: '', errEvents: [], toolSeq: 0 };
    const emit = (ev) => out.push(ev);
    oc.parseSoloEventLine(JSON.stringify({ type: 'text', sessionID: 'ses_abc', part: { id: 'prt_1', text: '第一段' } }), emit, state);
    assert.strictEqual(state.ocSessionId, 'ses_abc');
    assert.deepStrictEqual(out[0], { type: 'session', ocSessionId: 'ses_abc' });
    assert.deepStrictEqual(out[1], { type: 'text', partId: 'prt_1', text: '第一段' });
    // 第二个 text part：partId 不同，独立事件
    oc.parseSoloEventLine(JSON.stringify({ type: 'text', sessionID: 'ses_abc', part: { id: 'prt_2', text: '第二段' } }), emit, state);
    assert.strictEqual(out.length, 3);
    assert.strictEqual(out[2].partId, 'prt_2');
    // 同 partId 快照覆盖：事件仍是全量，由消费端覆盖渲染
    oc.parseSoloEventLine(JSON.stringify({ type: 'text', sessionID: 'ses_abc', part: { id: 'prt_2', text: '第二段（完整快照）' } }), emit, state);
    assert.strictEqual(out[3].text, '第二段（完整快照）');
    // reasoning
    oc.parseSoloEventLine(JSON.stringify({ type: 'reasoning', sessionID: 'ses_abc', part: { id: 'rs_1', text: '思考中…' } }), emit, state);
    assert.strictEqual(out[out.length - 1].type, 'reasoning');
    // tool_use：带摘要
    oc.parseSoloEventLine(JSON.stringify({ type: 'tool_use', sessionID: 'ses_abc', part: { tool: 'read', state: { input: { path: 'a.md' } } } }), emit, state);
    const toolEv = out[out.length - 1];
    assert.strictEqual(toolEv.type, 'tool');
    assert.strictEqual(toolEv.name, 'read');
    assert.ok(toolEv.summary.includes('read'));
    // error：进 errEvents
    oc.parseSoloEventLine(JSON.stringify({ type: 'error', sessionID: 'ses_abc', error: { data: { message: '额度不足' } } }), emit, state);
    assert.deepStrictEqual(state.errEvents, ['额度不足']);
    // 非 JSON / 缺 type / 空文本：安全忽略
    assert.doesNotThrow(() => oc.parseSoloEventLine('not-json', emit, state));
    assert.doesNotThrow(() => oc.parseSoloEventLine(JSON.stringify({ type: 'text', part: { text: '   ' } }), emit, state));
    assert.doesNotThrow(() => oc.parseSoloEventLine(JSON.stringify({ type: 'step_start' }), emit, state));
    assert.strictEqual(out.filter(e => e.type === 'text').length, 3);
    // 危险 sessionID 不回填
    const state2 = { ocSessionId: '', errEvents: [], toolSeq: 0 };
    oc.parseSoloEventLine(JSON.stringify({ type: 'text', sessionID: 'bad id;rm', part: { id: 'p', text: 'x' } }), emit, state2);
    assert.strictEqual(state2.ocSessionId, '');
  });

  await t('MODEL_RE 校验：仅 provider/model 且安全字符', async () => {
    assert.ok(oc.MODEL_RE.test('anthropic/claude-sonnet-4-5'));
    assert.ok(oc.MODEL_RE.test('openai/gpt-4o-mini'));
    assert.ok(!oc.MODEL_RE.test('rm -rf /'));
    assert.ok(!oc.MODEL_RE.test('single'));
    assert.ok(!oc.MODEL_RE.test('a/b/c'));
  });

  await t('demoModels 提供可交互的假列表', async () => {
    const list = oc.demoModels();
    assert.ok(list.length >= 2);
    assert.ok(list.every(m => oc.MODEL_RE.test(m.id)));
  });

  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  process.exit(failed ? 1 : 0);
})();
