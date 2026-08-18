// 辅助小模型客户端单测：node test/test-aux-llm.js
// 覆盖：auxReady 配置判断、stripThinking、parseAuxJSON 容错、auxChat 重试/超时/降级（stub fetch，零网络）
process.env.AGENTS_CHAT_AUX_BASE_URL = 'https://aux.example.com/v1';
process.env.AGENTS_CHAT_AUX_MODEL = 'test-model';
process.env.AGENTS_CHAT_AUX_API_KEY = 'sk-test';

const assert = require('assert');
const { auxReady, auxChat, parseAuxJSON, stripThinking } = require('../app/lib/aux-llm');

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failed++; console.error(`  FAIL - ${name}\n    ${e.message}`); }
}
const realFetch = global.fetch;

(async () => {
  console.log('aux-llm.js 单测：');

  await t('auxReady：三项齐全才就绪', async () => {
    assert.strictEqual(auxReady(), true);
    const save = process.env.AGENTS_CHAT_AUX_API_KEY;
    process.env.AGENTS_CHAT_AUX_API_KEY = 'your-api-key-here';
    assert.strictEqual(auxReady(), false, '占位符 key 应视为未配置');
    process.env.AGENTS_CHAT_AUX_API_KEY = '';
    assert.strictEqual(auxReady(), false);
    process.env.AGENTS_CHAT_AUX_API_KEY = save;
  });

  t('stripThinking：剥离 <think> 段', () => {
    assert.strictEqual(stripThinking('<think>推理过程</think>答案'), '答案');
    assert.strictEqual(stripThinking('<THINK>a</THINK>\n答案文本'), '答案文本');
    assert.strictEqual(stripThinking('普通文本'), '普通文本');
    assert.strictEqual(stripThinking('<think>未闭合'), '', '未闭合 think（流截断）应整体丢弃');
  });

  t('parseAuxJSON：代码块包裹 / 前后缀文本 / 多余空白均可解析', () => {
    assert.deepStrictEqual(parseAuxJSON('```json\n{"a":1}\n```'), { a: 1 });
    assert.deepStrictEqual(parseAuxJSON('好的，结果如下：{"ops":[]} 以上'), { ops: [] });
    assert.strictEqual(parseAuxJSON('没有任何 JSON'), null);
    assert.strictEqual(parseAuxJSON('{"broken":'), null);
  });

  await t('auxChat：正常响应取 content', async () => {
    global.fetch = async (url, init) => {
      assert.ok(String(url).endsWith('/v1/chat/completions'));
      const auth = (init.headers && init.headers.Authorization) || '';
      assert.strictEqual(auth, 'Bearer sk-test');
      const body = JSON.parse(init.body);
      assert.strictEqual(body.model, 'test-model');
      assert.strictEqual(body.stream, false);
      return { ok: true, json: async () => ({ choices: [{ message: { content: '你好' } }] }) };
    };
    const r = await auxChat([{ role: 'user', content: 'hi' }]);
    assert.ok(r.ok && r.text === '你好');
  });

  await t('auxChat：content 空时回退 reasoning_content（思考型模型）', async () => {
    global.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '', reasoning_content: '<think>x</think>实际回答' } }] }) });
    const r = await auxChat([{ role: 'user', content: 'hi' }]);
    assert.ok(r.ok && r.text === '实际回答');
  });

  await t('auxChat：500 重试一次后成功', async () => {
    let calls = 0;
    global.fetch = async () => { calls++; return calls === 1 ? { ok: false, status: 500 } : { ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) }; };
    const r = await auxChat([{ role: 'user', content: 'hi' }]);
    assert.ok(r.ok && calls === 2);
  });

  await t('auxChat：4xx 不重试，直接降级', async () => {
    let calls = 0;
    global.fetch = async () => { calls++; const e = new Error('HTTP 401'); return { ok: false, status: 401 }; };
    const r = await auxChat([{ role: 'user', content: 'hi' }]);
    assert.ok(!r.ok && calls === 1);
    assert.ok(/401/.test(r.error));
  });

  await t('auxChat：网络拒绝重试耗尽后降级且不抛异常', async () => {
    global.fetch = async () => { throw new Error('ECONNREFUSED'); };
    const r = await auxChat([{ role: 'user', content: 'hi' }]);
    assert.ok(!r.ok && /ECONNREFUSED/.test(r.error));
  });

  await t('auxChat：AbortError 超时信息友好', async () => {
    global.fetch = async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; };
    const r = await auxChat([{ role: 'user', content: 'hi' }], { timeoutMs: 1000 });
    assert.ok(!r.ok && /超时/.test(r.error));
  });

  await t('auxChat：空内容响应返回 ok:false', async () => {
    global.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '' } }] }) });
    const r = await auxChat([{ role: 'user', content: 'hi' }]);
    assert.ok(!r.ok);
  });

  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  global.fetch = realFetch;
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
