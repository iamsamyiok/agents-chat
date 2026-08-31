// AI 智能编排：卡牌控制台的聊天式任务编排（多轮对话澄清 + 生成结构化清单）
// 会话持久化于 <DATA>/planner/<sid>.json；内核调用复用 agent.runAgent（runAgentFn 可注入便于测试）
const fs = require('fs');
const path = require('path');
const agentMod = require('./agent');
const { extractJSONArray } = require('./teamgen');
const safejson = require('./safejson');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = process.env.AGENTS_CHAT_DATA || path.join(ROOT, '.data');
const PLANNER_DIR = path.join(DATA_DIR, 'planner');

const MSG_MAX = 4000;      // 单条消息长度上限
const ROUNDS_MAX = 80;     // messages 条数上限（约 40 轮），超出裁最旧
const PLAN_MIN = 2;
const PLAN_MAX = 12;
const CHAT_TIMEOUT_MS = Number(process.env.AGENTS_CHAT_PLANNER_CHAT_TIMEOUT_MS) > 0
  ? Number(process.env.AGENTS_CHAT_PLANNER_CHAT_TIMEOUT_MS) : 120000;
const PLAN_TIMEOUT_MS = Number(process.env.AGENTS_CHAT_PLANNER_PLAN_TIMEOUT_MS) > 0
  ? Number(process.env.AGENTS_CHAT_PLANNER_PLAN_TIMEOUT_MS) : 180000;

// 编排设计师人设：先澄清再拆解；任务模型对齐卡牌控制台（mode/deps/priority）
const PLANNER_SYSTEM = [
  '你是一位资深项目经理与任务编排设计师，帮助用户把目标拆解为可执行的多任务编排。',
  '',
  '【对话方式】',
  '1. 用户描述目标后，若关键信息缺失（做什么、技术栈/工具、范围边界、期望产出），先提出 1-3 个具体的澄清问题，不要凭空编造',
  '2. 信息足够时，简要确认你的理解（一两句话），并提示用户可以点「生成编排」按钮产出任务清单',
  '3. 回复简洁务实，不输出与编排无关的长篇内容；语言跟随用户语言',
  '',
  '【任务模型（生成清单时遵守，对话中不必展开）】',
  '- 每个任务：title（一句话标题）、content（完整可独立执行的任务描述，包含必要上下文，不写「继续上面」这类脱离清单后无法理解的话）',
  '- mode：new=新进程独立执行 / continue=同会话续聊（同一件事分步骤、需要记住前一步成果时用，并依赖前一步）/ parallel=并行独立进程（互不依赖可同时跑）',
  '- deps：依赖任务的序号数组（1 起始），任务只能等依赖完成后执行',
  '- 拆解原则：先准备后执行再检查验收；有依赖关系的按顺序；独立可并行的标记 parallel；任务粒度适中，总数 2-12 个'
].join('\n');

// ---------- 会话存取 ----------

function ensureDir() {
  try { fs.mkdirSync(PLANNER_DIR, { recursive: true }); } catch { /* ignore */ }
}

function sidValid(sid) {
  return /^pl-[a-z0-9-]+$/i.test(String(sid || ''));
}

function sessionPath(sid) {
  return path.join(PLANNER_DIR, `${sid}.json`);
}

function readSession(sid) {
  if (!sidValid(sid)) return null;
  const s = safejson.readJson(sessionPath(sid), null); // 损坏自动备份 .corrupt-* 并进入只读保护
  if (!s || !Array.isArray(s.messages)) return null;
  return s;
}

function writeSession(s) {
  ensureDir();
  // 轮次上限：超出裁最旧（保留最近 ROUNDS_MAX 条）
  if (s.messages.length > ROUNDS_MAX) s.messages = s.messages.slice(-ROUNDS_MAX);
  s.updatedAt = new Date().toISOString();
  safejson.writeJson(sessionPath(s.sid), s); // tmp+rename 原子写，进程中断不留半截文件
}

