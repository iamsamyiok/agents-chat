// 数据存储：纯 JSON 文件，零依赖
// 文件位于数据目录（默认 <root>/.data），任务与消息持久化
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const DATA_DIR = process.env.AGENTS_CHAT_DATA || path.join(ROOT, '.data');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const TASKS_PATH = path.join(DATA_DIR, 'tasks.json');
const MESSAGES_PATH = path.join(DATA_DIR, 'messages.json');
const MEMORY_PATH = path.join(DATA_DIR, 'memory.json');

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  ensureDir();
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

// ---------- 内置管家智能体（不可修改、不可删除，始终置顶） ----------
const BUTLER = {
  id: 'butler',
  name: '管家',
  locked: true,
  behavior: 'butler', // 仅演示模式生效
  model: '',
  icon: '🎩',
  desc: '内置调度智能体：理解需求、拆解任务、调度子智能体并行/串行执行并汇总交付',
  systemPrompt: '你是「管家」，Agents 群聊的内置总调度。用户未点名智能体的消息由你负责：理解需求、制定调度方案、指挥子智能体完成工作并向用户汇总交付。最终交付时先给出简明的结果概要，如有成果文件必须明确告知完整路径。与用户沟通使用简体中文，简洁、专业、有进展感。'
};

// ---------- 默认配置 ----------
// 统一 OpenCode 内核；每个实例 = persona + model + 独立会话
// behavior 仅在演示模式（AGENTS_CHAT_MOCK=1）下生效
function defaultConfig() {
  return {
    defaultAgent: '',
    globalCwd: '',
    kernel: 'auto', // 执行内核：'auto' 按检测顺序自动，或 opencode/claude/codex/pi
    agents: [
      BUTLER,
      {
        id: 'ag-eng',
        name: '工程师',
        behavior: 'worker-good',
        model: '',
        icon: '🧑‍💻',
        desc: '软件开发：写代码、修 bug、重构、技术方案评估',
        systemPrompt: '你是资深软件工程师。直接给出可靠的实现方案与代码，结果需可直接使用。用中文回复。'
      },
      {
        id: 'ag-rs',
        name: '研究员',
        behavior: 'echo',
        model: '',
        icon: '🔍',
        desc: '信息检索：联网查资料、阅读文件、调研并汇总要点',
        systemPrompt: '你是信息研究员。善于联网检索、阅读文件并汇总要点，结论需注明依据。用中文回复。'
      },
      {
        id: 'ag-wr',
        name: '文案',
        behavior: 'echo',
        model: '',
        icon: '✍️',
        desc: '文字工作：文章、报告、翻译、润色',
        systemPrompt: '你是专业写手。文字流畅、结构清晰、符合中文表达习惯。用中文回复。'
      }
    ]
  };
}

function getConfig() {
  let cfg = readJson(CONFIG_PATH, null);
  if (!cfg || !Array.isArray(cfg.agents)) {
    cfg = defaultConfig();
    writeJson(CONFIG_PATH, cfg);
  }
  // 管家始终置顶且使用内置定义（保证内置人设更新后自动生效）
  cfg.agents = [BUTLER, ...cfg.agents.filter(a => a && a.id !== 'butler')];
  cfg.defaultAgent = ''; // 已废弃：未点名消息一律由管家调度，兼容旧配置强制清空
  return cfg;
}

function saveConfig(cfg) {
  writeJson(CONFIG_PATH, cfg);
}

// 保存用户自定义的子智能体列表 + 全局统一工作目录 + 执行内核（管家由内置定义补充，不接受传入）
// 基于现有配置增量合并，保留 schedEnabled 等其他字段不被覆盖丢失
function saveAgents(userAgents, globalCwd, kernel) {
  const cfg = getConfig();
  saveConfig({
    ...cfg,
    defaultAgent: '',
    globalCwd: globalCwd !== undefined ? globalCwd : (cfg.globalCwd || ''),
    kernel: kernel !== undefined ? kernel : (cfg.kernel || 'auto'),
    agents: [BUTLER, ...userAgents]
  });
}

// 定时任务调度总开关（配置页侧栏「启动/关闭定时任务」按钮）
function getSchedEnabled() {
  return getConfig().schedEnabled !== false;
}
function setSchedEnabled(enabled) {
  const cfg = getConfig();
  saveConfig({ ...cfg, schedEnabled: !!enabled });
}

function getAgents() {
  return getConfig().agents;
}

