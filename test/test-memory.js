// 管家记忆模块单测：node test/test-memory.js（零测试框架，直接断言）
// 覆盖：容量阶梯（直接写/淘汰最旧/超长单条截断）、去重、remove/replace、
//       memoryBlock 注入格式与用量、recallFromMessages 关键词检索与排除、compressHistory 确定性回退
process.env.AGENTS_CHAT_DATA = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'mem-test-'));
process.env.AGENTS_CHAT_MEMORY = '1';
// 不配置 AUX → 走确定性路径；单独 stub auxReady 验证整理分支不会被误触发
delete process.env.AGENTS_CHAT_AUX_BASE_URL;

const assert = require('assert');
const store = require('../app/lib/store');
const memory = require('../app/lib/memory');

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failed++; console.error(`  FAIL - ${name}\n    ${e.message}`); }
}

(async () => {
  console.log('memory.js 单测：');

  await t('初始为空，usage 为 0', async () => {
    const u = memory.usage('memory');
    assert.strictEqual(u.used, 0);
    assert.strictEqual(u.limit, 2000);
    assert.strictEqual(memory.usage('user').limit, 1200);
  });

  await t('add 直接写入', async () => {
    const r = await memory.applyOps([{ action: 'add', target: 'memory', content: '项目用纯原生 JS，零依赖' }]);
    assert.ok(r[0].ok);
    assert.strictEqual(store.getMemoryData().memory.length, 1);
  });

  await t('重复内容跳过', async () => {
    const r = await memory.applyOps([{ action: 'add', target: 'memory', content: '项目用纯原生 JS，零依赖' }]);
    assert.ok(r[0].ok && r[0].dup);
    assert.strictEqual(store.getMemoryData().memory.length, 1);
  });

  await t('remove / replace 按 old 片段匹配', async () => {
    await memory.applyOps([{ action: 'add', target: 'user', content: '用户偏好中文回复' }]);
    let r = await memory.applyOps([{ action: 'replace', target: 'user', old: '中文回复', content: '用户偏好简洁的中文回复' }]);
    assert.ok(r[0].ok);
    assert.strictEqual(store.getMemoryData().user[0], '用户偏好简洁的中文回复');
    r = await memory.applyOps([{ action: 'remove', target: 'user', old: '简洁的中文' }]);
    assert.ok(r[0].ok);
    assert.strictEqual(store.getMemoryData().user.length, 0);
    r = await memory.applyOps([{ action: 'remove', target: 'user', old: '不存在的' }]);
    assert.ok(!r[0].ok);
  });

  await t('容量满且无辅助模型 → 淘汰最旧保新', async () => {
    store.saveMemoryData({ memory: [], user: [] });
    const long = 'a'.repeat(950);
    await memory.applyOps([{ action: 'add', target: 'memory', content: long + '-1' }]);
    await memory.applyOps([{ action: 'add', target: 'memory', content: long + '-2' }]);
    assert.strictEqual(store.getMemoryData().memory.length, 2); // 952*2=1904 < 2000
    const r = await memory.applyOps([{ action: 'add', target: 'memory', content: long + '-3' }]);
    assert.ok(r[0].ok);
    const m = store.getMemoryData().memory;
    assert.ok(m.length >= 1 && m.length <= 2, `条数异常: ${m.length}`);
    assert.ok(m[m.length - 1].endsWith('-3'), '最新条目必须保留');
    assert.ok(!m.some(e => e.endsWith('-1')), '最旧条目应被淘汰');
    assert.ok(memory.usage('memory').used <= 2000);
  });

  await t('单条超长 → 截断到上限且不报错', async () => {
    store.saveMemoryData({ memory: [], user: [] });
    const r = await memory.applyOps([{ action: 'add', target: 'user', content: 'x'.repeat(5000) }]);
    assert.ok(r[0].ok);
    const u = store.getMemoryData().user;
    assert.strictEqual(u.length, 1);
    assert.strictEqual(u[0].length, 1200);
  });

  await t('空/畸形操作安全返回', async () => {
    const r = await memory.applyOps([]);
    assert.deepStrictEqual(r, []);
    const r2 = await memory.applyOps([{ action: 'add', target: 'memory', content: '' }]);
    assert.ok(!r2[0].ok);
    const r3 = await memory.applyOps([{ action: 'replace', target: 'memory', content: 'x' }]);
    assert.ok(!r3[0].ok);
  });

  await t('makeRoom：只负责腾位（是否容纳 incoming），追加由调用方完成', () => {
    const out = memory.makeRoom(['旧的', '更旧的'], '新的超长条目'.repeat(200), 2000);
    assert.ok(Array.isArray(out) && out.length >= 1);
    assert.strictEqual(memory.makeRoom(['a', 'b'], 'c', 2000).length, 2, '两条均容纳时原样返回');
    assert.strictEqual(memory.makeRoom(['a', 'b'], 'c'.repeat(2000), 2000).length, 0, '完全放不下时清空');
  });

  await t('memoryBlock：两仓标注 + 用量百分比 + § 分隔', async () => {
    store.saveMemoryData({ memory: ['笔记一'], user: ['画像一'] });
    const block = memory.memoryBlock(['memory', 'user']);
    assert.ok(block.includes('〔工作笔记'));
    assert.ok(block.includes('〔用户画像'));
    assert.ok(block.includes('%'));
    assert.ok(block.includes('笔记一') && block.includes('画像一'));
    assert.ok(!memory.memoryBlock(['memory']).includes('画像一'), 'target 过滤失效');
  });

  await t('recallFromMessages：命中跨任务历史并排除当前任务', () => {
    const msgs = [
      { role: 'user', content: '帮我用 React 组件库做一个后台管理系统的登录页', taskId: 't1' },
      { role: 'assistant', agentName: '管家', content: '登录页已完成，使用了 React 组件库', taskId: 't1' },
      { role: 'user', content: '今天天气不错', taskId: 't2' },
      { role: 'user', content: '再说一次登录页需求', taskId: 'cur' }
    ];
    const out = memory.recallFromMessages(msgs, '登录页 组件库', { excludeTaskId: 'cur' });
    assert.ok(out.includes('[历史任务]'), JSON.stringify(out));
    assert.ok(out.includes('React'), '应命中 t1 内容');
    assert.ok(!out.includes('再说一次'), '当前任务内容必须排除');
    assert.strictEqual(memory.recallFromMessages(msgs, '完全无关词组', { excludeTaskId: 'cur' }), '');
  });

  await t('recallFromMessages：主会话按 epoch 排除当前轮', () => {
    const msgs = [
      { role: 'user', content: '部署流程要写清楚 nginx 配置的细节', epoch: 0 },
      { role: 'user', content: 'nginx 配置再说一遍', epoch: 1 }
    ];
    const out = memory.recallFromMessages(msgs, 'nginx 配置', { excludeEpoch: 1 });
    assert.ok(out.includes('epoch'.slice(0, 0) + '[早前会话]') || out.includes('[早前会话]'));
    assert.ok(!out.includes('再说一遍'), '当前 epoch 内容必须排除');
  });

  await t('compressHistory：短文本直通，超长无辅助模型走确定性截断', async () => {
    const short = '短历史';
    const r1 = await memory.compressHistory(short, { minLen: 4000 });
    assert.strictEqual(r1.text, short);
    assert.strictEqual(r1.compressed, false);
    const long = '这是很长的一段会话历史。'.repeat(1000); // ~11000 字
    const r2 = await memory.compressHistory(long, { limit: 1200, minLen: 4000 });
    assert.strictEqual(r2.compressed, false, '未配置辅助模型应为确定性回退');
    assert.ok(r2.text.length <= 1200, `截断后长度 ${r2.text.length}`);
  });

  await t('reflectOnRun：未配置辅助模型返回 null 且不写入', async () => {
    const r = await memory.reflectOnRun('用户要求所有回复用中文');
    assert.strictEqual(r, null);
    assert.strictEqual(store.getMemoryData().memory.filter(e => e.includes('中文')).length, 0);
  });

  await t('memoryEnabled 开关', () => {
    assert.strictEqual(memory.memoryEnabled(), true);
    process.env.AGENTS_CHAT_MEMORY = '0';
    assert.strictEqual(memory.memoryEnabled(), false);
    process.env.AGENTS_CHAT_MEMORY = '1';
  });

  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
