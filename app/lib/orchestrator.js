// 调度引擎：
// 1) 未点名 → 管家：先向用户交付简洁工作计划 → 按阶段（外层串行/内层并行）下发子智能体
//    → 验收（不合格则把要求+完善建议返回相应子智能体返工，循环至合格或达轮数上限）→ 汇总交付
// 2) @点名 → 按点名顺序串行流水线
// 3) 任务队列 → 每个任务一次完整管家调度（任务会话独立）
// 上下文规则：子智能体的正式产出作为「工作背景」传给后续智能体；
// 调度过程（规划卡片/阶段提示/验收意见）只展示在界面上，不进入上下文。
const { runAgent } = require('./agent');

const CTX_PER_OUTPUT = 4000;  // 单份产出作为背景的截断长度
const CTX_TOTAL = 12000;      // 背景累计截断长度
const PARALLEL_CAP = 3;       // 阶段内并行进程上限
const MAX_REWORK = Number(process.env.AGENTS_CHAT_MAX_VERIFY) > 0
  ? Number(process.env.AGENTS_CHAT_MAX_VERIFY) : 2; // 验收不通过时最大返工轮数

// ---------- 基础：运行单个 agent 一轮，流式回调 ----------
// 错误绝不静默：出错时把错误文本作为消息流入聊天流，用户必须能看到
function runAgentOnce(agent, prompt, emit, phase, role, taskId) {
  return new Promise((resolve) => {
    let output = '';
    let error = undefined;
    emit({ type: 'stage', phase, role, agentId: agent.id, agentName: agent.name, taskId: taskId || '' });
    runAgent(agent, prompt, (chunk) => {
      if (chunk.content) {
        output += chunk.content;
        emit({ type: 'text', content: chunk.content, phase, role, agentId: agent.id, agentName: agent.name, taskId: taskId || '' });
      }
      if (chunk.done) {
        if (chunk.error) {
          error = chunk.error;
          emit({ type: 'text', content: `\n[执行出错]\n${chunk.error}\n`, phase, role, agentId: agent.id, agentName: agent.name, taskId: taskId || '' });
        }
        resolve({ output, error });
      }
    });
  });
}

// ---------- 上下文传递：前序智能体产出 → 工作背景 ----------
function buildContext(results) {
  const parts = [];
  let total = 0;
  for (const r of results.slice().reverse()) {
    if (!r.output && !r.error) continue;
    const body = r.output || `（执行失败：${r.error}）`;
    const cut = body.length > CTX_PER_OUTPUT ? body.slice(0, CTX_PER_OUTPUT) + '…（截断）' : body;
    total += cut.length;
    if (total > CTX_TOTAL) break;
    parts.unshift(`【${r.agent.name} 的产出】\n${cut}`);
  }
  return parts.join('\n\n');
}

function appendWorkContext(prompt, results, history) {
  let p = prompt;
  const ctx = buildContext(results);
  if (ctx) p += `\n\n【工作背景：前序智能体的产出（供参考，避免重复劳动）】\n${ctx}`;
  if (history) p += `\n\n【会话背景（本会话此前的对话）】\n${history}`;
  return p;
}

// ---------- JSON 提取/引用解析 ----------
function extractPlanJSON(text) {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) {
    try { return JSON.parse(fence[1].trim()); } catch { /* 尝试裸 JSON */ }
  }
  const s = text.indexOf('{');
  const e = text.lastIndexOf('}');
  if (s >= 0 && e > s) {
    try { return JSON.parse(text.slice(s, e + 1)); } catch { /* 非法 */ }
  }
  return null;
}

function planThought(text) {
  return text.replace(/```[\s\S]*?```/g, '').trim();
}

