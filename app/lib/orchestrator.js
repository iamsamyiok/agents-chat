// 调度引擎：
// 1) 未点名 → 管家：先向用户交付简洁工作计划 → 按阶段（外层串行/内层并行）下发子智能体
//    → 验收（不合格则把要求+完善建议返回相应子智能体返工，循环至合格或达轮数上限）→ 汇总交付
// 2) @点名 → 按点名顺序串行流水线
// 3) 任务队列 → 每个任务一次完整管家调度（任务会话独立）
// 上下文规则：子智能体的正式产出作为「工作背景」传给后续智能体；
// 调度过程（规划卡片/阶段提示/验收意见）只展示在界面上，不进入上下文。
const { runAgent, resolveCwd } = require('./agent');
const memory = require('./memory');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile, exec } = require('child_process');

const CTX_PER_OUTPUT = 4000;  // 单份产出作为背景的截断长度
const CTX_TOTAL = 12000;      // 背景累计截断长度
const PARALLEL_CAP = 3;       // 阶段内并行进程上限
const MAX_REWORK = Number(process.env.AGENTS_CHAT_MAX_VERIFY) > 0
  ? Number(process.env.AGENTS_CHAT_MAX_VERIFY) : 2; // 验收不通过时最大返工轮数

// ---------- 自动核查：验收前由系统本地执行的确定性检查（不依赖任何智能体自述） ----------
// 检查项：产出文件存在性/非空、产出中 JS 代码块语法（node --check）、JSON 代码块可解析、
//         占位符残留（TODO/此处省略等）、自定义验证命令（.env AGENTS_CHAT_VERIFY_CMD）
// 全部检查只读不写（临时文件除外），语法检查不执行代码；.env AGENTS_CHAT_AUTOVERIFY=0 可整体关闭
function nodeSyntaxCheck(code, tag) {
  return new Promise((resolve) => {
    try {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-'));
      const file = path.join(dir, `block.${tag || 'js'}`);
      fs.writeFileSync(file, code);
      execFile(process.execPath, ['--check', file], { timeout: 15000 }, (err, _so, se) => {
        try { fs.unlinkSync(file); fs.rmdirSync(dir); } catch { /* ignore */ }
        resolve({ pass: !err, note: err ? String(se || err.message).split('\n')[0].slice(0, 300) : '语法正确' });
      });
    } catch (e) {
      resolve({ pass: true, note: `检查器异常（跳过）：${String(e.message || e).slice(0, 120)}` });
    }
  });
}

function runVerifyCmd(cmd) {
  return new Promise((resolve) => {
    const timeoutMs = Number(process.env.AGENTS_CHAT_VERIFY_TIMEOUT_MS) > 0
      ? Number(process.env.AGENTS_CHAT_VERIFY_TIMEOUT_MS) : 120000;
    try {
      exec(cmd, { cwd: resolveCwd(), timeout: timeoutMs, maxBuffer: 512 * 1024, killSignal: 'SIGKILL' }, (err, so, se) => {
        const tail = String((so || '') + (se || '')).trim().slice(-1200);
        const code = err ? (err.code === undefined ? 1 : err.code) : 0;
        const killed = err && err.killed ? '（超时被终止）' : '';
        resolve({ pass: !err, note: `退出码 ${code}${killed}${tail ? `，输出末尾：\n${tail}` : '（无输出）'}` });
      });
    } catch (e) {
      resolve({ pass: true, note: `命令无法启动（跳过）：${String(e.message || e).slice(0, 120)}` });
    }
  });
}

// 从产出文本提取带语言标注的代码块
function codeBlocks(output) {
  const out = [];
  const re = /```([a-zA-Z0-9+#-]*)\r?\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(String(output || ''))) !== null) out.push({ lang: (m[1] || '').toLowerCase(), code: m[2] });
  return out;
}

const PLACEHOLDER_RE = /(此处省略|此处略|内容略|TODO[:：]?\s*待补|待补充[:：]?\s*$|«+\s*略\s*»+|\.{6,}省略)/;

async function runAutoChecks(results) {
  if (process.env.AGENTS_CHAT_AUTOVERIFY === '0') return null;
  const items = []; // {name, pass, note}
  const add = (name, pass, note) => items.push({ name, pass: !!pass, note: String(note).slice(0, 800) });

  for (const r of results) {
    const label = r.agent && r.agent.name;
    // 1) 产出文件
    if (r.outputPath) {
      try {
        const st = fs.statSync(r.outputPath);
        const content = st.size <= 2 * 1024 * 1024 ? fs.readFileSync(r.outputPath, 'utf8') : '';
        const lines = content ? content.split('\n').length : 0;
        add(`产出文件[${label}]`, st.size > 0, `${r.outputPath}（${st.size} 字节，${lines} 行）`);
      } catch (e) {
        add(`产出文件[${label}]`, false, `无法读取 ${r.outputPath}：${String(e.message || e).slice(0, 120)}`);
      }
    } else if (r.output) {
      add(`产出文件[${label}]`, true, '纯文本产出（无落盘文件，仅记录于会话）');
    }
    if (!r.output) continue;
    // 2) 代码块：JS 语法 + JSON 可解析（每份产出最多查 6 块，防大产出拖慢）
    const blocks = codeBlocks(r.output).slice(0, 6);
    let jsN = 0, jsonN = 0;
    for (const b of blocks) {
      if (['js', 'javascript', 'mjs', 'cjs', 'node'].includes(b.lang) && b.code.trim()) {
        jsN++;
        const c = await nodeSyntaxCheck(b.code, b.lang === 'mjs' ? 'mjs' : 'js');
        add(`JS 语法[${label}·第${jsN}块]`, c.pass, c.note);
      } else if (b.lang === 'json' && b.code.trim()) {
        jsonN++;
        try { JSON.parse(b.code); add(`JSON 校验[${label}·第${jsonN}块]`, true, '合法 JSON'); }
        catch (e) { add(`JSON 校验[${label}·第${jsonN}块]`, false, `解析失败：${String(e.message || e).slice(0, 200)}`); }
      }
    }
    // 3) 占位符残留（未完成的信号）
    const ph = String(r.output).match(PLACEHOLDER_RE);
    if (ph) add(`完整性[${label}]`, false, `产出中疑似存在未完成占位内容：「${ph[0]}」`);
  }

  // 4) 自定义验证命令（用户在 .env 配置，如 npm test；在工作目录执行）
  const cmd = String(process.env.AGENTS_CHAT_VERIFY_CMD || '').trim();
  if (cmd) {
    const c = await runVerifyCmd(cmd);
    add(`验证命令（${cmd.slice(0, 60)}）`, c.pass, c.note);
  }

  const passCount = items.filter(i => i.pass).length;
  const failCount = items.length - passCount;
  const text = items.length
    ? items.map(i => `- ${i.pass ? '✅' : '❌'} ${i.name}：${i.note}`).join('\n') + `\n（共 ${passCount} 项通过、${failCount} 项未通过）`
    : '';
  return { items, text, passCount, failCount };
}

// ---------- 产出归档：正式产出落盘，后续智能体与用户都能拿到完整版 ----------
const OUT_ROOT = path.join(process.env.AGENTS_CHAT_DATA || path.join(__dirname, '..', '..', '.data'), 'outputs');
const dirCounters = new Map(); // 会话目录 -> 已写文件数（重启后基于现有文件续编）

function sessionOutDir(taskId) {
  const name = taskId ? String(taskId).replace(/[^\w-]/g, '_') : 'main';
  return path.join(OUT_ROOT, name);
}

function saveOutput(sessionDir, agentName, phase, text) {
  try {
    if (!text || !String(text).trim()) return '';
    fs.mkdirSync(sessionDir, { recursive: true });
    if (!dirCounters.has(sessionDir)) {
      let max = 0;
      try {
        for (const f of fs.readdirSync(sessionDir)) {
          const m = f.match(/^(\d+)-/);
          if (m) max = Math.max(max, Number(m[1]));
        }
      } catch { /* 空目录 */ }
      dirCounters.set(sessionDir, max);
    }
    const n = dirCounters.get(sessionDir) + 1;
    dirCounters.set(sessionDir, n);
    const safeName = String(agentName).replace(/[\\/:*?"<>|\s]/g, '_').slice(0, 30);
    const file = path.join(sessionDir, `${String(n).padStart(2, '0')}-${safeName}-${phase}.md`);
    fs.writeFileSync(file, `【${agentName} · ${phase} 阶段产出】\n\n${text}\n`);
    return file;
  } catch { return ''; }
}

// ---------- 基础：运行单个 agent 一轮，流式回调 ----------
// 错误绝不静默：出错时把错误文本作为消息流入聊天流，用户必须能看到
// 正式产出落盘后通过 saved 事件告知前端完整文件路径
function runAgentOnce(agent, prompt, emit, phase, role, taskId, sessionDir, scope, sessionId) {
  return new Promise((resolve) => {
    let output = '';
    let error = undefined;
    let ocSession = sessionId || '';
    emit({ type: 'stage', phase, role, agentId: agent.id, agentName: agent.name, taskId: taskId || '' });
    runAgent(agent, prompt, (chunk) => {
      if (chunk.session) { ocSession = chunk.session; return; } // opencode 会话 ID 回传（续聊锚点）
      if (chunk.content) {
        output += chunk.content;
        emit({ type: 'text', content: chunk.content, phase, role, agentId: agent.id, agentName: agent.name, taskId: taskId || '' });
      }
      if (chunk.done) {
        if (chunk.error) {
          error = chunk.error;
          emit({ type: 'text', content: `\n[执行出错]\n${chunk.error}\n`, phase, role, agentId: agent.id, agentName: agent.name, taskId: taskId || '' });
        }
        const outputPath = error ? '' : saveOutput(sessionDir, agent.name, phase, output);
        if (outputPath) emit({ type: 'saved', path: outputPath, agentId: agent.id, agentName: agent.name, phase, taskId: taskId || '' });
        resolve({ output, error, outputPath, sessionId: ocSession });
      }
    }, scope, sessionId);
  });
}

// ---------- 上下文传递：前序智能体产出 → 工作背景 ----------
// 两种模式（.env AGENTS_CHAT_HANDOFF，默认 doc）：
// - doc：借鉴 handoff skill 的「文档型交接」——组结构化交接文档（任务/进度/产出摘要/文件指针/建议），
//        下游用文件读取工具自取完整产出，省 token 且保留决策线索
// - full：旧模式，前序产出全文（截断）拼接
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

const HANDOFF_MODE = () => (process.env.AGENTS_CHAT_HANDOFF || 'doc').toLowerCase();

// 从智能体输出中提取「交接说明」段（要求其输出末尾附 1~3 条给下游的关键信息）
function extractHandoffNote(output) {
  if (!output) return '';
  const m = output.match(/【交接说?\s*[明册]?】([\s\S]{1,1200}?)(?=\n\s*\n【|$)/);
  return m ? m[1].trim() : '';
}

// ---------- 成果文件：智能体在工作目录里真实创建/修改的文件（最终交付物） ----------
// 与「过程存档」（data/outputs 下系统自动保存的各阶段完整输出）区分：
// 交给用户的必须是工作目录中成果文件的完整绝对路径
function deliverAsk() {
  return `\n\n【文件产出要求】\n你与所有智能体共用的工作目录（所有工作记录与产出文件都保存在这里）：${resolveCwd()}\n若你在工作目录中创建或修改了文件，必须在输出最末尾附「【产出文件】」一节，逐行列出每个成果文件的完整绝对路径（以工作目录为基准拼成从根目录开始的完整路径，不要只写文件名或相对路径）；没有创建文件则不要添加这一节。`;
}

// 解析输出末尾的【产出文件】节：提取路径行 → 相对路径补全为绝对 → 过滤不存在的 → 去重
function extractDeliverFiles(output, cwd) {
  const m = String(output || '').match(/【产出文件】([\s\S]{0,2000}?)(?=\n\s*\n【|$)/);
  if (!m) return [];
  const out = [];
  for (const line of m[1].split(/\r?\n/)) {
    const pm = line.match(/(?:^|[\s：:])((?:[A-Za-z]:)?[\\/][^\s"'''，。；,;）)】]+)/);
    if (!pm) continue;
    const abs = path.resolve(cwd, pm[1]);
    try { if (fs.existsSync(abs) && fs.statSync(abs).isFile() && !out.includes(abs)) out.push(abs); } catch { /* ignore */ }
  }
  return out;
}

// 汇总全部产出中的真实成果文件（去重、按时间序）
function collectRealFiles(results) {
  const cwdNow = resolveCwd();
  const files = [];
  for (const r of results) {
    for (const f of extractDeliverFiles(r.output, cwdNow)) {
      if (!files.includes(f)) files.push(f);
    }
  }
  return files;
}

const PHASE_LABEL_CN = (ph) => ({ plan: '规划', work: '执行', review: '验收', report: '汇总', talk: '发言', task: '任务' }[ph] || '');

// 结构化交接文档：给下游智能体看的「上游留下了什么」
function buildHandoffDoc(r) {
  const status = r.output ? '已完成' : `执行失败：${String(r.error || '').slice(0, 200)}`;
  const note = extractHandoffNote(r.output);
  const lines = [
    `━━━ 交接文档｜来自 ${r.agent.name} ━━━`,
    `■ 任务：${String(r.instruction || '(见上游指派)').slice(0, 300)}`,
    `■ 进度：${status}`
  ];
  if (r.output) {
    const brief = (note || r.output).replace(/\s+/g, ' ').slice(0, 500);
    lines.push(`■ 产出摘要：${brief}${r.output.length > 500 && !note ? '…（完整内容见下方文件）' : ''}`);
  }
  if (r.outputPath) lines.push(`■ 成果文件：${r.outputPath}（完整产出，建议先用文件读取工具查看全文）`);
  if (note) lines.push(`■ 给下游的建议：\n${note}`);
  return lines.join('\n');
}

// 要求智能体输出末尾附交接说明（仅 doc 模式注入）
const HANDOFF_ASK = '\n\n另外：你处于多智能体协作流程中，请在输出末尾附加一段「【交接说明】」，用 1~3 条要点告诉接手的协作者关键信息（重要决策、踩过的坑、注意事项或建议）；若确实无可奉告可省略。';

// ---------- 共享黑板：任务级共享状态文件（借鉴黑板架构；同轮编排全体协作者可读可写） ----------
// 与交接文档的分工：交接文档是「前序产出给直接下游」的全文通道；看板是「全体协作者共享」的轻量进展/决定/提醒流
const BOARD_ASK = '\n另外：若本步工作做出了影响后续工作的关键决定、或发现需要注意的风险，请在输出末尾附加「【看板更新】」用 1~2 条要点写明（会同步到全体协作者共享的看板）；无则省略。';

function boardPathOf(sessionDir) { return path.join(sessionDir, 'BOARD.md'); }

function boardInit(sessionDir, message, roster) {
  try {
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(boardPathOf(sessionDir),
      `# 共享看板\n\n【任务】${String(message).replace(/\s+/g, ' ').slice(0, 200)}\n【团队】${roster}\n\n## 进展\n`, 'utf8');
    return boardPathOf(sessionDir);
  } catch { return ''; }
}