// ---------- 团队仓库：经典智能体团队预设，一键应用 ----------
// 取材自开源社区验证过的经典组合：
// - 软件开发团队：MetaGPT / ChatDev 的「虚拟软件公司」流水线（产品→架构→工程→测试）
// - 内容创作团队：CrewAI 内容营销经典（研究→写作→编辑）
// - 深度调研团队：CrewAI 官方 Research Crew（检索→分析报告）
// - 翻译校对团队：CrewAI 入门经典（翻译→审校）
// 应用 = 写入子智能体名单（管家仍为内置调度者，相当于团队 Supervisor）
const TEAM_PRESETS = [
  {
    id: 'software-dev',
    name: '软件开发团队',
    icon: '🏗️',
    source: 'MetaGPT / ChatDev「虚拟软件公司」',
    desc: '从一句话需求到可运行软件的经典流水线：产品经理写需求文档，架构师做系统设计，工程师编码实现，测试工程师验收把关。适合做工具、脚本、小型应用。',
    usage: '例：「帮我做一个记账小工具」',
    agents: [
      {
        name: '产品经理', icon: '🧭',
        desc: '需求分析：把想法变成结构化需求文档（PRD）',
        systemPrompt: '你是资深产品经理。把用户需求转化为清晰的需求文档：目标用户、核心功能列表（按优先级）、每个功能的用户故事与验收标准、边界与约束。输出结构化、可执行的 PRD，不做技术设计。善于向用户澄清模糊需求。用中文回复。'
      },
      {
        name: '架构师', icon: '📐',
        desc: '系统设计：技术选型、模块划分、接口与数据结构',
        systemPrompt: '你是资深软件架构师。基于需求文档做系统设计：技术选型（优先简单成熟方案）、模块划分、核心接口定义、数据结构、目录结构与关键实现思路。设计要具体到工程师可直接照做，避免空泛。用中文回复。'
      },
      {
        name: '工程师', icon: '🧑‍💻',
        desc: '编码实现：写出可直接运行的完整代码并调试',
        systemPrompt: '你是资深软件工程师。按照系统设计编写完整、可直接运行的代码：文件路径清晰、依赖最小化、关键逻辑有注释、边界情况有处理。遇到报错要实际调试修复而非绕过，交付前自行检查代码可运行。用中文说明实现要点。'
      },
      {
        name: '测试工程师', icon: '🧪',
        desc: '质量把关：写测试用例、执行测试、找缺陷',
        systemPrompt: '你是资深测试工程师。基于需求与实现编写测试用例（正常路径、边界、异常），实际执行测试并如实报告结果，不放过任何缺陷；发现的问题给出最小复现步骤与修复建议。验收结论必须基于事实而非自述。用中文回复。'
      }
    ]
  },
  {
    id: 'content-studio',
    name: '内容创作团队',
    icon: '✍️',
    source: 'CrewAI 内容营销经典组合',
    desc: '专业内容生产流水线：研究员收集素材与事实，作家撰写初稿，编辑审校润色与核查。适合公众号文章、营销文案、深度稿件、报告行文。',
    usage: '例：「写一篇关于远程办公利弊的文章」',
    agents: [
      {
        name: '研究员', icon: '🔍',
        desc: '素材收集：检索资料、核实事实、整理要点',
        systemPrompt: '你是信息研究员。围绕写作主题收集素材：核心事实与数据（注明来源）、正反方观点、典型案例、金句素材。输出结构化的素材清单供写作使用，事实必须核实，不确定的明确标注。用中文回复。'
      },
      {
        name: '作家', icon: '✍️',
        desc: '初稿撰写：结构清晰、有观点、有文采的成稿',
        systemPrompt: '你是专业作家。基于研究员的素材撰写成稿：抓人的开头、清晰的段落结构、明确的观点立场、有力的结尾。字数符合要求，风格适配目标读者，素材用得自然而不堆砌。用中文写作。'
      },
      {
        name: '编辑', icon: '📖',
        desc: '审校把关：事实核查、逻辑梳理、文字润色',
        systemPrompt: '你是资深编辑。对初稿做三件事：核查事实（数据、引述是否有依据）、梳理逻辑（结构、论证是否自洽）、润色文字（去冗余、改病句、统一术语与风格）。输出修改后的终稿并简要说明主要改动。用中文回复。'
      }
    ]
  },
  {
    id: 'research-crew',
    name: '深度调研团队',
    icon: '🔍',
    source: 'CrewAI 官方 Research Crew',
    desc: '两步调研法：研究员全面检索收集，分析师综合研判输出报告（摘要/洞察/趋势/建议）。适合技术选型、行业分析、竞品对比、决策支持。',
    usage: '例：「调研 2026 年主流前端框架该怎么选」',
    agents: [
      {
        name: '研究员', icon: '🔍',
        desc: '全面检索：多来源收集信息并交叉验证',
        systemPrompt: '你是信息研究员。对调研主题做全面检索：现状、主流方案/观点、关键数据、优劣势对比、近期变化。多来源交叉验证，每个结论标注依据来源，冲突信息如实呈现。输出结构化的调研材料。用中文回复。'
      },
      {
        name: '分析师', icon: '📊',
        desc: '综合研判：把材料提炼成有结论的分析报告',
        systemPrompt: '你是资深分析师。基于调研材料输出专业分析报告：执行摘要（3~5 句）、关键发现（编号列出）、趋势判断、风险提示、明确可执行的建议（含适用条件）。有数据用数据，没数据不编造，结论要敢下但注明置信度。用中文回复。'
      }
    ]
  },
  {
    id: 'translation-duo',
    name: '翻译校对团队',
    icon: '🌐',
    source: 'CrewAI 入门经典：翻译员 + 校对员',
    desc: '双人精翻组合：翻译员忠实原文完成初译，审校员核对语义、统一术语、润色表达。适合文档、合同、论文等对准确性要求高的文本。',
    usage: '例：「把这段产品介绍翻译成英文：<粘贴文本>」',
    agents: [
      {
        name: '翻译员', icon: '🌐',
        desc: '初译：忠实原文、保留术语、格式对应',
        systemPrompt: '你是专业译者。忠实翻译原文：不增删信息、专有名词查证后翻译并首次出现附原文、保持原文格式（段落/列表/代码块）。译不出把握的句子标注疑问而非硬翻。目标语言按任务要求，默认中英互译。'
      },
      {
        name: '审校员', icon: '⚖️',
        desc: '审校：语义核对、术语统一、表达润色',
        systemPrompt: '你是资深审校。逐句核对译文与原文语义是否一致，检查术语前后统一、数字单位准确、语句地道自然。输出终稿，并附「审校说明」：术语表、主要改动点、存疑处。用中文说明，译文保持目标语言。'
      }
    ]
  }
];

