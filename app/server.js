// Agents Chat Portable - 零依赖 HTTP 服务
// 启动：node app/server.js [--port 3456]
const APP_VERSION = '3.11.0'; // 页面与服务端版本互检，不一致提示强刷
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

// 首先加载 .env（根目录，行为开关配置）
const { loadEnv } = require('./lib/env');
const ROOT_DIR = path.join(__dirname, '..');
loadEnv(path.join(ROOT_DIR, '.env'));

// ---------- 日志 tee：控制台输出同时写入 .data/server.log ----------
const LOG_DIR = process.env.AGENTS_CHAT_DATA || path.join(ROOT_DIR, '.data');
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch { /* ignore */ }
const LOG_PATH = path.join(LOG_DIR, 'server.log');
try { fs.writeFileSync(LOG_PATH, `=== Agents Chat started ${new Date().toISOString()} ===\n`); } catch { /* ignore */ }
function teeWrite(args) {
  try { fs.appendFileSync(LOG_PATH, args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ') + '\n'); } catch { /* ignore */ }
}
const origLog = console.log.bind(console);
const origErr = console.error.bind(console);
console.log = (...args) => { origLog(...args); teeWrite(args); };
console.error = (...args) => { origErr(...args); teeWrite(args); };
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err && err.stack || err);
});
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err && (err.stack || err) || err);
});

const PORT = Number(process.argv.includes('--port') ? process.argv[process.argv.indexOf('--port') + 1] : (process.env.PORT || 3456));
const PUBLIC_DIR = path.join(__dirname, 'public');
const store = require('./lib/store');
const { runAgent, stopScope, stopAllChildren } = require('./lib/agent');
const { runButler, runMentioned, runRoundtable, runTasks, prepareRerun } = require('./lib/orchestrator');
const memoryMod = require('./lib/memory');

// ---------- 人工审批关卡：orchestrator 暂停等待用户放行（方案/交付），SSE 断线后可经 /api/approvals 恢复 ----------
const pendingApprovals = new Map(); // approvalId -> {kind,label,taskId,resolve,timer}
const APPROVAL_TIMEOUT_MS = Number(process.env.AGENTS_CHAT_APPROVAL_TIMEOUT_MS) > 0
  ? Number(process.env.AGENTS_CHAT_APPROVAL_TIMEOUT_MS) : 600000; // 默认 10 分钟未审批视为拒绝

function makeRequestApproval() {
  return (kind, label, taskId) => new Promise((resolve) => {
    const id = 'apr-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
    const timer = setTimeout(() => finishApproval(id, false, true), APPROVAL_TIMEOUT_MS);
    pendingApprovals.set(id, { kind, label, taskId: taskId || '', resolve, timer, createdAt: new Date().toISOString() });
  });
}
function finishApproval(id, approved, timedOut) {
  const a = pendingApprovals.get(id);
  if (!a) return null;
  clearTimeout(a.timer);
  pendingApprovals.delete(id);
  a.resolve(!!approved);
  return { ...a, timedOut: !!timedOut };
}
// 审批模式：'off' | 'plan'（方案后）| 'verify'（交付前）| 'all'；config.approval 优先，其次 env 默认
function approvalSetting() {
  const v = String(store.getConfig().approval || process.env.AGENTS_CHAT_APPROVAL || 'off').toLowerCase();
  return ['off', 'plan', 'verify', 'all'].includes(v) ? v : 'off';
}

// ---------- 执行互斥与停止控制 ----------
// chat / tasks 两个作用域各自单飞（防止双击或 API 直调并发执行）；
// 任务执行中仍可正常聊天，互不阻塞
const runLocks = { chat: false, tasks: false };
// 停止令牌：每次停止递增，编排循环通过对比快照感知「执行期间被要求停止」
const stopTokens = { chat: 0, tasks: 0 };

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function json(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let buf = '';
    req.on('data', (c) => { buf += c; if (buf.length > 5 * 1024 * 1024) req.destroy(); });
    req.on('end', () => {
      try { resolve(JSON.parse(buf || '{}')); } catch { resolve({}); }
    });
  });
}

function serveStatic(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
}