// 从产出中提取「看板更新」块（智能体主动写给全体协作者的提醒/决定）
function extractBoardNote(output) {
  if (!output) return '';
  const m = String(output).match(/【看板更新】([\s\S]{1,600}?)(?=\n\s*\n【|$)/);
  return m ? m[1].replace(/\s+/g, ' ').trim() : '';
}

function boardAppend(sessionDir, stageLabel, agentName, summary, note, files) {
  try {
    const p = boardPathOf(sessionDir);
    if (!fs.existsSync(p)) return;
    const lines = [`- [${stageLabel}] ${agentName}：${String(summary || '').replace(/\s+/g, ' ').slice(0, 120)}`];
    if (files && files.length) lines.push(`  - 成果文件：${files.join('、')}`);
    if (note) lines.push(`  - 看板更新：${note.slice(0, 300)}`);
    fs.appendFileSync(p, lines.join('\n') + '\n', 'utf8');
  } catch { /* 看板写失败不影响主流程 */ }
}

function boardRead(sessionDir, maxLen) {
  const limit = maxLen || 1600;
  try {
    const t = fs.readFileSync(boardPathOf(sessionDir), 'utf8');
    return t.length > limit ? t.slice(0, limit) + '\n…（更早已截断）' : t;
  } catch { return ''; }
}

// ---------- 中途委派：子智能体自认职责错配时改派名单内他人（借鉴 OpenAI Swarm handoff） ----------
// 约定输出 {"handoff":"智能体名称","reason":"原因"}；只认「产出主体就是委派 JSON」的情况，防止误判正常产出
function parseHandoff(output) {
  const text = String(output || '').trim();
  if (!text || text.length > 800 || !text.includes('handoff')) return null;
  const blocks = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map(m => m[1]);
  const s = text.indexOf('{');
  const e = text.lastIndexOf('}');
  if (s >= 0 && e > s) blocks.push(text.slice(s, e + 1));
  for (const b of blocks) {
    try {
      const j = JSON.parse(b);
      if (j && typeof j.handoff === 'string' && j.handoff.trim()) {
        return { to: j.handoff.trim(), reason: String(j.reason || '').slice(0, 500) };
      }
    } catch { /* 尝试下一个块 */ }
  }
  return null;
}

const HANDOFF_DELEGATE_ASK = `\n\n【中途委派】若你判断这个任务更适合名单中的另一位智能体完成（职责错配、你缺乏相应能力或信息），且你尚未开展实质工作，可以只输出一行 JSON 放弃接手：{"handoff":"目标智能体名称","reason":"简要原因"}；管家会把任务连同你的说明转交给对方。能胜任时严禁使用。`;

// 带防循环上限的委派执行：返回最终执行的 {agent, res, delegated}；链上限 2 次（A→B→C 封顶）
// ocSessions：Map(agentId → ses_xxx)，同一成员多段工作（初始/响应/唤醒/委派接手）复用同一 opencode
// 会话，保持完整工作记忆；handoff 转交后接手者用自己的会话继续
async function runWithHandoff(agent, prompt, roster, opts, emit, phase, role, taskId, sessionDir, scope, isStopped, ocSessions) {
  let current = agent;
  let p = prompt + HANDOFF_DELEGATE_ASK;
  let chain = 0;
  let res;
  const trail = [];
  const sessions = ocSessions instanceof Map ? ocSessions : null;
  while (true) {
    const ses = sessions ? (sessions.get(current.id) || '') : '';
    // 续聊时提示已保留工作记忆，避免重做已完成的部分
    const finalPrompt = ses ? `（你的工作记忆已保留：此前本会话中你已完成的工作无需重做，以下任务说明供对照，直接继续。）\n\n${p}` : p;
    res = await runAgentOnce(current, finalPrompt, emit, phase, role, taskId, sessionDir, scope, ses);
    if (sessions && res.sessionId) sessions.set(current.id, res.sessionId);
    const ho = chain < 2 && !isStopped() ? parseHandoff(res.output) : null;
    if (!ho) break;
    const target = roster.find(a => (a.name === ho.to || a.id === ho.to) && a.id !== current.id);
    if (!target) {
      emit({ type: 'notice', content: `↪ 委派目标「${ho.to}」不在名单内，忽略委派、沿用当前产出`, taskId });
      break;
    }
    chain++;
    trail.push({ from: current.name, to: target.name, reason: ho.reason });
    emit({ type: 'notice', content: `↪ ${current.name} 请求委派：${ho.reason} → 改派 ${target.name}（第 ${chain} 次转交）`, taskId });
    p = prompt + `\n\n【委派背景】${current.name} 已接手但判断此任务更适合你，原因：${ho.reason}\n其已产出的参考内容：\n${String(res.output || '').slice(0, 2000)}` + HANDOFF_DELEGATE_ASK;
    current = target;
  }
  return { agent: current, res, trail };
}