function getTeamPresets() {
  return TEAM_PRESETS;
}

// ---------- 任务列表 ----------
// seq 决定执行/显示顺序（拖拽可改）；createdAt 仅用于展示时间
// assign：任务末尾 @智能体 指派（agentId）；空 = 管家调度；子智能体 = 独立完成
function getTasks() {
  const tasks = readJson(TASKS_PATH, []);
  return tasks.slice().sort((a, b) => {
    const sa = a.seq === undefined ? Number.MAX_SAFE_INTEGER : a.seq;
    const sb = b.seq === undefined ? Number.MAX_SAFE_INTEGER : b.seq;
    return sa === sb ? a.createdAt - b.createdAt : sa - sb;
  });
}

function saveTasks(tasks) {
  writeJson(TASKS_PATH, tasks);
}

// 从文本提取任务：
// mode='sequential'（顺序任务）：每行一个任务，仅支持「1.」编号格式，行末可 @智能体 指派
// mode='scheduled'（定时任务）：行首时间 = 定时启动时间，
//   支持完整日期（20260818-1307 / 2026-08-18 13:07）与当天时刻（13:07），行末可 @智能体
// 返回 {tasks, warnings}
function parseTasksFromText(text, mode) {
  mode = mode === 'scheduled' ? 'scheduled' : 'sequential';
  const now = new Date();
  const baseTs = now.getTime();
  const parsed = [];
  const warnings = [];
  const agents = getAgents();
  let seq = 0;
  let fallbackIdx = 0;

  const validDate = (y, mo, d, h, mi) =>
    mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && h <= 23 && mi <= 59;

  for (const rawLine of String(text || '').split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line) continue;

    // 行末 @指派
    let assign = '';
    const am = line.match(/\s*@([^\s@，。,；;]+)\s*$/);
    if (am) {
      const tok = am[1];
      line = line.slice(0, am.index).trim();
      const ag = agents.find(a => a.id === tok) || agents.find(a => a.name === tok);
      if (ag) assign = ag.id;
      else warnings.push(`@${tok} 不是已配置的智能体，任务「${line.slice(0, 20)}」将改由管家调度`);
    }

    let createdAt = null;
    let scheduledAt = null;
    let m;
    // 紧凑全日期格式：20260818-1307
    m = line.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})\s+(.*)$/);
    if (m) {
      const [y, mo, d, h, mi] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])];
      if (validDate(y, mo, d, h, mi)) {
        createdAt = scheduledAt = new Date(y, mo - 1, d, h, mi, 0, 0).getTime();
        line = m[6].trim();
      } else {
        warnings.push(`「${line.slice(0, 20)}」行首时间格式不合法（应为 20260818-1307），已按普通内容处理`);
      }
    }
    // 完整日期格式：2026-08-18 13:07[:30]
    if (createdAt === null) {
      m = line.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?\s+(.*)$/);
      if (m) {
        const dt = new Date(`${m[1]}T${String(m[2]).padStart(2, '0')}:${m[3]}:${m[4] || '00'}`);
        if (!isNaN(dt.getTime())) {
          createdAt = scheduledAt = dt.getTime();
          line = m[5].trim();
        }
      }
    }
    // 当天时刻：13:07（顺序模式仅作排序时间；定时模式作为当天定时启动时间）
    if (createdAt === null) {
      m = line.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s+(.*)$/);
      if (m) {
        const d = new Date(now);
        d.setHours(Number(m[1]), Number(m[2]), Number(m[3] || 0), 0);
        createdAt = d.getTime();
        if (mode === 'scheduled') scheduledAt = createdAt;
        line = m[4].trim();
      }
    }

    // 列表符剥离：仅「1. / 1、 / 1)」编号格式（顺序与定时模式一致）
    line = line.replace(/^(\d+[.、)])\s+/, '').trim();
    if (!line) continue;

    if (createdAt === null) {
      createdAt = baseTs + fallbackIdx * 1000;
      fallbackIdx++;
    }

    const rec = {
      id: `t-${baseTs}-${seq++}`,
      title: line.slice(0, 500),
      notes: '',
      createdAt,
      status: 'pending',
      assign,
      result: '',
      kind: mode
    };
    if (mode === 'scheduled') rec.scheduledAt = scheduledAt !== null ? scheduledAt : createdAt;
    parsed.push(rec);
  }
  return { tasks: parsed, warnings };
}

