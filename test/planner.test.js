// AI 智能编排（planner）单测：会话存取 / chat 链路 / cleanPlan 清洗 / plan 容错 / 过期清理
// 注意：AGENTS_CHAT_DATA 必须在 require planner 前设置（DATA_DIR 顶层固化）
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'planner-'));
process.env.AGENTS_CHAT_DATA = DATA;
const planner = require('../app/lib/planner');

const TEAM = [
  { title: '设计稿', content: '完成视觉设计稿', mode: 'new', deps: [] },
  { title: '实现页面', content: '按设计稿实现', mode: 'continue', deps: [1] },
  { title: '并行调研', content: '调研竞品', mode: 'parallel', deps: [] }
];

// mock 内核：同步回调指定输出
const mockRun = (out, extra = {}) => (a, p, onChunk) => {
  if (extra.assert) extra.assert(a, p);
  onChunk({ content: out });
  onChunk(Object.assign({ content: '', done: true }, extra.chunk || {}));
  return null;
};

test('chat：创建会话 + 历史 prompt 拼装 + 落盘', async () => {
  let seenPrompt = '';
  const r = await planner.chat({
    message: '做个官网',
    runAgentFn: mockRun('好的，先问技术栈？', { assert: (a, p) => { seenPrompt = p; } })
  });
  assert.ok(r.sid.startsWith('pl-'));
  assert.strictEqual(r.reply, '好的，先问技术栈？');
  assert.ok(seenPrompt.includes('做个官网'));
  assert.ok(seenPrompt.includes('项目经理')); // system 人设注入
  const s = planner.readSession(r.sid);
  assert.strictEqual(s.messages.length, 2); // user + assistant
  return r.sid;
});

test('chat：多轮历史携带（第二轮 prompt 含第一轮问答）', async () => {
  const c1 = await planner.chat({ message: '第一问', runAgentFn: mockRun('第一答') });
  let seen = '';
  await planner.chat({ sid: c1.sid, message: '第二问', runAgentFn: mockRun('第二答', { assert: (a, p) => { seen = p; } }) });
  assert.ok(seen.includes('第一问') && seen.includes('第一答') && seen.includes('第二问'));
});

test('chat：内核报错回滚（失败消息不污染历史）', async () => {
  const c1 = await planner.chat({ message: '正常', runAgentFn: mockRun('ok') });
  const before = planner.readSession(c1.sid).messages.length;
  const bad = (a, p, onChunk) => { onChunk({ content: '', done: true, error: '内核崩了' }); return null; };
  const r = await planner.chat({ sid: c1.sid, message: '会失败', runAgentFn: bad });
  assert.ok(r.error.includes('内核崩了'));
  assert.strictEqual(planner.readSession(c1.sid).messages.length, before);
});

test('chat：超时报错', async () => {
  const never = () => null; // 永不回调 done
  const r = await planner.chat({ message: 'x', runAgentFn: never, timeoutMs: 30 });
  assert.ok(r.error.includes('超时'));
});