// ---------- 人工审批关卡：规划后 / 交付前暂停等待用户放行（借鉴 LangGraph interrupt / OpenAI 审批模式） ----------
// 审批等待期间用户点「停止」或审批超时都视为拒绝；全部走 opts.requestApproval（由 server 注入），orchestrator 不感知 HTTP
async function approvalGate(kind, label, opts, emit, isStopped, taskId) {
  const mode = String((opts && opts.approval) || 'off');
  if (mode !== 'all' && mode !== kind) return true;
  if (!opts || typeof opts.requestApproval !== 'function') return true;
  emit({ type: 'notice', content: `⏸ ${label} — 已暂停，等待人工审批`, taskId });
  let settled = false;
  const stopWatcher = (async () => {
    while (!settled && !isStopped()) await new Promise(r => setTimeout(r, 800));
    return false;
  })();
  const approved = await Promise.race([
    Promise.resolve(opts.requestApproval(kind, label, taskId)),
    stopWatcher
  ]).finally(() => { settled = true; });
  if (approved) {
    emit({ type: 'notice', content: `✔ 审批通过：${label}`, taskId });
  } else {
    emit({ type: 'notice', content: `✘ 审批未通过（拒绝或超时）：${label}，编排终止`, taskId });
  }
  return approved;
}

function appendWorkContext(prompt, results, history) {
  let p = prompt;
  if (HANDOFF_MODE() === 'full') {
    const ctx = buildContext(results);
    if (ctx) p += `\n\n【工作背景：前序智能体的产出摘要（完整版见下方文件）】\n${ctx}`;
  } else {
    const docs = results.filter(r => r.output || r.error).map(r => buildHandoffDoc(r)).join('\n\n');
    if (docs) p += `\n\n【交接文档（前序智能体留给你的，含任务进度与成果文件位置）】\n${docs}\n\n请先通过「成果文件」路径读取上游完整产出后再开工，避免仅凭摘要行事。`;
  }
  const files = results.filter(r => r.outputPath).map(r => `- ${r.agent.name}（${r.phase || 'work'}）：${r.outputPath}`);
  if (files.length) p += `\n\n【完整产出文件】\n${files.join('\n')}`;
  if (history) p += `\n\n【会话背景（本会话此前的对话）】\n${history}`;
  return p;
}