function importTasks(text, mode) {
  const { tasks: parsed, warnings } = parseTasksFromText(text, mode);
  const tasks = getTasks();
  // 若存在无 seq 的旧任务，先按现有顺序（createdAt）补齐
  let next = 0;
  for (const t of tasks) { if (t.seq === undefined) t.seq = next++; else next = Math.max(next, t.seq + 1); }
  for (const t of parsed) t.seq = next++;
  saveTasks(tasks.concat(parsed));
  return { added: parsed.length, warnings };
}

// 拖拽排序：按给定 id 顺序重编 seq（ids 应为全量，未包含的追加在末尾）
function reorderTasks(ids) {
  const sorted = getTasks();
  const order = [];
  const seen = new Set();
  for (const id of ids) { const t = sorted.find(x => x.id === id); if (t && !seen.has(id)) { order.push(t); seen.add(id); } }
  for (const t of sorted) if (!seen.has(t.id)) order.push(t);
  order.forEach((t, i) => { t.seq = i; });
  saveTasks(order);
}

// 删除任务及其会话消息
function deleteTask(id) {
  saveTasks(getTasks().filter(t => t.id !== id));
  writeJson(MESSAGES_PATH, readJson(MESSAGES_PATH, []).filter(m => (m.taskId || '') !== id));
  return true;
}

function updateTask(id, patch) {
  const tasks = getTasks();
  const t = tasks.find(x => x.id === id);
  if (!t) return null;
  Object.assign(t, patch);
  saveTasks(tasks);
  return t;
}

// 孤儿状态修复：服务异常退出后仍标记 running 的任务复位为待执行
// 启动与退出时调用，避免任务永远卡在「执行中」
function resetRunningTasks() {
  const tasks = getTasks();
  let n = 0;
  for (const t of tasks) {
    if (t.status === 'running') { t.status = 'pending'; t.result = '服务重启，已复位为待执行'; n++; }
  }
  if (n > 0) saveTasks(tasks);
  return n;
}

function getTask(id) {
  return getTasks().find(x => x.id === id) || null;
}

// ---------- 消息 ----------
// taskId 为空 = 主会话；否则属于对应任务会话（每个任务一个独立会话）
function getMessages(taskId) {
  const msgs = readJson(MESSAGES_PATH, []);
  if (taskId === undefined) return msgs;
  return msgs.filter(m => (m.taskId || '') === taskId);
}