function createSession() {
  const sid = `pl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const s = { sid, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), messages: [] };
  writeSession(s);
  return s;
}

function latestSession() {
  ensureDir();
  let best = null;
  for (const f of fs.readdirSync(PLANNER_DIR)) {
    if (!f.endsWith('.json')) continue;
    const s = readSession(f.slice(0, -5));
    if (s && (!best || s.updatedAt > best.updatedAt)) best = s;
  }
  return best;
}

function deleteSession(sid) {
  if (!sidValid(sid)) return false;
  try { fs.unlinkSync(sessionPath(sid)); return true; } catch { return false; }
}

// 过期清理（随每日 prune 调用）：删除 updatedAt 早于 days 天前的会话
function pruneStale(days) {
  const keep = (Number(days) || 15) * 86400000;
  const cut = Date.now() - keep;
  let n = 0;
  try {
    ensureDir();
    for (const f of fs.readdirSync(PLANNER_DIR)) {
      if (!f.endsWith('.json')) continue;
      const p = path.join(PLANNER_DIR, f);
      try {
        const st = fs.statSync(p);
        if (st.mtimeMs < cut) { fs.unlinkSync(p); n++; }
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return n;
}

// ---------- 内核调用（与 teamgen.suggestTeam 同模式：超时 stopScope + done 回调聚合） ----------

function runOnce(prompt, timeout, scope) {
  return new Promise((resolve) => {
    let settled = false;
    let content = '';
    let runError = '';
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      runError = `生成超时（${Math.round(timeout / 1000)} 秒），请稍后重试`;
      try { agentMod.stopScope(scope); } catch { /* ignore */ }
      resolve({ content, error: runError });
    }, timeout);
    try {
      agentMod.runAgent(
        { id: scope, name: scope, model: '', behavior: 'echo', systemPrompt: '' },
        prompt,
        (chunk) => {
          if (chunk && chunk.content) content += chunk.content;
          if (chunk && chunk.error) runError = runError || String(chunk.error);
          if (chunk && chunk.done && !settled) { settled = true; clearTimeout(timer); resolve({ content, error: runError }); }
        },
        scope
      );
    } catch (e) {
      if (!settled) { settled = true; clearTimeout(timer); resolve({ content: '', error: `调用内核失败：${e.message}` }); }
    }
  });
}

function historyText(messages) {
  return messages.map(m => `${m.role === 'user' ? '用户' : '助手'}：${m.content}`).join('\n\n');
}

// 多轮对话：追加用户消息 → 内核回复（携带 system + 全部历史）→ 落盘
async function chat({ sid, message, runAgentFn, timeoutMs }) {
  const s = sid ? readSession(sid) : null;
  const sess = s || createSession();
  if (runAgentFn) {
    // 测试注入：替换 agentMod.runAgent
    const orig = agentMod.runAgent;
    agentMod.runAgent = runAgentFn;
    try { return await doChat(sess, message, timeoutMs); }
    finally { agentMod.runAgent = orig; }
  }
  return doChat(sess, message, timeoutMs);
}

async function doChat(sess, message, timeoutMs) {
  const text = String(message || '').trim().slice(0, MSG_MAX);
  const timeout = Number(timeoutMs) > 0 ? Number(timeoutMs) : CHAT_TIMEOUT_MS;
  sess.messages.push({ role: 'user', content: text });
  const prompt = `${PLANNER_SYSTEM}\n\n【对话记录】\n${historyText(sess.messages)}\n\n请以助手身份回复最后一条用户消息。`;
  const r = await runOnce(prompt, timeout, `planner-chat-${sess.sid}`); // scope 带会话 id：跨会话并发的超时停止互不误杀
  if (r.error) {
    sess.messages.pop(); // 失败不污染历史（用户可重发）
    return { sid: sess.sid, reply: '', error: r.error };
  }
  const reply = String(r.content || '').trim().slice(0, MSG_MAX * 2);
  sess.messages.push({ role: 'assistant', content: reply });
  writeSession(sess);
  return { sid: sess.sid, reply };
}

// 生成编排清单：以历史为上下文追加生成指令 → 容错解析 → cleanPlan 清洗
async function plan({ sid, runAgentFn, timeoutMs }) {
  const sess = readSession(sid);
  if (!sess) return { error: '编排会话不存在，请先发送一条消息' };
  if (!sess.messages.some(m => m.role === 'user')) return { error: '会话为空，请先描述你的目标' };
  if (runAgentFn) {
    const orig = agentMod.runAgent;
    agentMod.runAgent = runAgentFn;
    try { return await doPlan(sess, timeoutMs); }
    finally { agentMod.runAgent = orig; }
  }
  return doPlan(sess, timeoutMs);
}

async function doPlan(sess, timeoutMs) {
  const timeout = Number(timeoutMs) > 0 ? Number(timeoutMs) : PLAN_TIMEOUT_MS;
  const instruct = [
    '基于以上对话内容，生成最终任务编排清单。',
    '只输出一个 JSON 数组（2-12 项），不要输出其他文字或代码块标记。每项字段：',
    '- title：一句话标题（30 字内）',
    '- content：完整可独立执行的任务描述（包含必要上下文与期望产出）',
    '- mode："new" | "continue" | "parallel"',
    '- deps：依赖任务序号数组（1 起始，引用清单内其他任务，不含自身）；mode 为 continue 时依赖其续聊的前一步',
    '同会话续聊（continue）用于同一件事分步推进；互不依赖的可并行任务用 parallel 且 deps 为空。'
  ].join('\n');
  const prompt = `${PLANNER_SYSTEM}\n\n【对话记录】\n${historyText(sess.messages)}\n\n【当前指令】\n${instruct}`;
  const r = await runOnce(prompt, timeout, `planner-plan-${sess.sid}`); // scope 带会话 id：跨会话并发的超时停止互不误杀
  if (r.error) return { error: r.error };
  const parsed = extractJSONArray(r.content);
  if (!parsed) return { error: '生成结果无法解析为任务清单，请补充信息后重试' };
  const items = cleanPlan(parsed);
  if (items.length < PLAN_MIN) {
    return { error: `生成结果只有 ${items.length} 个任务，至少需要 ${PLAN_MIN} 个，请补充更多细节后重试` };
  }
  // 生成记录落盘（便于继续对话时 LLM 知道已产出过清单；只存摘要防膨胀）
  sess.messages.push({ role: 'user', content: '【生成编排清单】' });
  sess.messages.push({ role: 'assistant', content: `已生成 ${items.length} 个任务的编排清单：\n${items.map((t, i) => `${i + 1}. ${t.title}（${t.mode}${t.deps.length ? '，依赖 ' + t.deps.join('/') : ''}）`).join('\n')}\n如需调整请直接说明。` });
  writeSession(sess);
  return { plan: items };
}

// 清洗：字段归一 + deps 校验（1 起始序号、去自引用/悬空/重复）+ 数量截断
function cleanPlan(arr) {
  if (!Array.isArray(arr)) return [];
  const raw = arr.filter(x => x && typeof x === 'object');
  const len = Math.min(raw.length, PLAN_MAX);
  const items = [];
  for (let i = 0; i < len; i++) {
    const a = raw[i];
    let content = String(a.content || '').trim().slice(0, 8000);
    let title = String(a.title || '').trim().slice(0, 100);
    if (!title) title = content.slice(0, 40) || `任务${i + 1}`;
    let mode = String(a.mode || 'new').toLowerCase();
    if (!['new', 'continue', 'parallel'].includes(mode)) mode = 'new';
    let deps = Array.isArray(a.deps) ? a.deps : [];
    deps = [...new Set(deps.map(d => parseInt(d, 10)).filter(Number.isInteger))]
      .map(d => d - 1)                       // 转 0 起始
      .filter(d => d >= 0 && d < len && d !== i) // 去悬空与自引用
      .sort((x, y) => x - y)
      .map(d => d + 1);                      // 回 1 起始
    // continue 无有效链首（依赖为空）时退化为 new：续聊必须有前序会话
    if (mode === 'continue' && deps.length === 0) mode = 'new';
    if (!content) content = title;
    items.push({ title, content, mode, deps });
  }
  return items;
}

module.exports = {
  PLANNER_DIR, MSG_MAX, ROUNDS_MAX, PLAN_MIN, PLAN_MAX,
  PLANNER_SYSTEM,
  readSession, createSession, latestSession, deleteSession, pruneStale,
  runOnce, chat, plan, cleanPlan
};