// ---------- 流转事件记录（供流转视图绘制，失败静默不影响主流程） ----------
let storeFlow = null;
let storeRef = null;
try {
  storeFlow = require('./store');
  storeRef = storeFlow;
} catch { storeFlow = null; }
function logFlow(ev) {
  try { if (storeFlow) storeFlow.addFlowEvent(ev); } catch { /* 忽略 */ }
}
function newRunId() {
  return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
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
// opts.resume（断点重跑）：{ phases, priorResults, fromStage, baseRun }
// 跳过规划，前 fromStage-1 个阶段的产出直接复用（priorResults 从落盘文件读回），从 fromStage 起重新执行
async function runButler(butler, subAgents, message, opts, emit, onMessage) {
  const taskId = opts.taskId || '';
  const scope = opts.scope || 'chat';
  const isStopped = opts.isStopped || (() => false);
  const sessionDir = sessionOutDir(taskId);
  const warnings = [];
  const warn = (w) => { warnings.push(w); emit({ type: 'notice', content: `⚠ ${w}`, taskId }); };
  const runId = newRunId();
  const handoffDoc = HANDOFF_MODE() !== 'full';
  const resume = opts.resume && Array.isArray(opts.resume.phases) && opts.resume.phases.length ? opts.resume : null;

  // 管家长期记忆开启时：超长会话背景先经辅助小模型压缩（失败自动确定性截断），
  // 压缩结果写回 opts.history 供后续工作背景复用，全链路只压一次
  const memOn = memory.memoryEnabled();
  if (memOn && opts.history && String(opts.history).length > 4000) {
    const c = await memory.compressHistory(opts.history, { limit: 1200, minLen: 4000 });
    opts.history = c.text;
  }
  // 跨会话回忆：从全部历史消息按关键词检索相关片段（确定性、零 token）
  let recallText = '';
  if (memOn) {
    try {
      const all = (storeFlow && storeFlow.getMessages && storeFlow.getMessages('')) || [];
      const curEpoch = taskId ? undefined : (Number((storeFlow && storeFlow.getConfig && storeFlow.getConfig().mainEpoch)) || 0);
      recallText = memory.recallFromMessages(all, message, { excludeTaskId: taskId, excludeEpoch: curEpoch });
    } catch { /* 检索失败静默跳过 */ }
  }
  logFlow({
    run: runId, type: 'start', from: butler.name, summary: String(message).replace(/\s+/g, ' ').slice(0, 200),
    detail: { taskId, mode: resume ? 'rerun' : 'butler', baseRun: resume ? resume.baseRun : undefined, message: String(message).slice(0, 20000) }
  });

  const roster = subAgents.length
    ? subAgents.map(a => `- ${a.name}（${a.id}）：${a.desc || String(a.systemPrompt || '').slice(0, 60) || '（无描述）'}`).join('\n')
    : '（当前没有任何子智能体，可在右上角「智能体配置」中添加）';

  // results 按 agent 维度保存最新产出
  const results = [];
  const setResult = (agent, output, error, instruction, phase, outputPath) => {
    const i = results.findIndex(r => r.agent.id === agent.id);
    const entry = { agent, output, error, instruction, phase: phase || 'work', outputPath: outputPath || '' };
    if (i >= 0) results[i] = entry; else results.push(entry);
  };

  // ---- 1. 规划（resume 时跳过：直接复用原方案与前置产出） ----
  let phases = [];
  let startStage = 1;
  if (resume) {
    phases = resume.phases;
    results.push(...(resume.priorResults || []));
    startStage = Math.min(Math.max(1, resume.fromStage || 1), phases.length);
    const thought = `从第 ${startStage} 阶段重跑：前 ${startStage - 1} 个阶段的 ${results.length} 份产出直接复用，本阶段起重新执行并验收`;
    emit({ type: 'plan', agentId: butler.id, agentName: butler.name, taskId, thought, phases });
    onMessage({ role: 'assistant', agentId: butler.id, agentName: butler.name, actor: 'butler', phase: 'plan', content: thought, plan: { thought, phases } });
    logFlow({ run: runId, type: 'plan', from: butler.name, summary: thought.replace(/\s+/g, ' ').slice(0, 200), detail: { phases, rerun: true, baseRun: resume.baseRun } });
  } else {

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
  if (memOn) {
    const memText = memory.memoryBlock(['memory', 'user']);
    if (memText) planPrompt += `\n【管家记忆（跨会话积累的笔记与用户偏好，规划时参考）】\n${memText}\n`;
  }
  if (recallText) planPrompt += `\n【历史回忆（关键词检索到的往期相关片段，仅供背景参考，其结论可能已过时）】\n${recallText}\n`;
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
  let planRes = await runAgentOnce(butler, planPrompt, planEmit, 'plan', 'butler', taskId, sessionDir, scope);
  let rawPlan = planRes.output ? extractPlanJSON(planRes.output) : null;
  phases = planRes.output ? normalizePhases(rawPlan, subAgents, warn) : [];

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
    const retryRes = await runAgentOnce(butler, retryPrompt, planEmit, 'plan', 'butler', taskId, sessionDir, scope);
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
    // 直答也自省：用户偏好常在闲聊/澄清中表达（失败静默）
    if (memOn) {
      try {
        const r = await memory.reflectOnRun(`用户消息：${String(message).slice(0, 800)}\n\n管家直答（节选）：${String(answer).slice(0, 800)}`);
        if (r && r.applied) emit({ type: 'notice', content: `💾 管家记忆已更新：${r.note || `记录 ${r.applied} 条`}`, taskId });
      } catch { /* 自省失败静默 */ }
    }
    return { ok: true, finalText: answer };
  }

  // 推送并持久化调度方案（仅界面展示，不进入后续上下文）
  const planMsg = { thought: planThought(planRes.output), phases };
  emit({ type: 'plan', agentId: butler.id, agentName: butler.name, taskId, thought: planMsg.thought, phases: planMsg.phases });
  onMessage({ role: 'assistant', agentId: butler.id, agentName: butler.name, actor: 'butler', phase: 'plan', content: planToText(planMsg), plan: planMsg });
  logFlow({ run: runId, type: 'plan', from: butler.name, summary: (planMsg.thought || '').replace(/\s+/g, ' ').slice(0, 200), detail: { phases: planMsg.phases } });
  } // endif 非重跑的规划分支

  // 方案审批关卡：规划确定后、动工前等待用户放行（approval=plan/all 时启用）
  if (phases.length > 0 && !(await approvalGate('plan', `调度方案：${phases.length} 个阶段，涉及 ${[...new Set(phases.flat().map(s => s.agentName || s.agent))].filter(Boolean).join('、')}`, opts, emit, isStopped, taskId))) {
    return { ok: false, finalText: '用户否决了调度方案，编排已终止（可修改需求后重新发起）', stopped: true };
  }

  // 共享看板：本轮编排全体协作者的进展/决定/提醒（每轮独立，重跑时前序产出概要一并写入）
  boardInit(sessionDir, message, subAgents.map(a => a.name).join('、') || '（管家独自处理）');
  if (resume && results.length) {
    for (const r of results) boardAppend(sessionDir, `复用·${PHASE_LABEL_CN(r.phase) || r.phase}`, r.agent.name, String(r.output || '').replace(/\s+/g, ' ').slice(0, 100), extractBoardNote(r.output), r.outputPath ? [r.outputPath] : []);
  }

  // ---- 2. 执行各阶段（阶段内并行，分批限流；重跑从 startStage 起步） ----
  for (let i = startStage - 1; i < phases.length; i++) {
    if (isStopped()) {
      emit({ type: 'notice', content: '已手动停止，跳过剩余阶段', taskId });
      break;
    }
    const group = phases[i];
    emit({ type: 'phase', index: i + 1, total: phases.length, parallel: group.length > 1, names: group.map(s => s.agentName).join('、'), taskId });
    // 阶段间交接事件：上阶段产出者 → 本阶段执行者（流转视图的 handoff 边）
    if (i > 0) {
      const upsters = results.filter(r => r.output || r.error);
      for (const up of upsters) {
        for (const step of group) {
          if (step.agentId === up.agent.id) continue;
          logFlow({
            run: runId, type: 'handoff', from: up.agent.name, to: step.agentName, stage: i + 1,
            summary: (extractHandoffNote(up.output) || String(up.instruction || '').replace(/\s+/g, ' ')).slice(0, 200),
            files: up.outputPath ? [up.outputPath] : [],
            detail: { handoffDoc: handoffDoc }
          });
        }
      }
    }
    for (let j = 0; j < group.length; j += PARALLEL_CAP) {
      const batch = group.slice(j, j + PARALLEL_CAP);
      await Promise.all(batch.map(step => (async () => {
        const agent = subAgents.find(a => a.id === step.agentId);
        logFlow({ run: runId, type: 'dispatch', from: butler.name, to: agent.name, stage: i + 1, summary: String(step.instruction).replace(/\s+/g, ' ').slice(0, 200) });
        let p = `【来自管家的指派】\n${step.instruction}\n\n【用户原始需求】\n${message}`;
        p = appendWorkContext(p, results, opts.history);
        const boardText = boardRead(sessionDir);
        if (boardText) p += `\n\n【共享看板（本轮任务全体协作者的进展与提醒，含并行同伴的已完成阶段）】\n${boardText}`;
        p += '\n\n请输出你的正式结果。' + deliverAsk() + (handoffDoc ? HANDOFF_ASK : '') + BOARD_ASK;
        const { agent: finalAgent, res, trail } = await runWithHandoff(agent, p, subAgents, opts, emit, 'work', 'worker', taskId, sessionDir, scope, isStopped);
        for (const t of trail) {
          logFlow({ run: runId, type: 'handoff', from: t.from, to: t.to, stage: i + 1, summary: `中途委派：${t.reason}`, detail: { delegate: true } });
        }
        setResult(finalAgent, res.output, res.error, step.instruction, 'work', res.outputPath);
        onMessage({ role: 'assistant', agentId: finalAgent.id, agentName: finalAgent.name, actor: 'assistant', phase: 'work', content: (res.output || `[执行出错] ${res.error}`).slice(0, 20000), outputPath: res.outputPath || '' });
        boardAppend(sessionDir, `阶段${i + 1}`, finalAgent.name,
          res.output ? String(res.output).replace(/\s+/g, ' ').slice(0, 100) : `执行失败：${String(res.error || '').slice(0, 80)}`,
          extractBoardNote(res.output),
          extractDeliverFiles(res.output, resolveCwd()));
        logFlow({
          run: runId, type: 'done', to: finalAgent.name, stage: i + 1,
          summary: (res.output ? '完成' : `失败：${String(res.error || '').slice(0, 120)}`) + (trail.length ? `（经 ${trail.length} 次委派）` : ''),
          files: res.outputPath ? [res.outputPath] : [],
          detail: { ok: !!res.output, delegatedFrom: trail.length ? trail[0].from : '' }
        });
      })()));
    }
    if (isStopped()) break;
  }

  // ---- 3. 验收 → 返工循环 ----
  let accepted = false;
  let reworks = 0;
  while (true) {
    if (isStopped()) {
      emit({ type: 'notice', content: '已手动停止，跳过验收与汇总', taskId });
      return { ok: false, finalText: '已手动停止（各智能体的阶段产出已保存在会话产出目录）', stopped: true };
    }
    const round = reworks + 1;
    const workText = results.map(r =>
      `【${r.agent.name} 的任务】\n${r.instruction}\n【${r.agent.name} 的产出】\n${(r.output || `（执行失败：${r.error}）`).slice(0, CTX_PER_OUTPUT)}`
    ).join('\n\n');
    // 产出文件清单：真实成果文件（工作目录）优先，过程存档作为补充供核验
    const realFilesNow = collectRealFiles(results);
    const outFiles = results.filter(r => r.outputPath);
    const filesSection = (realFilesNow.length || outFiles.length)
      ? `\n【产出文件（如需核验细节可按路径读取）】\n${[
          ...realFilesNow.map(f => `- 成果文件（最终交付物）：${f}`),
          ...outFiles.map(r => `- ${r.agent.name}的过程存档（系统保存的完整输出，非最终成果）：${r.outputPath}`)
        ].join('\n')}\n`
      : '';

    // 自动核查：验收前由系统本地执行的确定性检查（文件/语法/JSON/占位符/自定义命令）
    let autoText = '';
    try {
      const auto = await runAutoChecks(results);
      if (auto && auto.text) {
        autoText = `\n【客观核查结果（系统自动执行的事实核查，非智能体自述，验收必须参考）】\n${auto.text}\n`;
        emit({ type: 'notice', content: `🔬 自动核查：${auto.passCount} 项通过${auto.failCount ? `，${auto.failCount} 项未通过（详情已交给验收）` : ''}`, taskId });
        logFlow({ run: runId, type: 'autocheck', from: butler.name, round, summary: `${auto.passCount} 项通过${auto.failCount ? `，${auto.failCount} 项未通过` : ''}`, detail: { items: auto.items.slice(0, 40) } });
      }
    } catch { /* 核查异常不影响验收 */ }

    const verifyPrompt = `你是「管家」。第 ${round} 轮验收：请核对各子智能体的工作成果是否满足用户需求。

【用户原始需求】
${message}
${memOn && memory.memoryBlock(['user']) ? `\n【用户偏好（验收标准参考，如语言、格式、风格偏好）】\n${memory.memoryBlock(['user'])}\n` : ''}
${boardRead(sessionDir, 1200) ? `【共享看板（各智能体自报的进展与提醒，仅供交叉参照）】\n${boardRead(sessionDir, 1200)}\n` : ''}
【各智能体的任务与产出】
${workText.slice(0, 24000)}
${filesSection}${autoText}
    ${reworks > 0 ? '\n（注：此前已反馈过问题，请重点核对是否已按建议完善）\n' : ''}
输出格式（严格遵守）：
1. 先用 1~2 句中文向用户说明验收结论（若客观核查有未通过项，必须在结论中点名说明）
2. 再输出 JSON：全部合格输出 {"verdict":"ACCEPT"}；存在问题输出 {"verdict":"REJECT","issues":[{"agent":"智能体名称","requirement":"必须满足的要求","suggestion":"具体完善建议"}]}
只有确有问题才 REJECT；issues 只列需要返工的智能体，不要把合格的也列进去。客观核查未通过的项，对应的智能体必须列入 issues（除非与用户需求确实无关）。`;

    const verifyRes = await runAgentOnce(butler, verifyPrompt, emit, 'review', 'butler', taskId, sessionDir, scope);
    onMessage({ role: 'assistant', agentId: butler.id, agentName: butler.name, actor: 'butler', phase: 'review', content: (verifyRes.output || `[验收出错] ${verifyRes.error}`).slice(0, 20000), outputPath: verifyRes.outputPath || '' });
    if (!verifyRes.output) break; // 验收失败无法判定，直接交付

    const verdict = parseVerdict(verifyRes.output, subAgents, warn);
    if (verdict.accepted) {
      accepted = true;
      emit({ type: 'verify', round, accepted: true, taskId });
      logFlow({ run: runId, type: 'verify', from: butler.name, round, summary: '验收通过' });
      break;
    }
    if (reworks >= MAX_REWORK) {
      emit({ type: 'verify', round, accepted: false, taskId, note: `已达最大返工轮数（${MAX_REWORK}），交付当前版本` });
      logFlow({ run: runId, type: 'verify', from: butler.name, round, summary: `验收未通过（已达最大返工轮数 ${MAX_REWORK}，交付当前版本）` });
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
    logFlow({ run: runId, type: 'verify', from: butler.name, round, summary: `验收未通过 → 第 ${reworks} 轮返工：${reworkList.map(x => x.agentName).join('、')}` });
    for (const it of reworkList) {
      const r = results.find(x => x.agent.id === it.agentId);
      let p = `【来自管家的返工要求】${it.requirement}\n【完善建议】${it.suggestion}\n\n【你上次的产出】\n${(r.output || `（执行失败：${r.error}）`).slice(0, CTX_PER_OUTPUT)}\n\n【你上次的任务】\n${it.instruction}\n\n【用户原始需求】\n${message}`;
      if (r.outputPath) p += `\n\n【你上次的完整产出文件】${r.outputPath}（建议先读取完整版再修改）`;
      const ctxOthers = buildContext(results.filter(x => x.agent.id !== it.agentId));
      if (ctxOthers) p += `\n\n【工作背景：其他智能体的产出】\n${ctxOthers}`;
      const otherFiles = results.filter(x => x.agent.id !== it.agentId && x.outputPath).map(x => `- ${x.agent.name}：${x.outputPath}`);
      if (otherFiles.length) p += `\n\n【其他智能体的完整产出文件】\n${otherFiles.join('\n')}`;
      p += '\n\n请在原有产出基础上完善，不要从零重复劳动。' + deliverAsk() + (handoffDoc ? HANDOFF_ASK : '');
      logFlow({ run: runId, type: 'rework', from: butler.name, to: r.agent.name, round: reworks, summary: `${it.requirement}｜建议：${String(it.suggestion || '').replace(/\s+/g, ' ').slice(0, 150)}` });
      const res = await runAgentOnce(r.agent, p, emit, 'work', 'worker', taskId, sessionDir, scope);
      setResult(r.agent, res.output || r.output, res.output ? undefined : (res.error || r.error), it.instruction, 'work', res.outputPath || r.outputPath);
      onMessage({ role: 'assistant', agentId: r.agent.id, agentName: r.agent.name, actor: 'assistant', phase: 'work', content: (res.output || `[返工出错] ${res.error}`).slice(0, 20000), outputPath: res.outputPath || '' });
      if (res.output) boardAppend(sessionDir, `返工${reworks}`, r.agent.name, String(res.output).replace(/\s+/g, ' ').slice(0, 100), extractBoardNote(res.output), extractDeliverFiles(res.output, resolveCwd()));
      logFlow({
        run: runId, type: 'done', to: r.agent.name, round: reworks,
        summary: (res.output ? `第 ${reworks} 轮返工完成` : `返工失败：${String(res.error || '').slice(0, 120)}`),
        files: res.outputPath ? [res.outputPath] : [],
        detail: { ok: !!res.output, rework: true }
      });
    }
  }

  // ---- 4. 汇总：面向用户的正式回答 ----
  // 交付审批关卡：验收通过后、正式交付前等待用户放行（approval=verify/all 时启用）
  if (!(await approvalGate('verify', `交付确认：${accepted ? '验收通过' : `经 ${reworks} 轮返工仍有残留问题`}`, opts, emit, isStopped, taskId))) {
    return { ok: false, finalText: '用户否决了本次交付，编排已终止（各智能体产出已保存在会话产出目录，可在流转视图中断点重跑）', stopped: true };
  }
  const outs = results.map(r => `【${r.agent.name}】\n${r.output || `（执行失败：${r.error}）`}`).join('\n\n');
  const deliverFiles = results.filter(r => r.outputPath);
  // 真实成果文件：智能体在工作目录中创建/修改的文件（用户最终要的东西，完整绝对路径）
  const realFiles = collectRealFiles(results);
  const realSection = realFiles.length
    ? `\n【成果文件完整路径（智能体在工作目录中真实创建的文件，务必原样照抄给用户，一个都不能漏）】\n${realFiles.map(f => `- ${f}`).join('\n')}`
    : (deliverFiles.length
        ? `\n【本次没有在工作目录中创建文件；以下是系统自动保存的各智能体过程存档（完整输出记录，非最终成果文件，如需提及请注明是过程记录）】\n${deliverFiles.map(r => `- ${r.agent.name} 的${PHASE_LABEL_CN(r.phase) || '阶段'}存档：${r.outputPath}`).join('\n')}`
        : '\n（本次工作没有落盘的文件）');
  const sumPrompt = `你是「管家」。各子智能体已完成工作${accepted ? `（验收通过，共 ${reworks} 轮返工）` : `（经 ${reworks} 轮返工仍未完全达标，请如实向用户说明残留问题）`}。请向用户输出最终正式回答，用中文，要求：
- 开头用简明准确的 3~5 句概括最终结果，直接回应用户需求，让用户一眼看懂做成了什么
- 回答末尾给出「成果文件」一节：原样照抄上方成果文件的完整路径（从根目录开始，不要改写、不要省略、不要缩写），并各用一句话说明文件内容
- 路径中禁止出现相对路径或单独文件名；如智能体产出中提到的文件不在上方清单里，不要列入
- 没有任何成果文件时，不要编造「成果文件」一节
- 结构清晰、结论明确，不要输出 JSON

【用户原始需求】
${message}

【各智能体产出】
${outs.slice(0, 24000)}
${realSection}`;
  const sumRes = await runAgentOnce(butler, sumPrompt, emit, 'report', 'butler', taskId, sessionDir, scope);
  const finalText = sumRes.output || outs || sumRes.error || '';
  onMessage({ role: 'assistant', agentId: butler.id, agentName: butler.name, actor: 'butler', phase: 'report', content: (finalText || '（无输出）').slice(0, 20000), outputPath: sumRes.outputPath || '' });
  logFlow({
    run: runId, type: 'finish', from: butler.name,
    summary: String(finalText).replace(/\s+/g, ' ').slice(0, 200),
    files: realFiles.length ? realFiles : deliverFiles.map(r => r.outputPath),
    detail: { accepted, reworks, realFiles }
  });

  // ---- 5. 自省：辅助小模型从本轮提取值得长期记住的偏好/事实（失败静默，绝不阻塞交付） ----
  if (memOn) {
    try {
      const digest = `用户需求：${String(message).slice(0, 800)}\n\n调度安排：${phases.map((st, i) => `第${i + 1}阶段 ${st.map(s => s.agent).join('、')}`).join('；').slice(0, 300)}\n\n最终交付（节选）：${String(finalText).slice(0, 1200)}\n\n验收情况：${accepted ? '通过' : '未完全通过'}`;
      const r = await memory.reflectOnRun(digest);
      if (r && r.applied) emit({ type: 'notice', content: `💾 管家记忆已更新：${r.note || `记录 ${r.applied} 条`}`, taskId });
    } catch { /* 自省失败静默 */ }
  }
  return { ok: !sumRes.error || results.some(r => r.output), finalText };
}

// ---------- @点名：按点名顺序串行流水线（产出作为后续背景） ----------
async function runMentioned(mentionAgents, message, opts, emit, onMessage) {
  const taskId = opts.taskId || '';
  const scope = opts.scope || 'chat';
  const isStopped = opts.isStopped || (() => false);
  const sessionDir = sessionOutDir(taskId);
  const results = [];
  const runId = newRunId();
  const handoffDoc = HANDOFF_MODE() !== 'full';
  logFlow({ run: runId, type: 'start', from: mentionAgents[0] && mentionAgents[0].name, summary: String(message).replace(/\s+/g, ' ').slice(0, 200), detail: { taskId, mode: 'pipeline', members: mentionAgents.map(a => a.name) } });
  for (let i = 0; i < mentionAgents.length; i++) {
    const agent = mentionAgents[i];
    if (isStopped()) {
      emit({ type: 'notice', content: '已手动停止，跳过剩余智能体', taskId });
      break;
    }
    const role = agent.id === 'butler' ? 'butler' : 'worker';
    // 流水线交接事件：上一个智能体 → 当前智能体
    if (i > 0) {
      const up = results[results.length - 1];
      if (up && (up.output || up.error)) {
        logFlow({
          run: runId, type: 'handoff', from: up.agent.name, to: agent.name, stage: i + 1,
          summary: (extractHandoffNote(up.output) || String(message).replace(/\s+/g, ' ')).slice(0, 200),
          files: up.outputPath ? [up.outputPath] : []
        });
      }
    }
    logFlow({ run: runId, type: 'dispatch', from: i === 0 ? '用户' : mentionAgents[i - 1].name, to: agent.name, stage: i + 1, summary: String(message).replace(/\s+/g, ' ').slice(0, 200) });
    const p = appendWorkContext(message, results, opts.history) + (handoffDoc && role === 'worker' ? HANDOFF_ASK : '');
    // 中途委派：@点名流水线同样允许转交给名单内其他智能体（含管家改派子智能体之外的对象）
    const { agent: finalAgent, res, trail } = await runWithHandoff(agent, p, mentionAgents, opts, emit, 'work', role, taskId, sessionDir, scope, isStopped);
    for (const t of trail) logFlow({ run: runId, type: 'handoff', from: t.from, to: t.to, stage: i + 1, summary: `中途委派：${t.reason}`, detail: { delegate: true } });
    results.push({ agent: finalAgent, output: res.output, error: res.error, instruction: String(message).slice(0, 300), phase: 'work', outputPath: res.outputPath });
    if (res.output || res.error) {
      onMessage({ role: 'assistant', agentId: finalAgent.id, agentName: finalAgent.name, actor: 'assistant', phase: 'work', content: (res.output || `[执行出错] ${res.error}`).slice(0, 20000), outputPath: res.outputPath || '' });
    }
    logFlow({
      run: runId, type: 'done', to: finalAgent.name, stage: i + 1,
      summary: (res.output ? '完成' : `失败：${String(res.error || '').slice(0, 120)}`) + (trail.length ? `（经 ${trail.length} 次委派）` : ''),
      files: res.outputPath ? [res.outputPath] : [],
      detail: { ok: !!res.output }
    });
  }
  const finalText = results.map(r => r.output).filter(Boolean).join('\n\n');
  logFlow({ run: runId, type: 'finish', from: mentionAgents[mentionAgents.length - 1] && mentionAgents[mentionAgents.length - 1].name, summary: String(finalText).replace(/\s+/g, ' ').slice(0, 200), files: results.filter(r => r.outputPath).map(r => r.outputPath), detail: { mode: 'pipeline' } });
  return { ok: results.some(r => r.output), finalText, stopped: isStopped() };
}

// ---------- 圆桌讨论：多智能体自由发言 + 管家主持人（借鉴 AutoGen 群聊辩论 / ChatDev 双智能体对话对） ----------
// 与管家调度的区别：没有派活与验收，成员围绕主题轮流发言（看得到彼此观点，可反驳），
// 每轮结束由主持人判定「收敛 / 继续深入（带聚焦问题）」，最后输出结构化总结。
// Token 护栏：发言限字数、记录截断、最多 N 轮（.env AGENTS_CHAT_ROUNDTABLE_ROUNDS，默认 2）、可提前收敛
const ROUNDTABLE_MAX_ROUNDS = Number(process.env.AGENTS_CHAT_ROUNDTABLE_ROUNDS) > 0
  ? Number(process.env.AGENTS_CHAT_ROUNDTABLE_ROUNDS) : 2;
const ROUNDTABLE_TRANSCRIPT_LIMIT = 9000; // 发言记录传给每个发言者的截断长度

function transcriptText(transcript) {
  const s = transcript.filter(t => t.text).map(t => `【${t.name}】\n${t.text}`).join('\n\n');
  return s.length > ROUNDTABLE_TRANSCRIPT_LIMIT ? s.slice(s.length - ROUNDTABLE_TRANSCRIPT_LIMIT) + '…（更早发言已截断）' : s;
}

// 主持人判定：CONVERGED / CONTINUE（带聚焦问题）；解析失败按已收敛处理，避免无谓续轮
function parseModerate(text) {
  const j = extractPlanJSON(text);
  if (j && typeof j === 'object' && typeof j.verdict === 'string') {
    const v = j.verdict.toUpperCase();
    if (v === 'CONTINUE') {
      return { converged: false, question: String(j.question || '').slice(0, 300) };
    }
    return { converged: true, question: '' };
  }
  return { converged: true, question: '' };
}

async function runRoundtable(butler, participants, message, opts, emit, onMessage) {
  const taskId = opts.taskId || '';
  const scope = opts.scope || 'chat';
  const isStopped = opts.isStopped || (() => false);
  const sessionDir = sessionOutDir(taskId);
  const runId = newRunId();
  const members = participants.map(a => a.name);

  const memBlockRT = memory.memoryEnabled() ? memory.memoryBlock(['memory', 'user']) : '';
  const topicBlock = `【讨论主题】\n${message}`
    + (memBlockRT ? `\n\n【管家记忆（跨会话笔记与用户偏好，讨论时参考）】\n${memBlockRT}` : '')
    + (opts.history ? `\n\n【会话背景（本会话此前的对话）】\n${String(opts.history).slice(0, 3000)}` : '');

  logFlow({
    run: runId, type: 'start', from: butler.name, summary: String(message).replace(/\s+/g, ' ').slice(0, 200),
    detail: { taskId, mode: 'roundtable', members, message: String(message).slice(0, 20000) }
  });
  emit({ type: 'notice', content: `💬 圆桌讨论开始：${members.join('、')}（最多 ${ROUNDTABLE_MAX_ROUNDS} 轮，主持人可在达成共识后提前结束）`, taskId });

  const transcript = [];
  let focusing = '';
  let stopped = false;

  for (let round = 1; round <= ROUNDTABLE_MAX_ROUNDS; round++) {
    for (let i = 0; i < participants.length; i++) {
      const agent = participants[i];
      if (isStopped()) { stopped = true; break; }
      emit({
        type: 'phase', index: (round - 1) * participants.length + i + 1,
        total: ROUNDTABLE_MAX_ROUNDS * participants.length,
        parallel: false, names: `第${round}轮 · ${agent.name} 发言`, taskId
      });
      logFlow({ run: runId, type: 'dispatch', from: butler.name, to: agent.name, stage: round, summary: `第${round}轮发言` });
      const p = `【圆桌讨论 · 第 ${round} 轮】\n你是「${agent.name}」，正与多位协作者围绕同一主题讨论。

${topicBlock}

【发言记录（按时间序）】
${transcript.length ? transcriptText(transcript) : '（你第一个发言）'}
${focusing ? `\n【主持人聚焦问题】\n${focusing}\n` : ''}
请发表你的观点，600 字以内：明确表态（认同/不认同谁、为什么），补充新信息或提出反驳，不要重复已说过的内容。直接输出发言内容。`;
      const res = await runAgentOnce(agent, p, emit, 'talk', 'worker', taskId, sessionDir, scope);
      if (res.output || res.error) {
        transcript.push({ name: agent.name, text: res.output || `（发言失败：${res.error}）` });
        // 发言仅展示与存档（phase=talk 不进入后续会话上下文），结论由总结承载
        onMessage({ role: 'assistant', agentId: agent.id, agentName: agent.name, actor: 'assistant', phase: 'talk', content: (res.output || `[发言出错] ${res.error}`).slice(0, 20000), outputPath: res.outputPath || '' });
      }
      logFlow({
        run: runId, type: 'done', to: agent.name, stage: round,
        summary: (res.output ? `第${round}轮发言完成` : `发言失败：${String(res.error || '').slice(0, 120)}`),
        files: res.outputPath ? [res.outputPath] : [],
        detail: { ok: !!res.output, talk: true }
      });
    }
    if (stopped || isStopped()) { stopped = true; break; }

    // 每轮结束后主持人判定（最后一轮无需判定，直接总结）
    if (round < ROUNDTABLE_MAX_ROUNDS) {
      const modPrompt = `你是「管家」，本次圆桌讨论的主持人。第 ${round} 轮发言结束，请判定讨论是否已经收敛。

${topicBlock}

【发言记录（按时间序）】
${transcriptText(transcript)}

输出格式（严格遵守）：
1. 先用 1 句中文说明判定理由
2. 再输出 JSON：观点已充分交锋、可以总结，输出 {"verdict":"CONVERGED"}；仍存在重要分歧或信息缺口需要深入，输出 {"verdict":"CONTINUE","question":"给下一轮讨论的聚焦问题（一句话）"}`;
      const modRes = await runAgentOnce(butler, modPrompt, (e) => { if (e.type === 'text') return; emit(e); }, 'review', 'butler', taskId, sessionDir, scope);
      const mv = parseModerate(modRes.output || '');
      if (mv.converged) {
        emit({ type: 'notice', content: `⚖ 主持人判定：讨论已收敛，进入总结`, taskId });
        logFlow({ run: runId, type: 'moderate', from: butler.name, round, summary: '判定：已收敛，进入总结' });
        break;
      }
      focusing = mv.question || '请围绕核心分歧继续深入';
      emit({ type: 'notice', content: `⚖ 主持人判定：继续深入 → ${focusing}`, taskId });
      logFlow({ run: runId, type: 'moderate', from: butler.name, round, summary: `判定：继续深入（第 ${round + 1} 轮聚焦：${focusing.replace(/\s+/g, ' ').slice(0, 120)}）` });
    }
  }

  if (stopped) {
    emit({ type: 'notice', content: '已手动停止，圆桌讨论中止（已发言内容保存在会话记录）', taskId });
    return { ok: false, finalText: '圆桌讨论已手动停止', stopped: true };
  }

  // 总结：共识 / 分歧 / 建议行动（phase=report，进入后续会话上下文）
  const sumPrompt = `你是「管家」。圆桌讨论已结束，请向用户输出圆桌讨论总结。

${topicBlock}

【发言记录（按时间序）】
${transcriptText(transcript)}

要求：
- 开头 2~3 句概括讨论整体走向与最终共识
- 分节列出：「共识」各方一致同意的结论；「分歧」仍无定论的争议点（注明持方）；「建议行动」接下来建议怎么做
- 结论明确，不编造任何发言者未说过的内容`;
  const sumRes = await runAgentOnce(butler, sumPrompt, emit, 'report', 'butler', taskId, sessionDir, scope);
  const finalText = sumRes.output || transcriptText(transcript) || sumRes.error || '';
  onMessage({ role: 'assistant', agentId: butler.id, agentName: butler.name, actor: 'butler', phase: 'report', content: (finalText || '（无输出）').slice(0, 20000), outputPath: sumRes.outputPath || '' });
  logFlow({
    run: runId, type: 'finish', from: butler.name,
    summary: String(finalText).replace(/\s+/g, ' ').slice(0, 200),
    files: sumRes.outputPath ? [sumRes.outputPath] : [],
    detail: { mode: 'roundtable', members, rounds: Math.min(ROUNDTABLE_MAX_ROUNDS, transcript.length ? Math.ceil(transcript.length / participants.length) : 0) }
  });
  return { ok: !!sumRes.output, finalText };
}

// ---------- 任务队列：每个任务一次完整调度（独立会话） ----------
// 末尾 @子智能体 的任务由该智能体独立完成；未指派/@管家 则由管家调度
// 手动停止：当前任务复位为待执行，剩余任务不再启动
async function runTasks(tasks, butler, subAgents, opts, emit, onMessage, onTaskStart, onTaskDone) {
  const isStopped = opts.isStopped || (() => false);
  for (const task of tasks) {
    if (isStopped()) {
      emit({ type: 'notice', content: '已手动停止，剩余任务保持待执行状态' });
      break;
    }
    // 任务隔离 worktree：opts.taskCwd(task) 返回隔离目录（空 = 共享目录），整任务执行期间注入 cwd 上下文
    const taskCwd = opts.taskCwd ? String(opts.taskCwd(task) || '') : '';
    if (taskCwd) emit({ type: 'notice', content: `🌿 本任务在 Git 隔离区执行：${taskCwd}`, taskId: task.id });
    await require('./worktree').runWithTaskCwd(taskCwd, async () => {
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
        r = await runMentioned([assigned], prompt, { taskId: task.id, history, scope: opts.scope, isStopped }, emit, persistTask);
      } else {
        emit({ type: 'task_start', taskId: task.id, title: task.title, agentName: butler.name });
        r = await runButler(butler, subAgents, prompt, { taskId: task.id, history, scope: opts.scope, isStopped }, emit, persistTask);
      }
      let status = r.ok ? 'done' : 'failed';
      let resultText = (r.finalText || '').trim() || '执行失败';
      if (isStopped() && !r.ok) {
        status = 'pending'; // 手动停止的任务回到待执行，可随时重跑
        resultText = '已手动停止，可重新执行';
      }
      onTaskDone(task.id, { status, result: resultText.slice(0, 10000) });
      emit({ type: 'task_done', taskId: task.id, status, title: task.title });
    });
  }
  emit({ type: 'all_done' });
}