function addMessage(msg) {
  const msgs = readJson(MESSAGES_PATH, []);
  // 主会话消息记录所属 epoch：新会话开启后，旧 epoch 消息不再传入上下文
  const rec = {
    id: msg.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role: msg.role,
    content: msg.content,
    agentId: msg.agentId || '',
    agentName: msg.agentName || '',
    phase: msg.phase || '',
    actor: msg.actor || '',
    taskId: msg.taskId || '',
    plan: msg.plan || undefined,
    outputPath: msg.outputPath || '',
    epoch: msg.taskId ? undefined : (msg.epoch !== undefined ? msg.epoch : (Number(getConfig().mainEpoch) || 0)),
    timestamp: msg.timestamp || new Date().toISOString()
  };
  msgs.push(rec);
  writeJson(MESSAGES_PATH, msgs);
}

function clearMessages() {
  writeJson(MESSAGES_PATH, []);
}

// ---------- 流转日志（智能体之间的派发/交接/返工/验收事件，append-only） ----------
// 供「🔭 流转」页面绘制泳道时间线：谁在何时把什么信息交给了谁
const FLOW_PATH = path.join(DATA_DIR, 'flow.jsonl');

function addFlowEvent(ev) {
  try {
    ensureDir();
    const rec = {
      t: ev.t || new Date().toISOString(),
      run: String(ev.run || '').slice(0, 60),
      type: String(ev.type || ''),       // start|plan|dispatch|done|handoff|rework|verify|finish
      from: String(ev.from || '').slice(0, 40),
      to: String(ev.to || '').slice(0, 40),
      stage: Number(ev.stage) || 0,
      round: Number(ev.round) || 0,
      summary: String(ev.summary || '').slice(0, 400),
      files: Array.isArray(ev.files) ? ev.files.slice(0, 20).map(f => String(f).slice(0, 300)) : [],
      detail: ev.detail && typeof ev.detail === 'object' ? ev.detail : {}
    };
    fs.appendFileSync(FLOW_PATH, JSON.stringify(rec) + '\n', 'utf8');
    return rec;
  } catch { return null; }
}

function readFlowAll() {
  try {
    return fs.readFileSync(FLOW_PATH, 'utf8').split('\n').filter(Boolean).map(l => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

// 单次编排的全部事件（按时间序）
function getFlow(runId) {
  return readFlowAll().filter(e => e.run === runId);
}

// 最近编排列表：run id 去重 + 元信息（开始时间/事件数/参与者/是否结束）
function listFlowRuns(limit) {
  const all = readFlowAll();
  const map = new Map(); // run -> 元信息
  for (const e of all) {
    let r = map.get(e.run);
    if (!r) { r = { run: e.run, start: e.t, end: '', events: 0, agents: new Set(), finished: false, summary: '' }; map.set(e.run, r); }
    r.events++;
    r.end = e.t;
    if (e.from) r.agents.add(e.from);
    if (e.to) r.agents.add(e.to);
    if (e.type === 'finish') { r.finished = true; r.summary = e.summary; }
    if (e.type === 'start' && !r.summary) r.summary = e.summary;
  }
  return [...map.values()]
    .sort((a, b) => (a.start < b.start ? 1 : -1))
    .slice(0, limit || 30)
    .map(r => ({ ...r, agents: [...r.agents] }));
}

// ---------- 管家长期记忆（跨会话偏好与教训，读写由 memory.js 负责） ----------
function getMemoryData() {
  const d = readJson(MEMORY_PATH, null);
  return {
    memory: Array.isArray(d && d.memory) ? d.memory.map(s => String(s)).filter(Boolean) : [],
    user: Array.isArray(d && d.user) ? d.user.map(s => String(s)).filter(Boolean) : []
  };
}
function saveMemoryData(data) {
  writeJson(MEMORY_PATH, {
    memory: Array.isArray(data.memory) ? data.memory.map(String) : [],
    user: Array.isArray(data.user) ? data.user.map(String) : []
  });
}

module.exports = {
  DATA_DIR,
  BUTLER,
  getConfig,
  saveConfig,
  saveAgents,
  getSchedEnabled,
  setSchedEnabled,
  getMemoryData,
  saveMemoryData,
  getAgents,
  getTeamPresets,
  getTasks,
  saveTasks,
  importTasks,
  reorderTasks,
  deleteTask,
  updateTask,
  resetRunningTasks,
  getTask,
  parseTasksFromText,
  getMessages,
  addMessage,
  clearMessages,
  addFlowEvent,
  getFlow,
  listFlowRuns
};
