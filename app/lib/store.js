// 数据存储：纯 JSON 文件，零依赖
// 文件位于数据目录（默认 <root>/.data），任务与消息持久化
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const DATA_DIR = process.env.AGENTS_CHAT_DATA || path.join(ROOT, '.data');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const TASKS_PATH = path.join(DATA_DIR, 'tasks.json');
const MESSAGES_PATH = path.join(DATA_DIR, 'messages.json');

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
  desc: '内置调度智能体：理解需求、拆解任务、调度子智能体并行/串行执行并汇总交付',
  systemPrompt: '你是「管家」，Agents 群聊的内置总调度。用户未点名智能体的消息由你负责：理解需求、制定调度方案、指挥子智能体完成工作并向用户汇总交付。与用户沟通使用简体中文，简洁、专业、有进展感。'
};

// ---------- 默认配置 ----------
// 统一 OpenCode 内核；每个实例 = persona + model + 独立会话
// behavior 仅在演示模式（AGENTS_CHAT_MOCK=1）下生效
function defaultConfig() {
  return {
    defaultAgent: '',
    agents: [
      BUTLER,
      {
        id: 'ag-eng',
        name: '工程师',
        behavior: 'worker-good',
        model: '',
        desc: '软件开发：写代码、修 bug、重构、技术方案评估',
        systemPrompt: '你是资深软件工程师。直接给出可靠的实现方案与代码，结果需可直接使用。用中文回复。'
      },
      {
        id: 'ag-rs',
        name: '研究员',
        behavior: 'echo',
        model: '',
        desc: '信息检索：联网查资料、阅读文件、调研并汇总要点',
        systemPrompt: '你是信息研究员。善于联网检索、阅读文件并汇总要点，结论需注明依据。用中文回复。'
      },
      {
        id: 'ag-wr',
        name: '文案',
        behavior: 'echo',
        model: '',
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

// 保存用户自定义的子智能体列表（管家由内置定义补充，不接受传入）
function saveAgents(userAgents) {
  saveConfig({ defaultAgent: '', agents: [BUTLER, ...userAgents] });
}

function getAgents() {
  return getConfig().agents;
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
// - 每个非空行一个任务，支持行首时间与列表符
// - 行末可周 @智能体名称/id 指派（如「10:30 写周报 @文案」），不识别则由管家调度
// 返回 {tasks, warnings}
function parseTasksFromText(text) {
  const now = new Date();
  const baseTs = now.getTime();
  const parsed = [];
  const warnings = [];
  const agents = getAgents();
  let seq = 0;
  let fallbackIdx = 0;

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
    let m = line.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?\s+(.*)$/);
    if (m) {
      createdAt = new Date(`${m[1]}T${String(m[2]).padStart(2, '0')}:${m[3]}:${m[4] || '00'}`).getTime();
      line = m[5].trim();
    } else {
      m = line.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s+(.*)$/);
      if (m) {
        const d = new Date(now);
        d.setHours(Number(m[1]), Number(m[2]), Number(m[3] || 0), 0);
        createdAt = d.getTime();
        line = m[4].trim();
      }
    }

    line = line.replace(/^\[[ xX]\]\s*/, '').replace(/^([-*•]|\d+[.、)])\s+/, '').trim();
    if (!line) continue;

    if (createdAt === null) {
      createdAt = baseTs + fallbackIdx * 1000;
      fallbackIdx++;
    }

    parsed.push({
      id: `t-${baseTs}-${seq++}`,
      title: line.slice(0, 500),
      notes: '',
      createdAt,
      status: 'pending',
      assign,
      result: ''
    });
  }
  return { tasks: parsed, warnings };
}

function importTasks(text) {
  const { tasks: parsed, warnings } = parseTasksFromText(text);
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
    epoch: msg.taskId ? undefined : (msg.epoch !== undefined ? msg.epoch : (Number(getConfig().mainEpoch) || 0)),
    timestamp: msg.timestamp || new Date().toISOString()
  };
  msgs.push(rec);
  writeJson(MESSAGES_PATH, msgs);
}

function clearMessages() {
  writeJson(MESSAGES_PATH, []);
}

module.exports = {
  DATA_DIR,
  BUTLER,
  getConfig,
  saveConfig,
  saveAgents,
  getAgents,
  getTasks,
  saveTasks,
  importTasks,
  reorderTasks,
  deleteTask,
  updateTask,
  getTask,
  parseTasksFromText,
  getMessages,
  addMessage,
  clearMessages
};