// 智能体引用解析：兼容多种写法
// 「工程师」名称 / 「oc-2」ID / 「工程师（oc-2）」组合 / @前缀 / 含引号
function resolveAgentRef(ref, agents) {
  if (typeof ref !== 'string') return null;
  let t = ref.trim().replace(/^["'「【（(\s]+|["'」】）)\s]+$/g, '');
  if (t.startsWith('@')) t = t.slice(1).trim();
  if (!t) return null;
  // 1) 精确匹配名称或 ID
  let hit = agents.find(a => a.id === t) || agents.find(a => a.name === t);
  if (hit) return hit;
  // 2) 「名称（ID）」组合：拆出括号内 ID 与括号外名称分别试
  const m = t.match(/^(.+?)[（(]\s*([^（）()]+?)\s*[）)]$/);
  if (m) {
    hit = agents.find(a => a.id === m[2].trim()) || agents.find(a => a.name === m[1].trim());
    if (hit) return hit;
  }
  // 3) 名称包含匹配（如「资深工程师」→「工程师」）
  hit = agents.find(a => a.name && t.includes(a.name));
  if (hit) return hit;
  return null;
}

// 同一阶段内若某步骤指令引用了同组其他智能体（存在依赖），拆到后续阶段串行
function splitByDependency(groups) {
  const out = [];
  for (const group of groups) {
    let cur = group;
    while (cur.length > 1) {
      const moved = cur.filter(s => cur.some(o => o !== s && s.instruction.includes(o.agentName)));
      const keep = cur.filter(s => !moved.includes(s));
      if (!moved.length || !keep.length) break; // 无依赖或循环引用，保持原样
      out.push(keep);
      cur = moved;
    }
    out.push(cur);
  }
  return out;
}

// 校验并归一化为 [{agentId, agentName, instruction}] 的阶段数组
function normalizePhases(raw, agents, warn) {
  const phases = [];
  if (!raw || !Array.isArray(raw.steps)) return phases;
  for (const group of raw.steps) {
    const list = Array.isArray(group) ? group : [group];
    const steps = [];
    for (const s of list) {
      if (!s || typeof s !== 'object') continue;
      const agent = resolveAgentRef(s.agent, agents);
      if (!agent) { warn(`调度方案中引用了未知智能体（${JSON.stringify(s.agent)}），已忽略该项`); continue; }
      if (!s.instruction || !String(s.instruction).trim()) continue;
      steps.push({ agentId: agent.id, agentName: agent.name, instruction: String(s.instruction).slice(0, 3000) });
    }
    if (steps.length) phases.push(steps);
  }
  return splitByDependency(phases);
}

function planToText({ thought, phases }) {
  const lines = [];
  if (thought) lines.push(`调度思路：${thought}`);
  phases.forEach((g, i) => {
    lines.push(`阶段 ${i + 1}（${g.length > 1 ? g.length + ' 项并行' : '单执行'}）：`);
    for (const s of g) lines.push(`  - ${s.agentName}：${s.instruction}`);
  });
  return lines.join('\n');
}

// ---------- 验收结论解析 ----------
// 结构化：{"verdict":"ACCEPT"} 或 {"verdict":"REJECT","issues":[{"agent":"x","requirement":"…","suggestion":"…"}]}
// 兜底：[ACCEPT]/[REJECT] 前缀标记；无法判定视为通过
function parseVerdict(text, agents, warn) {
  const j = extractPlanJSON(text);
  if (j && typeof j === 'object' && (j.verdict || Array.isArray(j.issues))) {
    const rawIssues = Array.isArray(j.issues) ? j.issues : [];
    const issues = [];
    for (const it of rawIssues) {
      if (!it || typeof it !== 'object') continue;
      const agent = resolveAgentRef(it.agent, agents);
      if (!agent) { warn(`验收意见引用了未知智能体（${JSON.stringify(it.agent)}），已忽略`); continue; }
      issues.push({
        agentId: agent.id, agentName: agent.name,
        requirement: String(it.requirement || '').slice(0, 2000),
        suggestion: String(it.suggestion || '').slice(0, 3000)
      });
    }
    const accepted = String(j.verdict || '').toUpperCase() === 'ACCEPT' || (String(j.verdict || '').toUpperCase() !== 'REJECT' && issues.length === 0 && rawIssues.length === 0);
    return { accepted, issues: accepted ? [] : issues };
  }
  if (/^\s*\[ACCEPT\]/m.test(text)) return { accepted: true, issues: [] };
  if (/^\s*\[REJECT\]/m.test(text)) return { accepted: false, issues: [] };
  return { accepted: true, issues: [] };
}

// ---------- 管家调度主流程 ----------
async function runButler(butler, subAgents, message, opts, emit, onMessage) {
  const taskId = opts.taskId || '';
  const warnings = [];
  const warn = (w) => { warnings.push(w); emit({ type: 'notice', content: `⚠ ${w}`, taskId }); };

  const roster = subAgents.length
    ? subAgents.map(a => `- ${a.name}（${a.id}）：${a.desc || String(a.systemPrompt || '').slice(0, 60) || '（无描述）'}`).join('\n')
    : '（当前没有任何子智能体，可在右上角「智能体配置」中添加）';

  // ---- 1. 规划：先向用户简洁交付工作计划，再输出结构化调度方案 ----
  let planPrompt = `你是「管家」调度智能体。请针对下面的用户需求制定调度方案。

【用户需求】
${message}

【可用子智能体名单】
${roster}

调度规则：
- 只能使用名单内的智能体，不得虚构；若缺少所需职能，可在回复中提示用户添加
- 严格区分串行与并行：只有多项工作【互不依赖、互不需要参考彼此产出】才可放同一阶段并行；只要 B 需要基于/参考 A 的结果，B 必须放在 A 之后的后续阶段串行执行
- 例如「先方案设计→再编码实现→最后审查」必须拆为多个串行阶段，严禁合并进同一阶段
- 你只负责规划与调度，自己不动手干活：不要调用任何工具、不要写代码或文件，只输出计划文本与 JSON
`;
  if (opts.history) planPrompt += `\n【会话背景（本会话此前的对话）】\n${opts.history}\n`;
  planPrompt += `
输出格式（严格遵守）：
1. 先用简洁的中文（2~4 句）向用户说明你的工作计划与安排（这是给用户看的，会直接展示）
2. 再输出一个 JSON 代码块：
{"steps": [[{"agent": "智能体名称", "instruction": "给它的具体工作指令"}], ...]}
外层数组 = 串行阶段（按顺序执行）；内层数组 = 该阶段并行执行的多个智能体。
agent 字段只填智能体名称或 ID 之一（如 "工程师" 或 "oc-2"，严禁写 "工程师（oc-2）" 这种组合形式）。
若是闲聊、简单问答、需要向用户澄清，或无需任何子智能体参与，steps 输出 []，并在第 1 部分直接给出回答。`;

  // 规划阶段文本不直接流式展示（避免计划展示两次）：内部缓冲，解析后只展示一次
  const planEmit = (e) => { if (e.type === 'text') return; emit(e); };
  let planRes = await runAgentOnce(butler, planPrompt, planEmit, 'plan', 'butler', taskId);
  let rawPlan = planRes.output ? extractPlanJSON(planRes.output) : null;
  let phases = planRes.output ? normalizePhases(rawPlan, subAgents, warn) : [];

  // 解析失败或引用全部无效（原始 steps 非空）→ 纠正提示重试一次，避免零阶段直接跳汇总
  const rawHadSteps = !!(rawPlan && Array.isArray(rawPlan.steps) && rawPlan.steps.length > 0);
  if (planRes.output && phases.length === 0 && (rawHadSteps || !rawPlan) && subAgents.length > 0) {
    emit({ type: 'notice', content: '调度方案未能解析，正在让管家重新输出…', taskId });
    const retryPrompt = `你上次的输出无法解析为有效调度方案（常见原因：agent 字段写法不对、引用了名单外的智能体、或没输出 JSON）。
可用智能体：${subAgents.map(a => a.name).join(' / ')}

【用户需求】
${message}

请重新输出：先用 1~3 句中文说明计划，再输出 JSON 代码块：
{"steps": [[{"agent": "智能体名称", "instruction": "具体指令"}]]}
若确实无需子智能体（闲聊/澄清），输出 {"steps": []} 并直接回答。`;
    const retryRes = await runAgentOnce(butler, retryPrompt, planEmit, 'plan', 'butler', taskId);
    if (retryRes.output) {
      const raw2 = extractPlanJSON(retryRes.output);
      const phases2 = normalizePhases(raw2, subAgents, warn);
      if (phases2.length > 0 || (raw2 && Array.isArray(raw2.steps) && raw2.steps.length === 0)) {
        planRes = retryRes;
        phases = phases2;
      }
    }
  }

  if (!planRes.output) {
    const errText = planRes.error || '（管家规划无输出）';
    onMessage({ role: 'assistant', agentId: butler.id, agentName: butler.name, actor: 'butler', phase: 'plan', content: errText });
    return { ok: false, finalText: errText };
  }

  // 无需调度：规划输出中的说明文字即最终回答（一次性展示，含被缓冲的说明）
  if (phases.length === 0) {
    const answer = planThought(planRes.output) || planRes.output;
    emit({ type: 'text', content: answer, phase: 'report', role: 'butler', agentId: butler.id, agentName: butler.name, taskId });
    onMessage({ role: 'assistant', agentId: butler.id, agentName: butler.name, actor: 'butler', phase: 'report', content: answer.slice(0, 20000) });
    return { ok: true, finalText: answer };
  }

  // 推送并持久化调度方案（仅界面展示，不进入后续上下文）
  const planMsg = { thought: planThought(planRes.output), phases };
  emit({ type: 'plan', agentId: butler.id, agentName: butler.name, taskId, thought: planMsg.thought, phases: planMsg.phases });
  onMessage({ role: 'assistant', agentId: butler.id, agentName: butler.name, actor: 'butler', phase: 'plan', content: planToText(planMsg), plan: planMsg });

  // results 按 agent 维度保存最新产出
  const results = [];
  const setResult = (agent, output, error, instruction) => {
    const i = results.findIndex(r => r.agent.id === agent.id);
    const entry = { agent, output, error, instruction };
    if (i >= 0) results[i] = entry; else results.push(entry);
  };

  // ---- 2. 执行各阶段（阶段内并行，分批限流） ----
  for (let i = 0; i < phases.length; i++) {
    const group = phases[i];
    emit({ type: 'phase', index: i + 1, total: phases.length, parallel: group.length > 1, names: group.map(s => s.agentName).join('、'), taskId });
    for (let j = 0; j < group.length; j += PARALLEL_CAP) {
      const batch = group.slice(j, j + PARALLEL_CAP);
      await Promise.all(batch.map(step => (async () => {
        const agent = subAgents.find(a => a.id === step.agentId);
        let p = `【来自管家的指派】\n${step.instruction}\n\n【用户原始需求】\n${message}`;
        p = appendWorkContext(p, results, opts.history);
        p += '\n\n请输出你的正式结果。';
        const res = await runAgentOnce(agent, p, emit, 'work', 'worker', taskId);
        setResult(agent, res.output, res.error, step.instruction);
        onMessage({ role: 'assistant', agentId: agent.id, agentName: agent.name, actor: 'assistant', phase: 'work', content: (res.output || `[执行出错] ${res.error}`).slice(0, 20000) });
      })()));
    }
  }

  // ---- 3. 验收 → 返工循环 ----
  let accepted = false;
  let reworks = 0;
  while (true) {
    const round = reworks + 1;
    const workText = results.map(r =>
      `【${r.agent.name} 的任务】\n${r.instruction}\n【${r.agent.name} 的产出】\n${(r.output || `（执行失败：${r.error}）`).slice(0, CTX_PER_OUTPUT)}`
    ).join('\n\n');

    const verifyPrompt = `你是「管家」。第 ${round} 轮验收：请核对各子智能体的工作成果是否满足用户需求。

【用户原始需求】
${message}

【各智能体的任务与产出】
${workText.slice(0, 24000)}
${reworks > 0 ? '\n（注：此前已反馈过问题，请重点核对是否已按建议完善）\n' : ''}
输出格式（严格遵守）：
1. 先用 1~2 句中文向用户说明验收结论
2. 再输出 JSON：全部合格输出 {"verdict":"ACCEPT"}；存在问题输出 {"verdict":"REJECT","issues":[{"agent":"智能体名称","requirement":"必须满足的要求","suggestion":"具体完善建议"}]}
只有确有问题才 REJECT；issues 只列需要返工的智能体，不要把合格的也列进去。`;

    const verifyRes = await runAgentOnce(butler, verifyPrompt, emit, 'review', 'butler', taskId);
    onMessage({ role: 'assistant', agentId: butler.id, agentName: butler.name, actor: 'butler', phase: 'review', content: (verifyRes.output || `[验收出错] ${verifyRes.error}`).slice(0, 20000) });
    if (!verifyRes.output) break; // 验收失败无法判定，直接交付

    const verdict = parseVerdict(verifyRes.output, subAgents, warn);
    if (verdict.accepted) {
      accepted = true;
      emit({ type: 'verify', round, accepted: true, taskId });
      break;
    }
    if (reworks >= MAX_REWORK) {
      emit({ type: 'verify', round, accepted: false, taskId, note: `已达最大返工轮数（${MAX_REWORK}），交付当前版本` });
      break;
    }
    reworks++;

    // 返工名单：有结构化 issues 用之；否则全部产出者带整段验收意见返工
    let reworkList;
    if (verdict.issues.length > 0) {
      reworkList = verdict.issues.map(it => {
        const r = results.find(x => x.agent.id === it.agentId);
        return r ? { ...it, instruction: r.instruction } : null;
      }).filter(Boolean);
    } else {
      reworkList = results.filter(r => r.output || r.error).map(r => ({
        agentId: r.agent.id, agentName: r.agent.name, requirement: '按验收意见完善',
        suggestion: planThought(verifyRes.output).slice(0, 3000), instruction: r.instruction
      }));
    }
    if (reworkList.length === 0) break;

    emit({
      type: 'verify', round, accepted: false, taskId,
      note: `验收未通过，第 ${reworks} 轮返工：${reworkList.map(x => x.agentName).join('、')}`
    });
    for (const it of reworkList) {
      const r = results.find(x => x.agent.id === it.agentId);
      let p = `【来自管家的返工要求】${it.requirement}\n【完善建议】${it.suggestion}\n\n【你上次的产出】\n${(r.output || `（执行失败：${r.error}）`).slice(0, CTX_PER_OUTPUT)}\n\n【你上次的任务】\n${it.instruction}\n\n【用户原始需求】\n${message}`;
      const ctxOthers = buildContext(results.filter(x => x.agent.id !== it.agentId));
      if (ctxOthers) p += `\n\n【工作背景：其他智能体的产出】\n${ctxOthers}`;
      p += '\n\n请在原有产出基础上完善，不要从零重复劳动。';
      const res = await runAgentOnce(r.agent, p, emit, 'work', 'worker', taskId);
      setResult(r.agent, res.output || r.output, res.output ? undefined : (res.error || r.error), it.instruction);
      onMessage({ role: 'assistant', agentId: r.agent.id, agentName: r.agent.name, actor: 'assistant', phase: 'work', content: (res.output || `[返工出错] ${res.error}`).slice(0, 20000) });
    }
  }

  // ---- 4. 汇总：面向用户的正式回答 ----
  const outs = results.map(r => `【${r.agent.name}】\n${r.output || `（执行失败：${r.error}）`}`).join('\n\n');
  const sumPrompt = `你是「管家」。各子智能体已完成工作${accepted ? `（验收通过，共 ${reworks} 轮返工）` : `（经 ${reworks} 轮返工仍未完全达标，请如实向用户说明残留问题）`}。请向用户输出最终正式回答：综合以下产出直接回答用户需求，结构清晰、结论明确。不要输出 JSON，用中文。

【用户原始需求】
${message}

【各智能体产出】
${outs.slice(0, 24000)}`;
  const sumRes = await runAgentOnce(butler, sumPrompt, emit, 'report', 'butler', taskId);
  const finalText = sumRes.output || outs || sumRes.error || '';
  onMessage({ role: 'assistant', agentId: butler.id, agentName: butler.name, actor: 'butler', phase: 'report', content: (finalText || '（无输出）').slice(0, 20000) });
  return { ok: !sumRes.error || results.some(r => r.output), finalText };
}

// ---------- @点名：按点名顺序串行流水线（产出作为后续背景） ----------
async function runMentioned(mentionAgents, message, opts, emit, onMessage) {
  const taskId = opts.taskId || '';
  const results = [];
  for (const agent of mentionAgents) {
    const role = agent.id === 'butler' ? 'butler' : 'worker';
    const p = appendWorkContext(message, results, opts.history);
    const res = await runAgentOnce(agent, p, emit, 'work', role, taskId);
    results.push({ agent, output: res.output, error: res.error });
    if (res.output || res.error) {
      onMessage({ role: 'assistant', agentId: agent.id, agentName: agent.name, actor: 'assistant', phase: 'work', content: (res.output || `[执行出错] ${res.error}`).slice(0, 20000) });
    }
  }
  return { ok: results.some(r => r.output), finalText: results.map(r => r.output).filter(Boolean).join('\n\n') };
}

// ---------- 任务队列：每个任务一次完整调度（独立会话） ----------
// 末尾 @子智能体 的任务由该智能体独立完成；未指派/@管家 则由管家调度
async function runTasks(tasks, butler, subAgents, opts, emit, onMessage, onTaskStart, onTaskDone) {
  for (const task of tasks) {
    const prompt = `请完成以下任务并给出结果：\n${task.title}${task.notes ? `\n\n补充说明：${task.notes}` : ''}`;
    // 先建历史背景（不含本任务的起始消息），再写入任务会话首条消息
    const history = opts.getHistory ? opts.getHistory(task.id) : '';
    if (onTaskStart) onTaskStart(task);
    // 该任务产生的全部消息都归入对应任务会话
    const persistTask = (m) => onMessage({ ...m, taskId: task.id });

    const assigned = opts.resolveAssign ? opts.resolveAssign(task) : null;
    let r;
    if (assigned && assigned.id !== butler.id) {
      // 指派子智能体：独立完成，无管家编排
      emit({ type: 'task_start', taskId: task.id, title: task.title, agentName: assigned.name });
      emit({ type: 'notice', content: `本任务由 @${assigned.name} 独立完成（无管家调度）`, taskId: task.id });
      r = await runMentioned([assigned], prompt, { taskId: task.id, history }, emit, persistTask);
    } else {
      emit({ type: 'task_start', taskId: task.id, title: task.title, agentName: butler.name });
      r = await runButler(butler, subAgents, prompt, { taskId: task.id, history }, emit, persistTask);
    }
    const resultText = (r.finalText || '').trim() || '执行失败';
    onTaskDone(task.id, { status: r.ok ? 'done' : 'failed', result: resultText.slice(0, 10000) });
    emit({ type: 'task_done', taskId: task.id, status: r.ok ? 'done' : 'failed', title: task.title });
  }
  emit({ type: 'all_done' });
}

module.exports = { runButler, runMentioned, runTasks };