// ---------- 断点重跑：从流转日志还原编排现场 ----------
// 读取一次 run 的全部事件，构造 runButler 的 opts.resume：
// - phases：取 plan 事件 detail.phases（v3.7.0 起存完整指令；旧记录截断过，无法安全重跑）
// - priorResults：< fromStage 各步骤的产出，从 done 事件的成果文件读回全文（同智能体多阶段取最新）
// - message/taskId：取 start 事件（detail.message 完整，兜底 summary）
function prepareRerun(events, fromStage, subAgents) {
  const start = events.find(e => e.type === 'start');
  const plan = events.find(e => e.type === 'plan');
  if (!start || !plan) throw new Error('该记录缺少完整的规划信息，无法重跑');
  const rawPhases = plan.detail && Array.isArray(plan.detail.phases) ? plan.detail.phases : null;
  if (!rawPhases || !rawPhases.length) throw new Error('该记录为旧版本格式（调度指令不完整），仅 v3.7.0 之后的编排支持重跑');
  fromStage = Math.max(1, Math.min(Number(fromStage) || 1, rawPhases.length));

  // 校验各步骤的智能体仍然存在（已被删除的剔除并收集提示）
  const phases = [];
  const dropped = [];
  for (const group of rawPhases) {
    const keep = [];
    for (const s of (Array.isArray(group) ? group : [group])) {
      if (!s || !s.agentId || !String(s.instruction || '').trim()) continue;
      const agent = subAgents.find(a => a.id === s.agentId);
      if (agent) keep.push({ agentId: agent.id, agentName: agent.name, instruction: String(s.instruction).slice(0, 3000) });
      else dropped.push(String(s.agentName || s.agentId));
    }
    if (keep.length) phases.push(keep);
  }
  if (!phases.length) throw new Error('调度方案中引用的智能体已全部不存在，无法重跑');
  fromStage = Math.min(fromStage, phases.length);

  // 每个智能体最新一次落盘产出（含返工后的版本）
  const lastFile = new Map(); // agentName -> outputPath
  for (const e of events) {
    if (e.type === 'done' && e.to && e.files && e.files[0]) lastFile.set(e.to, e.files[0]);
  }

  // < fromStage 的步骤 → priorResults（同智能体多阶段时后一阶段覆盖前一阶段）
  const byAgent = new Map();
  for (let i = 0; i < fromStage - 1 && i < phases.length; i++) {
    for (const s of phases[i]) {
      const agent = subAgents.find(a => a.id === s.agentId) || { id: s.agentId, name: s.agentName };
      const f = lastFile.get(s.agentName);
      let output = '';
      let outputPath = '';
      if (f) {
        try { output = fs.readFileSync(f, 'utf8'); outputPath = f; } catch { /* 文件丢失 */ }
      }
      byAgent.set(agent.id, {
        agent, output,
        error: output ? undefined : (f ? `（产出文件已丢失：${f}）` : '（该智能体当时无落盘产出）'),
        instruction: s.instruction, phase: 'work', outputPath
      });
    }
  }

  return {
    message: (start.detail && start.detail.message) || start.summary || '',
    taskId: (start.detail && start.detail.taskId) || '',
    phases, fromStage, dropped,
    priorResults: [...byAgent.values()]
  };
}