// SSE helper
function sse(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
  const send = (obj) => {
    try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch { /* closed */ }
  };
  // 心跳防止代理断开
  const hb = setInterval(() => {
    try { res.write(': hb\n\n'); } catch { clearInterval(hb); }
  }, 15000);
  req.on('close', () => clearInterval(hb));
  return send;
}

// ---------- @ 点名解析（支持中文名称） ----------
const MENTION_RE = /@([^\s@，。,.；;！!？?、()（）【】[\]"'「」]+)/g;

function resolveMentions(message, agents) {
  const out = [];
  const seen = new Set();
  let m;
  while ((m = MENTION_RE.exec(message)) !== null) {
    const tok = m[1];
    const ag = agents.find(a => a.id === tok) || agents.find(a => a.name === tok);
    if (ag && !seen.has(ag.id)) { seen.add(ag.id); out.push(ag); }
  }
  return out;
}

function stripMentions(message) {
  return message.replace(MENTION_RE, '').replace(/\s+/g, ' ').trim();
}

// 会话历史背景（仅保留用户消息与智能体正式产出；规划卡片、验收意见等调度过程不进入上下文）
// 主会话：只取当前 epoch（新会话开启后旧消息不再传入）
function buildHistoryText(taskId) {
  let list = store.getMessages(taskId).filter(m =>
    m.role === 'user' || (m.role === 'assistant' && (m.phase === 'work' || m.phase === 'report'))
  );
  if (!taskId) {
    const epoch = Number(store.getConfig().mainEpoch) || 0;
    list = list.filter(m => (Number(m.epoch) || 0) === epoch);
  }
  const recent = list.slice(-14);
  if (!recent.length) return '';
  return recent.map(m => `${m.role === 'user' ? '用户' : (m.agentName || '智能体')}：${String(m.content).slice(0, 1000)}`).join('\n');
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const p = parsed.pathname;

  // ---------- 静态 ----------
  if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
    serveStatic(res, path.join(PUBLIC_DIR, 'index.html'));
    return;
  }
  if (req.method === 'GET' && p.startsWith('/static/')) {
    const safe = path.normalize(p.slice('/static/'.length)).replace(/^(\.\.[/\\])+/, '');
    serveStatic(res, path.join(PUBLIC_DIR, safe));
    return;
  }

  // ---------- API ----------
  if (p === '/api/health' && req.method === 'GET') {
    const { resolveRunner, detectKernels } = require('./lib/agent');
    const runner = resolveRunner();
    const kernels = detectKernels();
    json(res, 200, {
      success: true,
      version: APP_VERSION,
      runner: runner.kind,
      kernelLabel: runner.kernel ? runner.kernel.label : '',
      kernelCmd: runner.cmd || '',
      kernels: Object.values(kernels).map(k => ({ id: k.id, label: k.label, ok: k.ok, cmd: k.cmd })),
      configKernel: String(store.getConfig().kernel || 'auto'),
      model: process.env.AGENTS_CHAT_MODEL || '',
      autoApprove: process.env.AGENTS_CHAT_AUTO_APPROVE !== '0',
      port: PORT
    });
    return;
  }

  if (p === '/api/stop' && req.method === 'POST') {
    // 手动停止：kill 对应作用域的全部子进程；编排循环检测令牌后跳过剩余工作
    const body = await readBody(req);
    const scope = body.scope === 'tasks' ? 'tasks' : 'chat';
    stopTokens[scope]++;
    const n = stopScope(scope);
    json(res, 200, { success: true, scope, stopped: n });
    return;
  }

  if (p === '/api/approvals' && req.method === 'GET') {
    // 当前等待中的审批（前端刷新/断线重连后恢复审批卡片）
    json(res, 200, {
      success: true,
      approvals: [...pendingApprovals.entries()].map(([id, a]) => ({ id, kind: a.kind, label: a.label, taskId: a.taskId, createdAt: a.createdAt }))
    });
    return;
  }

  if (p === '/api/approval' && req.method === 'POST') {
    // 审批裁决：approved=true 放行继续编排；false 终止编排
    const body = await readBody(req);
    const id = String(body.id || '');
    const a = pendingApprovals.get(id);
    if (!a) { json(res, 404, { success: false, error: '审批不存在或已处理' }); return; }
    finishApproval(id, !!body.approved, false);
    json(res, 200, { success: true, id, approved: !!body.approved });
    return;
  }

  if (p === '/api/flow/runs' && req.method === 'GET') {
    // 最近编排列表（流转视图的 run 选择器）
    json(res, 200, { success: true, runs: store.listFlowRuns(40) });
    return;
  }

  if (p === '/api/flow' && req.method === 'GET') {
    const runId = String(parsed.query.run || '').slice(0, 60);
    if (!runId) { json(res, 400, { success: false, error: '缺少 run 参数' }); return; }
    json(res, 200, { success: true, run: runId, events: store.getFlow(runId) });
    return;
  }

  if (p === '/api/flow/rerun' && req.method === 'POST') {
    // 断点重跑：从历史编排的某个阶段重新执行（前置阶段产出复用）
    // 走 chat 作用域锁（与聊天互斥）；消息写回原会话；SSE 实时回传全过程
    const body = await readBody(req);
    const runId = String(body.run || '').slice(0, 60);
    const fromStage = Number(body.fromStage) || 1;
    const events = runId ? store.getFlow(runId) : [];
    if (!events.length) { json(res, 404, { success: false, error: '编排记录不存在' }); return; }
    let prepared;
    try {
      const agentsAll = store.getAgents();
      prepared = prepareRerun(events, fromStage, agentsAll.filter(a => a.id !== 'butler'));
    } catch (err) {
      json(res, 400, { success: false, error: err && err.message || String(err) });
      return;
    }
    if (runLocks.chat) {
      json(res, 409, { success: false, error: '当前有编排进行中，请等待完成或先停止' });
      return;
    }
    runLocks.chat = true;
    const myToken = stopTokens.chat;
    const agentsAll = store.getAgents();
    const butler = agentsAll.find(a => a.id === 'butler');
    const subAgents = agentsAll.filter(a => a.id !== 'butler');
    const taskId = prepared.taskId || '';
    const opts = {
      taskId, history: buildHistoryText(taskId), scope: 'chat',
      isStopped: () => stopTokens.chat !== myToken,
      approval: approvalSetting(), requestApproval: makeRequestApproval(),
      resume: { phases: prepared.phases, priorResults: prepared.priorResults, fromStage: prepared.fromStage, baseRun: runId }
    };
    const send = sse(req, res);
    const persist = (m) => store.addMessage({ ...m, taskId, timestamp: new Date().toISOString() });
    try {
      send({ type: 'notice', content: `↻ 断点重跑：从第 ${prepared.fromStage} 阶段开始（前序 ${prepared.priorResults.length} 份产出复用）${prepared.dropped.length ? `；注意：智能体 ${prepared.dropped.join('、')} 已不存在，相关步骤被跳过` : ''}`, taskId });
      await runButler(butler, subAgents, prepared.message, opts, send, persist);
    } catch (err) {
      console.error('[flow/rerun] 编排异常:', err && (err.stack || err));
      send({ type: 'error', content: `重跑异常：${err && err.message || err}` });
    } finally {
      runLocks.chat = false;
      try { res.end(); } catch { /* closed */ }
    }
    return;
  }

  if (p === '/api/agents' && req.method === 'GET') {
    json(res, 200, { success: true, agents: store.getAgents(), butlerId: store.BUTLER.id, globalCwd: store.getConfig().globalCwd || '', kernel: String(store.getConfig().kernel || 'auto'), approval: approvalSetting() });
    return;
  }

  if (p === '/api/teams' && req.method === 'GET') {
    // 团队仓库：经典智能体团队预设（前端展示与应用）
    json(res, 200, { success: true, teams: store.getTeamPresets() });
    return;
  }

  if (p === '/api/sched' && req.method === 'GET') {
    // 定时任务调度总开关状态（侧栏「启动/关闭定时任务」按钮）
    json(res, 200, { success: true, enabled: store.getSchedEnabled() });
    return;
  }
  if (p === '/api/sched/toggle' && req.method === 'POST') {
    const body = await readBody(req);
    const enabled = !!body.enabled;
    store.setSchedEnabled(enabled);
    json(res, 200, { success: true, enabled });
    return;
  }

  if (p === '/api/memory' && req.method === 'GET') {
    // 管家长期记忆查看（含各仓字符用量）
    const data = store.getMemoryData();
    json(res, 200, {
      success: true,
      enabled: memoryMod.memoryEnabled(),
      memory: data.memory,
      user: data.user,
      usage: { memory: memoryMod.usage('memory'), user: memoryMod.usage('user') }
    });
    return;
  }
  if (p === '/api/memory' && req.method === 'POST') {
    // 手动编辑管家记忆（配置页；整体覆盖，逐条字符串）
    const body = await readBody(req);
    const data = {
      memory: (Array.isArray(body.memory) ? body.memory : []).map(s => String(s).trim()).filter(Boolean).slice(0, 50),
      user: (Array.isArray(body.user) ? body.user : []).map(s => String(s).trim()).filter(Boolean).slice(0, 50)
    };
    store.saveMemoryData(data);
    json(res, 200, { success: true, usage: { memory: memoryMod.usage('memory'), user: memoryMod.usage('user') } });
    return;
  }

  if (p === '/api/session/new' && req.method === 'POST') {
    // 开启新会话：主会话历史不再纳入上下文（聊天记录仍保留显示）
    const cfg = store.getConfig();
    cfg.mainEpoch = (Number(cfg.mainEpoch) || 0) + 1;
    store.saveConfig(cfg);
    store.addMessage({
      role: 'sys',
      content: '── 已开启新会话：此前内容不再纳入上下文 ──',
      timestamp: new Date().toISOString()
    });
    json(res, 200, { success: true, epoch: cfg.mainEpoch });
    return;
  }

  if (p === '/api/agents' && req.method === 'POST') {
    // 保存用户自定义子智能体（管家内置，不接受修改）+ 全局统一工作目录
    const body = await readBody(req);
    if (!Array.isArray(body.agents)) {
      json(res, 400, { success: false, error: 'agents 必须是数组' });
      return;
    }
    const clean = [];
    const names = new Set(['管家', 'butler']); // 保留管家名称，避免 @ 点名歧义
    const dirWarn = [];
    const isDir = (d) => { try { return fs.existsSync(d) && fs.statSync(d).isDirectory(); } catch { return false; } };
    for (const a of body.agents) {
      if (!a || typeof a !== 'object' || String(a.id || '').trim() === 'butler') continue;
      let name = String(a.name || '').replace(/\s+/g, '').slice(0, 20);
      if (!name) name = `智能体${clean.length + 1}`;
      let final = name;
      let i = 2;
      while (names.has(final)) final = `${name}${i++}`; // 名称唯一，保证 @ 点名无歧义
      names.add(final);
      clean.push({
        id: String(a.id || '').replace(/[^\w-]/g, '') || `ag-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        name: final,
        icon: String(a.icon || '').trim().slice(0, 8) || '',
        desc: String(a.desc || '').slice(0, 100),
        model: '', // 统一使用 OpenCode 默认模型配置，不接受自定义
        systemPrompt: String(a.systemPrompt || '').slice(0, 8000), // 下发任务时附加在用户提示词前
        behavior: String(a.behavior || 'echo')
      });
    }
    // 全局统一工作目录：所有智能体共用一处读写文件
    let globalCwd = String(body.globalCwd || '').trim().replace(/["']/g, '');
    if (globalCwd && !isDir(globalCwd)) {
      dirWarn.push(`统一工作目录不存在或不是文件夹：${globalCwd}，已忽略（将使用默认目录）`);
      globalCwd = '';
    }
    // 执行内核：'auto' 或注册表内的内核 id；选中未安装的内核给出警告（仍保存，运行时报错兜底）
    const { KERNEL_DEFS, detectKernels } = require('./lib/agent');
    let kernel = String(body.kernel || 'auto').trim() || 'auto';
    const kernelDef = KERNEL_DEFS.find(k => k.id === kernel);
    if (kernel !== 'auto' && !kernelDef) kernel = 'auto';
    if (kernel !== 'auto' && !detectKernels()[kernel].ok) {
      dirWarn.push(`已选择内核 ${kernelDef.label}，但本机未检测到（${kernelDef.install}），保存后任务将无法执行`);
    }
    // 审批模式（协作关卡）：off=关闭 / plan=方案后 / verify=交付前 / all=两者
    const approvalIn = String(body.approval || '').toLowerCase();
    const approval = ['off', 'plan', 'verify', 'all'].includes(approvalIn) ? approvalIn : undefined;
    store.saveAgents(clean, globalCwd, kernel, approval);
    json(res, 200, { success: true, agents: store.getAgents(), butlerId: store.BUTLER.id, globalCwd: store.getConfig().globalCwd || '', kernel: String(store.getConfig().kernel || 'auto'), approval: approvalSetting(), warnings: dirWarn });
    return;
  }

  if (p === '/api/tasks' && req.method === 'GET') {
    // 按 seq（拖拽可调）排序返回
    json(res, 200, { success: true, tasks: store.getTasks() });
    return;
  }

  if (p === '/api/tasks/clear' && req.method === 'POST') {
    store.saveTasks([]);
    json(res, 200, { success: true });
    return;
  }

  if (p === '/api/tasks/import' && req.method === 'POST') {
    // 从文本自动提取任务；mode: sequential=顺序任务（1. 编号）| scheduled=定时任务（行首定时时间）
    const body = await readBody(req);
    if (!body.text || !String(body.text).trim()) {
      json(res, 400, { success: false, error: 'text 不能为空' });
      return;
    }
    const mode = body.mode === 'scheduled' ? 'scheduled' : 'sequential';
    const { added, warnings } = store.importTasks(body.text, mode);
    json(res, 200, { success: true, added, warnings, mode, tasks: store.getTasks() });
    return;
  }

  if (p === '/api/tasks/reorder' && req.method === 'POST') {
    // 拖拽排序：按给定 id 顺序重编执行顺序
    const body = await readBody(req);
    if (!Array.isArray(body.ids)) {
      json(res, 400, { success: false, error: 'ids 必须是数组' });
      return;
    }
    store.reorderTasks(body.ids.map(String));
    json(res, 200, { success: true, tasks: store.getTasks() });
    return;
  }

  if (p === '/api/tasks/delete' && req.method === 'POST') {
    // 删除任务及其会话消息
    const body = await readBody(req);
    if (!body.id) { json(res, 400, { success: false, error: 'id 不能为空' }); return; }
    store.deleteTask(String(body.id));
    json(res, 200, { success: true, tasks: store.getTasks() });
    return;
  }

  if (p === '/api/tasks/run' && req.method === 'POST') {
    // 顺序执行任务：每个任务 = 独立会话 + 一次完整管家调度
    // 未指定 ids 时仅执行顺序待办（未到点的定时任务不在此列，由定时调度器负责）
    if (runLocks.tasks) {
      json(res, 409, { success: false, error: '已有一批任务正在执行，请等待完成或先停止' });
      return;
    }
    runLocks.tasks = true;
    const myToken = stopTokens.tasks; // 执行期间令牌变化 = 用户请求了停止
    const body = await readBody(req);
    const all = store.getTasks().slice().sort((a, b) => a.createdAt - b.createdAt);
    const selected = Array.isArray(body.taskIds) && body.taskIds.length > 0
      ? all.filter(t => body.taskIds.includes(t.id))
      : all.filter(t => (t.status === 'pending' || t.status === 'failed') && !(t.kind === 'scheduled' && t.status === 'pending'));
    if (selected.length === 0) {
      runLocks.tasks = false;
      json(res, 400, { success: false, error: '没有可执行的任务' });
      return;
    }

    const send = sse(req, res);
    try {
      await executeTaskBatch(selected, send, myToken);
    } catch (err) {
      console.error('[tasks/run] 编排异常:', err && (err.stack || err));
      send({ type: 'error', content: `任务编排异常：${err && err.message || err}` });
    } finally {
      runLocks.tasks = false;
      try { res.end(); } catch { /* closed */ }
    }
    return;
  }

  if (p === '/api/chat' && req.method === 'POST') {
    // 聊天：@点名 → 点名智能体串行流水线；未点名 → 管家调度
    // taskId 非空时为任务会话内聊天（携带该会话历史背景）
    // 任务批量执行中仍可聊天（互不阻塞），但同时只允许一个聊天编排
    if (runLocks.chat) {
      json(res, 409, { success: false, error: '上一条消息还在处理中，请等待完成或点「停止」' });
      return;
    }
    runLocks.chat = true;
    const myToken = stopTokens.chat;
    const body = await readBody(req);
    const message = String(body.message || '').trim();
    const taskId = String(body.taskId || '');
    if (!message) {
      runLocks.chat = false;
      json(res, 400, { success: false, error: 'message 不能为空' });
      return;
    }
    const agents = store.getAgents();
    if (agents.length === 0) {
      runLocks.chat = false;
      json(res, 400, { success: false, error: '没有可用的 Agent，请先配置' });
      return;
    }
    const butler = agents.find(a => a.id === 'butler');
    const subAgents = agents.filter(a => a.id !== 'butler');
    if (!butler) {
      runLocks.chat = false;
      json(res, 400, { success: false, error: '管家智能体缺失，配置异常' });
      return;
    }

    const mentionAgents = resolveMentions(message, agents);
    const clean = stripMentions(message) || message;

    // 先构建历史背景（此时还不含当前消息），再落库当前用户消息
    const opts = { taskId, history: buildHistoryText(taskId), scope: 'chat', isStopped: () => stopTokens.chat !== myToken, approval: approvalSetting(), requestApproval: makeRequestApproval() };
    store.addMessage({ role: 'user', content: message, taskId, timestamp: new Date().toISOString() });

    const send = sse(req, res);
    const persist = (m) => store.addMessage({ ...m, taskId, timestamp: new Date().toISOString() });
    try {
      let run;
      if (body.mode === 'roundtable') {
        // 圆桌讨论：@点名者参与（管家作为主持人不算发言席），未点名则全体子智能体参与
        const speakers = mentionAgents.filter(a => a.id !== butler.id);
        const participants = speakers.length ? speakers : subAgents;
        run = runRoundtable(butler, participants, clean, opts, send, persist);
      } else {
        run = mentionAgents.length > 0
          ? runMentioned(mentionAgents, clean, opts, send, persist)
          : runButler(butler, subAgents, clean, opts, send, persist);
      }
      await run;
    } catch (err) {
      console.error('[chat] 编排异常:', err && (err.stack || err));
      send({ type: 'error', content: `编排异常：${err && err.message || err}` });
    } finally {
      runLocks.chat = false;
      try { res.end(); } catch { /* closed */ }
    }
    return;
  }

  if (p === '/api/messages' && req.method === 'GET') {
    // 不带参数返回全部（前端按 taskId 分组成会话）；?taskId=xxx 仅返回该任务会话
    const q = parsed.query || {};
    const msgs = q.taskId !== undefined ? store.getMessages(String(q.taskId || '')) : store.getMessages();
    json(res, 200, { success: true, messages: msgs });
    return;
  }

  if (p === '/api/messages/clear' && req.method === 'POST') {
    store.clearMessages();
    json(res, 200, { success: true });
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

// 优雅退出：停掉全部子进程、把执行中任务复位为待执行，避免残留与假死状态
function shutdown(code) {
  try {
    const n = stopAllChildren();
    const m = store.resetRunningTasks();
    if (n || m) console.log(`退出清理：终止 ${n} 个子进程，复位 ${m} 个执行中任务`);
  } catch (err) {
    console.error('[shutdown] 清理失败:', err && (err.stack || err));
  }
  process.exit(code);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

// ---------- 任务批次执行（SSE 手动触发与定时调度共用） ----------
// send: 事件推送（SSE 为真实推送，定时触发为 no-op，消息仍会持久化）
async function executeTaskBatch(selected, send, myToken) {
  const agents = store.getAgents();
  const butler = agents.find(a => a.id === 'butler');
  if (!butler) throw new Error('管家智能体缺失，配置异常');
  const subAgents = agents.filter(a => a.id !== 'butler');
  const resolveAssign = (task) => {
    if (!task.assign) return null;
    return agents.find(a => a.id === task.assign) || null;
  };
  const persist = (m) => store.addMessage({ ...m, timestamp: new Date().toISOString() });
  await runTasks(
    selected, butler, subAgents,
    { getHistory: (tid) => buildHistoryText(tid), resolveAssign, scope: 'tasks', isStopped: () => stopTokens.tasks !== myToken, approval: approvalSetting(), requestApproval: makeRequestApproval() },
    send, persist,
    // 任务会话首条消息：任务本身（用户视角）
    (task) => {
      if (store.getMessages(task.id).length === 0) {
        store.addMessage({
          role: 'user',
          content: `任务：${task.title}${task.notes ? `\n补充说明：${task.notes}` : ''}`,
          taskId: task.id,
          timestamp: new Date().toISOString()
        });
      }
    },
    (taskId, patch) => store.updateTask(taskId, patch)
  );
}

// ---------- 定时调度器：到点的定时任务自动执行（无人值守） ----------
// 执行过程照常持久化到对应任务会话，用户打开会话即可查看全过程
const SCHED_INTERVAL_MS = 15000;
function startScheduler() {
  const timer = setInterval(() => {
    if (runLocks.tasks) return; // 手动批次执行中，下轮再查
    if (store.getSchedEnabled() === false) return; // 用户关闭了定时调度总开关
    const due = store.getTasks().filter(t =>
      t.kind === 'scheduled' && t.status === 'pending' && t.scheduledAt && t.scheduledAt <= Date.now());
    if (!due.length) return;
    runLocks.tasks = true;
    const myToken = stopTokens.tasks;
    console.log(`[scheduler] 定时触发 ${due.length} 个任务：${due.map(t => t.title).join('、')}`);
    executeTaskBatch(due, () => {}, myToken)
      .catch(err => console.error('[scheduler] 定时执行异常:', err && (err.stack || err)))
      .finally(() => { runLocks.tasks = false; });
  }, SCHED_INTERVAL_MS);
  timer.unref();
  return timer;
}

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`\n❌ 端口 ${PORT} 已被占用：很可能有一个旧版 Agents Chat 进程还在运行！`);
    console.error(`   你现在访问的是旧版页面，新代码从未生效。请先结束旧进程：`);
    console.error(`   1) 打开命令行执行：netstat -ano | findstr :${PORT}`);
    console.error(`   2) 找到 LISTENING 行最后的 PID，执行：taskkill /F /PID <该PID> /T`);
    console.error(`   3) 再重新运行 npm start，并浏览器 Ctrl+F5 强刷页面\n`);
    process.exit(1);
  }
  console.error('服务器启动失败:', err && (err.stack || err));
  process.exit(1);
});

server.listen(PORT, () => {
  const { resolveRunner, detectKernels, KERNEL_DEFS } = require('./lib/agent');
  const runner = resolveRunner();
  const kindText = runner.kind === 'demo'
    ? '演示模式（AGENTS_CHAT_MOCK=1，输出为模拟结果）'
    : runner.kind === 'missing'
      ? (runner.missingKernel
        ? `已选择内核 ${runner.missingKernel.label} 但未检测到！任务将报错，请先安装并重启`
        : `未检测到任何内核！任务将报错，可安装其一：${KERNEL_DEFS.map(k => k.install).join(' / ')}`)
      : `${runner.kernel.label} 真实执行（${runner.cmd}）`;
  const detected = detectKernels();
  const avail = KERNEL_DEFS.filter(k => detected[k.id].ok).map(k => k.label).join('、') || '无';
  // 启动即修复孤儿状态：上次异常退出时仍标记「执行中」的任务复位为待执行
  const orphan = store.resetRunningTasks();
  if (orphan > 0) console.log(`检测到 ${orphan} 个上次未正常结束的任务，已复位为待执行`);
  startScheduler();
  console.log(`Agents Chat 已启动: http://localhost:${PORT}`);
  console.log(`运行内核: ${kindText}`);
  console.log(`本机可用内核: ${avail}（配置页可切换）`);
  console.log(`数据目录: ${store.DATA_DIR}`);
});