test('会话轮次上限裁剪（保留最近 ROUNDS_MAX 条）', async () => {
  const c = planner.createSession();
  for (let i = 0; i < planner.ROUNDS_MAX + 10; i++) {
    c.messages.push({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` });
  }
  planner.writeSession = planner.writeSession; // no-op 防 lint 困惑
  // 直接调用内部路径：走 chat 会触发内核；这里手动验证 writeSession 裁剪
  const s = planner.readSession(c.sid) || c;
  s.messages.push({ role: 'user', content: '触发写入' });
  require('fs').writeFileSync; // keep require
  // 用公开 chat 写入一次触发裁剪
  await planner.chat({ sid: c.sid, message: '裁剪触发', runAgentFn: mockRun('ok') });
  const after = planner.readSession(c.sid);
  assert.ok(after.messages.length <= planner.ROUNDS_MAX);
  assert.ok(after.messages.some(m => m.content === '裁剪触发'));
});

test('plan：代码块容错解析 + 生成摘要落盘', async () => {
  const c1 = await planner.chat({ message: '做官网', runAgentFn: mockRun('好') });
  const planText = '设计如下：\n```json\n' + JSON.stringify(TEAM) + '\n```\n完毕';
  const r = await planner.plan({ sid: c1.sid, runAgentFn: mockRun(planText) });
  assert.strictEqual(r.plan.length, 3);
  assert.strictEqual(r.plan[0].title, '设计稿');
  assert.strictEqual(r.plan[1].mode, 'continue');
  assert.deepStrictEqual(r.plan[1].deps, [1]);
  const s = planner.readSession(c1.sid);
  assert.ok(s.messages.some(m => m.content.includes('已生成 3 个任务'))); // 摘要入史，续聊可引用
});

test('plan：会话不存在 / 空会话 / 解析失败 / 数量不足', async () => {
  assert.ok((await planner.plan({ sid: 'pl-nope' })).error.includes('不存在'));
  const empty = planner.createSession();
  assert.ok((await planner.plan({ sid: empty.sid })).error.includes('会话为空'));
  const c1 = await planner.chat({ message: '做官网', runAgentFn: mockRun('好') });
  const bad = await planner.plan({ sid: c1.sid, runAgentFn: mockRun('我拒绝生成 JSON') });
  assert.ok(bad.error.includes('无法解析'));
  const one = await planner.plan({ sid: c1.sid, runAgentFn: mockRun(JSON.stringify([TEAM[0]])) });
  assert.ok(one.error.includes('至少需要'));
});

test('cleanPlan：mode 白名单 / continue 无链归 new / deps 清洗 / 数量截断', () => {
  const out = planner.cleanPlan([
    { title: 'A', content: 'a', mode: 'weird', deps: [1] },        // 非法 mode 归 new；deps 引用自身(1)被清 → new 无链
    { title: 'B', content: 'b', mode: 'continue', deps: [] },       // continue 无链归 new
    { title: '', content: '长'.repeat(9000), mode: 'new', deps: [2, 2, 99, -1, 0] }, // 空标题补齐；content 截断；deps 去重/悬空
    { title: 'D', content: 'd', mode: 'parallel', deps: [3] },      // deps=[3] 合法（引用第 3 项）
    { title: 'E', content: 'e', mode: 'new', deps: [] },
    { title: 'F', content: 'f', mode: 'new', deps: [] },
    { title: 'G', content: 'g', mode: 'new', deps: [] },
    { title: 'H', content: 'h', mode: 'new', deps: [] },
    { title: 'I', content: 'i', mode: 'new', deps: [] },
    { title: 'J', content: 'j', mode: 'new', deps: [] },
    { title: 'K', content: 'k', mode: 'new', deps: [] },
    { title: 'L', content: 'l', mode: 'new', deps: [] },
    { title: 'M', content: 'm', mode: 'new', deps: [] }
  ]);
  assert.strictEqual(out.length, planner.PLAN_MAX); // 13 项截断为 12
  assert.strictEqual(out[0].mode, 'new');           // 非法 mode + 自引用 deps 清空
  assert.strictEqual(out[1].mode, 'new');           // continue 无链退化
  assert.ok(out[2].title.length > 0);               // 空标题补齐
  assert.strictEqual(out[2].content.length, 8000);  // content 截断
  assert.deepStrictEqual(out[2].deps, [2]);         // 去重(2,2)保一个；99/-1/0 悬空清除
  assert.deepStrictEqual(out[3].deps, [3]);         // 引用第 3 项合法
  assert.deepStrictEqual(planner.cleanPlan('not-array'), []);
});

test('会话删除与最近会话', async () => {
  const c = await planner.chat({ message: '找最新的', runAgentFn: mockRun('ok') });
  assert.strictEqual(planner.latestSession().sid, c.sid);
  assert.strictEqual(planner.deleteSession(c.sid), true);
  assert.strictEqual(planner.readSession(c.sid), null);
  assert.strictEqual(planner.deleteSession('../evil'), false); // 非法 sid 拒绝
});

test('会话文件损坏：读取降级 + 只读保护防覆盖', () => {
  const s = planner.createSession();
  // 模拟进程中断留下的半截文件
  require('fs').writeFileSync(path.join(planner.PLANNER_DIR, s.sid + '.json'), '{"sid":"pl-broken","messages":[{"role":"u');
  // 读取：损坏自动备份并降级为 null（不抛错）
  assert.strictEqual(planner.readSession(s.sid), null);
  // 写入：safejson 只读保护，拒绝覆盖写（防止冲掉备份现场）
  assert.throws(() => planner.writeSession({ sid: s.sid, messages: [{ role: 'user', content: 'x' }] }));
  // 现场已备份为 .corrupt-*
  const backups = require('fs').readdirSync(planner.PLANNER_DIR).filter(f => f.startsWith(s.sid + '.json.corrupt-'));
  assert.strictEqual(backups.length, 1);
});

test('pruneStale：过期会话清理', async () => {
  const c = await planner.chat({ message: '旧的', runAgentFn: mockRun('ok') });
  const f = path.join(planner.PLANNER_DIR, `${c.sid}.json`);
  const old = new Date(Date.now() - 20 * 86400000); // 20 天前
  fs.utimesSync(f, old, old);
  const n = planner.pruneStale(15);
  assert.ok(n >= 1);
  assert.strictEqual(planner.readSession(c.sid), null);
});