// ---------- 分工模式：名单内成员并行执行 + @ 传导接力（无管家实体，统一默认模型） ----------
// 流程：dividePlan 一次分工调用（每人任务，可空=旁听）→ 并行执行 → 产出中 @ 名单内成员触发传导，
// 被 @ 者执行后结果回灌、原 @ 者被唤醒继续；硬上限（总段数/传导跳数）防循环；isStopped 全程可停。
const DIVIDE_MAX_WORK = 8;  // 单轮编排总工作段数上限（含初始与传导）
const DIVIDE_MAX_HOP = 2;   // 传导跳数上限（初始任务 hop=0，每次 @ 传导 +1）
const DIVIDE_MENTION_RE = /@([^\s@，。,.；;！!？?、()（）【】[\]"'「」]+)/g;

function dividePlanTimeout() { return Number(process.env.AGENTS_CHAT_DIVIDE_PLAN_TIMEOUT_MS) || 120000; }

// 产出/消息文本中的 @ 解析（与 server.js resolveMentions 同规则：id 或名字精确匹配）
function divideMentions(text, agents) {
  const out = [];
  const seen = new Set();
  const re = new RegExp(DIVIDE_MENTION_RE.source, 'g');
  let m;
  while ((m = re.exec(String(text))) !== null) {
    const tok = m[1];
    const ag = agents.find(a => a.id === tok) || agents.find(a => a.name === tok);
    if (ag && !seen.has(ag.id)) { seen.add(ag.id); out.push(ag); }
  }
  return out;
}

// 分工调用：LLM（默认模型）为名单内每个成员分配任务；task 空 = 本轮旁听
// 返回 [{agent, task}]；mock 模式返回确定性演示分工；内核调用失败抛错（由调用方降级）
async function dividePlan(participants, message, history) {
  if (process.env.AGENTS_CHAT_MOCK === '1') {
    return participants.map((a, i) => ({
      agent: a,
      task: i < Math.min(2, participants.length)
        ? `【演示分工】围绕「${String(message).slice(0, 30)}」完成${a.name}职责范围内的部分并给出结论。`
        : ''
    }));
  }
  const roster = participants.map(a => `- ${a.name}（id: ${a.id}）：${a.desc || a.name}`).join('\n');
  const prompt = `你是团队分工调度员。根据用户消息，为团队成员分配各自要做的任务。

【团队成员】
${roster}

【用户消息】
${message}
${history ? `\n【近期聊天背景】\n${String(history).slice(0, 2000)}` : ''}

要求：
1. 只给与消息相关的成员分配具体任务；无关成员 task 留空字符串（本轮旁听，不发言不干活）
2. 任务描述具体到该成员能直接开工，明确各自负责的部分、边界与期望产出
3. 数组按执行先后顺序排列：产出被他人依赖的成员排在前，依赖他人产出的排在后（如：先调研 → 再实现 → 后成稿）
4. 只输出 JSON 数组，禁止任何其他文字：[{"id":"成员id","task":"任务描述"}]
名单内每个成员必须且只能出现一次。`;
  const plannerMod = require('./planner');
  const { content, error } = await plannerMod.runOnce(prompt, dividePlanTimeout(), 'divide-plan');
  if (error && !content) throw new Error(error);
  if (!content) throw new Error('分工调用无输出');
  const { extractJSONArray } = require('./teamgen');
  const arr = extractJSONArray(content);
  if (!Array.isArray(arr)) throw new Error('分工结果解析失败');
  const byKey = new Map();
  for (const a of participants) { byKey.set(a.id, a); byKey.set(a.name, a); }
  const plan = participants.map(a => ({ agent: a, task: '' }));
  const seen = new Set();
  for (const it of arr) {
    const ag = byKey.get(String(it && it.id || '').trim());
    if (ag && !seen.has(ag.id)) {
      seen.add(ag.id);
      plan.find(p => p.agent.id === ag.id).task = String(it.task || '').slice(0, 4000);
    }
  }
  return plan;
}

// ---------- 分工各轮 prompt 组装（内核 --no-session 单轮执行，每段工作必须自包含背景） ----------

// 初始轮：任务 + 协作协议（可请求输入也可指派任务，由成员按情况自主调度协作）
function divideWorkCtx(task) {
  return `${task}

【协作协议】
- 你与名单内其他成员并行工作，各自负责分工表任务
- 执行中可向任何一位同事发起协作，在产出末尾另起一行写：@同事名：协作请求。系统会转达给对方，其回应会带回给你，你将在收到后继续完成工作
- 协作请求分两类：①请求输入——请对方提供数据/结论/评审；②指派任务——请对方完成某项具体工作并交付结果（写清任务内容、要求与交付形式）
- 由你根据工作需要自主决定找谁、协作什么；请求要具体明确（对方无需猜测）。除必要协作外请独立完成并给出结论`;
}

// 唤醒轮：初始任务 + 上轮产出 + 同事反馈（反馈到齐或因上限无反馈后的继续）
function divideWakeupCtx(task, parentOutput, collected, forced) {
  const base = (task ? `【你的初始任务】\n${task}\n\n` : '')
    + `【你上一轮的工作产出】\n${String(parentOutput || '').slice(0, 4000)}\n\n`;
  if (forced) {
    return base + `【协作状态】\n你此前 @ 的同事因参与上限无法再响应。\n\n请基于已有信息直接给出最终回答，不要再 @ 同事。`;
  }
  return base + `【同事的反馈】\n${collected.map(c => `【${c.name}】\n${c.output}`).join('\n\n')}\n\n请基于以上反馈继续完成你的任务并给出结论；若确需其他同事支持（要数据或指派新任务），可在产出末尾另起一行 @同事名 提出请求。`;
}

// 响应轮：同事协作请求汇总 + 自己最近产出（供引用）；请求输入直接给、指派任务完整执行
function divideResponseCtx(requests, ownLastOutput) {
  const reqs = requests.map(r => `【${r.name} 的请求背景与产出】\n${String(r.text || '').slice(0, 2000)}`).join('\n\n');
  return `以下同事在分工协作中向你发起协作请求：

${reqs}
${ownLastOutput ? `\n【你最近的工作产出（可直接引用其中内容）】\n${String(ownLastOutput).slice(0, 2000)}\n` : ''}
请按请求性质逐条处理：
- 请求输入的：直接提供对方所需的数据、结论或建议
- 指派任务的：完整执行该项工作并交付结果（可使用工具、产出文件，把成果讲清楚）
若确实无法完成，说明原因并给出替代建议。不要重复执行对方的全量任务，只处理其请求的部分。`;
}

// 调度核心（execFn 注入便于单测）：初始任务并行 → @ 传导 → 结果回灌唤醒 → 上限止停
// 真实工作语义：
// - 成员干活时 @ 同事 = 请求支持，自己暂停等待；请求会转达给对方
// - 对方若手头有活，先完成手头活，再针对请求专门响应一轮（不拿无关产出搪塞）
// - 同批多人请求同一人时合并为一轮响应（一封信回多人）
// - 反馈到齐后请求者被唤醒，带着初始任务+反馈继续，直至给出最终回答
// - 传导深度（跳数）与总段数有硬上限；达上限后当事人仍可收尾（收尾轮不再传导）
async function runDivideCore(plan, opts, emit, onMessage, execFn) {
  const taskId = opts.taskId || '';
  const isStopped = opts.isStopped || (() => false);
  const members = Array.isArray(opts.participants) && opts.participants.length
    ? opts.participants : plan.map(p => p.agent); // 传导 @ 生效名单（含旁听成员）
  const memberAgent = (id) => members.find(m => m.id === id) || (plan.find(p => p.agent.id === id) || {}).agent;
  const memberName = (id) => { const a = memberAgent(id); return a ? a.name : id; };
  const taskOf = (id) => { const p = plan.find(x => x.agent.id === id); return p ? p.task : ''; };
  const rosterText = `📋 分工表\n${plan.map(p => `- ${p.agent.icon || ''}${p.agent.name}：${p.task || '（本轮旁听）'}`).join('\n')}`;
  emit({ type: 'notice', content: rosterText, taskId });
  // 结构化分工表（有序）：前端据此按序预建成员气泡占位，产出消息按分工顺序稳定排列（并行执行完成顺序不影响显示顺序）
  emit({
    type: 'divide_plan', taskId,
    plan: plan.filter(p => p.task).map(p => ({ id: p.agent.id, name: p.agent.name, icon: p.agent.icon || '', task: p.task }))
  });
  onMessage({ role: 'sys', phase: 'divide', content: rosterText });
  let total = 0;
  let capNoticed = false;
  const capNotice = () => {
    if (capNoticed) return;
    capNoticed = true;
    emit({ type: 'notice', content: `⚠ 已达分工参与上限（${DIVIDE_MAX_WORK} 段 / ${DIVIDE_MAX_HOP} 跳传导），后续 @ 传导停止`, taskId });
  };
  const waiters = new Map();   // 请求者 id → {expect:Set(被@者id), collected:[], parentOutput, hop, forced}
  const pending = new Map();   // 被请求者 id → Set(请求者 id)：待其响应的请求
  const responding = new Map(); // 被请求者 id → Set(请求者 id)：本轮响应正服务的对象
  const inflight = new Set();  // 已入队未完成的成员 id（防重复调度）
  const lastOutput = new Map(); // 成员 id → 最近一次产出（响应轮供引用）
  const outputs = [];
  let ok = false;
  const queue = [];
  const enqueue = (item) => {
    // 收尾轮（final）豁免跳数上限：传导停止后当事人必须能交差；总段数上限两者都管
    if (total >= DIVIDE_MAX_WORK || (!item.final && item.hop > DIVIDE_MAX_HOP)) { capNotice(); return false; }
    total++;
    inflight.add(item.agent.id);
    queue.push(item);
    return true;
  };
  // 回灌：把某成员的产出交给等待它的请求者；请求全部到齐（或因上限强制了结）则唤醒请求者继续
  const feed = (waiterId, memberName_, memberId, contentText, forced) => {
    const st = waiters.get(waiterId);
    if (!st) return;
    st.expect.delete(memberId);
    st.collected.push({ name: memberName_, output: contentText });
    if (forced) st.forced = true;
    if (st.expect.size > 0) return;
    waiters.delete(waiterId);
    const agent = memberAgent(waiterId);
    if (!agent) return;
    const ctx = divideWakeupCtx(taskOf(waiterId), st.parentOutput, st.collected, st.forced);
    const enq = enqueue({ agent, hop: st.hop + 1, wakeUp: '', final: st.forced, context: ctx });
    if (!enq) emit({ type: 'notice', content: `⚠ ${agent.name} 因参与上限未能完成收尾`, taskId });
  };
  let initialCapped = false;
  for (const p of plan) {
    if (!p.task) continue;
    if (total >= DIVIDE_MAX_WORK) { initialCapped = true; break; }
    queue.push({ agent: p.agent, context: divideWorkCtx(p.task), hop: 0, wakeUp: '', final: false });
    inflight.add(p.agent.id);
    total++;
  }
  if (initialCapped) capNotice();
  while (queue.length) {
    if (isStopped()) break;
    const batch = queue.splice(0);
    const outcomes = await Promise.all(batch.map(async (item) => {
      const out = await execFn(item);
      // 兜底合并：execFn 未回显的调度字段按入队值补齐（hop/wakeUp/final 属 core 状态）
      const merged = Object.assign({ hop: item.hop, wakeUp: item.wakeUp || '', final: !!item.final }, out);
      return { item, out: merged };
    }));
    for (const { item, out } of outcomes) {
      // handoff 转交后产出归属可能变为 finalAgent：入队键与归属键都需释放
      inflight.delete(item.agent.id);
      inflight.delete(out.agent.id);
      const content = out.error ? `[执行出错] ${out.error}` : String(out.output || '');
      onMessage({
        role: 'assistant', agentId: out.agent.id, agentName: out.agent.name,
        actor: 'assistant', phase: 'divide', content: content.slice(0, 20000), outputPath: out.outputPath || ''
      });
      if (out.output) { ok = true; outputs.push(content); }
      // 产出归档以调度对象为准（handoff 转交后仍视为该成员的产出，供后续响应轮引用）
      lastOutput.set(item.agent.id, content);
      // 1) 响应轮完成：产出回灌本轮服务的请求者（一次响应服务多人）
      if (out.wakeUp === 'pending') {
        const served = responding.get(item.agent.id) || new Set();
        responding.delete(item.agent.id);
        for (const w of served) feed(w, out.agent.name, item.agent.id, content);
      }
      // 2) 传导：本产出中的 @ 转达为协作请求（收尾轮不再发起；等待反馈中的成员暂不接受新请求）
      if (out.output && !out.final && !isStopped()) {
        const all = divideMentions(out.output, members).filter(m => m.id !== out.agent.id);
        const targets = all.filter(m => !waiters.has(m.id));
        const waiting = all.filter(m => waiters.has(m.id));
        if (waiting.length) {
          emit({ type: 'notice', content: `${waiting.map(m => m.name).join('、')} 正在等待反馈，${out.agent.name} 的 @ 请求暂缓，待其下一轮工作再提出`, taskId });
        }
        if (targets.length) {
          waiters.set(out.agent.id, {
            expect: new Set(targets.map(t => t.id)), collected: [],
            parentOutput: content, hop: out.hop || 0, forced: false
          });
          for (const m of targets) {
            if (!pending.has(m.id)) pending.set(m.id, new Set());
            pending.get(m.id).add(out.agent.id);
          }
        }
      }
    }
    // 批末统一调度响应轮：同批多人请求同一人时合并为一轮（请求汇总进同一段 prompt）
    if (isStopped()) continue;
    for (const [mid, set] of [...pending]) {
      if (!set.size) { pending.delete(mid); continue; }
      if (inflight.has(mid)) continue; // 手头有活：待其完成后由下个批末扫描处理
      const agent = memberAgent(mid);
      if (!agent) { pending.delete(mid); continue; }
      const list = [...set];
      pending.delete(mid);
      responding.set(mid, new Set(list));
      const reqHop = Math.max(...list.map(w => ((waiters.get(w) || {}).hop ?? -1) + 1));
      const ctx = divideResponseCtx(
        list.map(w => ({ name: memberName(w), text: (waiters.get(w) || {}).parentOutput || '' })),
        lastOutput.get(mid) || ''
      );
      const okEnq = enqueue({ agent, hop: reqHop, wakeUp: 'pending', final: false, context: ctx });
      if (!okEnq) {
        // 上限拒绝：以占位反馈了结请求者，使其仍能收尾
        responding.delete(mid);
        for (const w of list) feed(w, agent.name, mid, '[参与上限] 该同事因编排上限无法响应，请基于已有信息继续', true);
      }
    }
  }
  if (isStopped()) emit({ type: 'notice', content: '已手动停止，分工编排终止', taskId });
  for (const [id, st] of waiters) {
    const a = memberAgent(id);
    emit({
      type: 'notice', taskId,
      content: `⚠ ${a ? a.name : id} 等待的同事反馈因编排结束而中止（${[...st.expect].map(memberName).join('、')} 未回应）`
    });
  }
  return { ok, finalText: outputs.join('\n\n'), stopped: isStopped() };
}

// 分工模式入口：分工调用 → 降级兜底 → 分工表落库 → 调度执行
async function runDivide(participants, message, opts, emit, onMessage) {
  const taskId = opts.taskId || '';
  const runId = newRunId();
  logFlow({
    run: runId, type: 'start', from: '用户',
    summary: String(message).replace(/\s+/g, ' ').slice(0, 200),
    detail: { taskId, mode: 'divide', members: participants.map(a => a.name) }
  });
  emit({ type: 'notice', content: `🤝 分工模式：正在为 ${participants.length} 位成员分工…`, taskId });
  let plan;
  try {
    plan = await dividePlan(participants, message, opts.history);
    if (!plan.some(p => p.task)) {
      emit({ type: 'notice', content: '⚠ 分工结果为空，已降级为全员并行执行', taskId });
      plan = participants.map(a => ({ agent: a, task: message }));
    }
  } catch (e) {
    emit({ type: 'notice', content: `⚠ 分工调用失败（${e && e.message || e}），已降级为全员并行执行`, taskId });
    plan = participants.map(a => ({ agent: a, task: message }));
  }
  const isStopped = opts.isStopped || (() => false);
  // 成员 opencode 会话（工作记忆）：同一聊天会话内跨轮次续用，成员记得自己此前所有工作
  const taskKey = taskId || 'main';
  let prevSessions = {};
  try { prevSessions = storeRef.getDivideSessionMap(taskKey) || {}; } catch { prevSessions = {}; }
  const ocSessions = new Map(Object.entries(prevSessions));
  const execFn = async (item) => {
    const sessionDir = sessionOutDir(taskId);
    const agent = Object.assign({}, item.agent, { model: '' }); // 分工模式统一默认模型
    const prompt = item.hop === 0
      ? appendWorkContext(item.context, [], opts.history)
      : item.context;
    const { agent: finalAgent, res } = await runWithHandoff(
      agent, prompt, participants, opts, emit, 'divide',
      item.agent.id === 'butler' ? 'butler' : 'worker', taskId, sessionDir, opts.scope || 'chat', isStopped, ocSessions
    );
    return {
      agent: finalAgent, output: res.output, error: res.error, outputPath: res.outputPath,
      hop: item.hop, wakeUp: item.wakeUp || '', final: !!item.final
    };
  };
  const r = await runDivideCore(plan, Object.assign({}, opts, { participants }), emit, onMessage, execFn);
  // 会话落盘：即使中途停止也保留已建立的会话，下条消息继续时工作记忆仍在
  try {
    if (ocSessions.size) storeRef.saveDivideSessions(taskKey, Object.fromEntries(ocSessions));
  } catch { /* 落盘失败不影响编排结果 */ }
  logFlow({
    run: runId, type: 'finish', from: '分工',
    summary: (r.ok ? '完成' : '无产出') + (r.stopped ? '（手动停止）' : ''),
    detail: { mode: 'divide' }
  });
  return r;
}

module.exports = {
  runButler, runMentioned, runRoundtable, runDivide, runTasks, prepareRerun, runAutoChecks,
  // 测试导出（单测用，业务代码请勿依赖）
  testDividePlan: dividePlan, testRunDivideCore: runDivideCore, testDivideMentions: divideMentions,
  DIVIDE_MAX_WORK, DIVIDE_MAX_HOP,
  // 测试导出（单测用，业务代码请勿依赖）
  testBoardInit: boardInit, testBoardAppend: boardAppend, testBoardRead: boardRead,
  testExtractBoardNote: extractBoardNote, testParseHandoff: parseHandoff,
  testApprovalGate: approvalGate,
  testExtractPlanJSON: extractPlanJSON, testResolveAgentRef: resolveAgentRef,
  testSplitByDependency: splitByDependency, testNormalizePhases: normalizePhases
};
