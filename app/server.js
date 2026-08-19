// Agents Chat Portable - 零依赖 HTTP 服务
// 启动：node app/server.js [--port 3456]
const APP_VERSION = '3.14.0'; // 页面与服务端版本互检，不一致提示强刷
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const { spawn } = require('child_process');

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
const oc = require('./lib/oc');
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
// chat / tasks / solo 三个作用域各自单飞（防止双击或 API 直调并发执行）；
// 任务执行中仍可正常聊天，互不阻塞
const runLocks = { chat: false, tasks: false, solo: false };
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
// sseConns：活跃 SSE 连接计数（聊天/任务/终端），页面关闭后归零，供自动退出判断
// 注意：body 被 readBody 消费后 req 的 'close' 在部分 Node 版本不再触发，
// 因此以 res 的 'close'（响应结束或连接断开都触发）为准，双保险 + 幂等
let sseConns = 0;
function sse(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
  sseConns++;
  const send = (obj) => {
    try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch { /* closed */ }
  };
  // 心跳防止代理断开
  const hb = setInterval(() => {
    try { res.write(': hb\n\n'); } catch { clearInterval(hb); }
  }, 15000);
  let closed = false;
  const onClose = () => {
    if (closed) return;
    closed = true;
    clearInterval(hb);
    sseConns--;
  };
  req.on('close', onClose);
  res.on('close', onClose);
  return send;
}

// ---------- 页面全关自动退出（便携免维护体验） ----------
// 前端页面每 25s 心跳一次；所有页面关闭且无 SSE 连接、无审批等待、无编排执行后，
// 空闲约 1 分钟自动退出（含有待触发的定时任务：需要定时任务请保持页面打开；
// .env AGENTS_CHAT_AUTOSTOP=0 可关闭）
const AUTOSTOP = process.env.AGENTS_CHAT_AUTOSTOP !== '0';
const AUTOSTOP_IDLE_MS = Number(process.env.AGENTS_CHAT_AUTOSTOP_IDLE_MS) > 0
  ? Number(process.env.AGENTS_CHAT_AUTOSTOP_IDLE_MS)
  : 50 * 1000;
let lastClientSeen = 0;
let everSeenClient = false;
function touchClient() {
  lastClientSeen = Date.now();
  everSeenClient = true;
}
function startAutoStop() {
  if (!AUTOSTOP) return;
  const timer = setInterval(() => {
    if (!everSeenClient) return;
    if (sseConns > 0 || pendingApprovals.size > 0 || runLocks.chat || runLocks.tasks || runLocks.solo) return;
    if (Date.now() - lastClientSeen < AUTOSTOP_IDLE_MS) return;
    const hasSched = store.getSchedEnabled() && store.getTasks().some(t =>
      t.kind === 'scheduled' && t.status === 'pending' && t.scheduledAt && t.scheduledAt > Date.now());
    if (hasSched) console.log('所有页面已关闭且空闲约 1 分钟，服务自动退出（有待触发的定时任务也一并退出；需要定时任务请保持页面打开。重开 start 即可）');
    else console.log('所有页面已关闭且空闲约 1 分钟，服务自动退出（重开 start 即可）');
    shutdown(0);
  }, 10000);
  timer.unref();
}

// ---------- 单聊模式：Web 终端（对接 OpenCode 等内核 CLI） ----------
// 零依赖实现：常驻 shell 进程 + SSE 下行输出 + POST 上行输入；
// 交互式 TUI（如直接运行 opencode）需要伪终端，本版先支持命令式使用（opencode run 等）
const termClients = new Set(); // 活跃终端 SSE 的 send 函数
let termProc = null;
let termBuf = [];              // 输出回放缓冲（重连/刷新后补回）
const TERM_BUF_MAX = 600;
function termCwd() {
  const gc = String(store.getConfig().globalCwd || '').trim();
  if (gc) { try { if (fs.existsSync(gc)) return gc; } catch { /* ignore */ } }
  return store.DATA_DIR;
}
// 终端输出清洗：去掉 ANSI 控制序列，避免网页端乱码
function termClean(s) {
  return String(s)
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
}
function termPush(raw) {
  const data = termClean(raw);
  if (!data) return;
  termBuf.push(data);
  if (termBuf.length > TERM_BUF_MAX) termBuf = termBuf.slice(termBuf.length - TERM_BUF_MAX);
  for (const send of termClients) send({ type: 'data', data });
}
function termShell() {
  if (termProc) return termProc;
  const isWin = process.platform === 'win32';
  const cmd = isWin ? (process.env.ComSpec || 'cmd.exe') : (process.env.SHELL || '/bin/bash');
  try {
    termProc = spawn(cmd, isWin ? ['/Q'] : [], { cwd: termCwd(), env: process.env });
  } catch (err) {
    termPush(`\n[无法启动 shell：${err && err.message || err}]\n`);
    return null;
  }
  termProc.stdout.on('data', b => termPush(b.toString('utf8')));
  termProc.stderr.on('data', b => termPush(b.toString('utf8')));
  termProc.on('exit', (code) => {
    termPush(`\n[shell 已退出（code=${code}），下次输入时自动重启]\n`);
    termProc = null;
  });
  return termProc;
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
  // 页面存活感知：任何请求都视为「有客户端在看」，供自动退出判断
  touchClient();

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
    const scope = ['tasks', 'solo', 'chat'].includes(body.scope) ? body.scope : 'chat';
    if (scope === 'tasks') stopTokens.tasks++;
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
    // runner='solo' 时任务由单聊 OpenCode 直接执行（不经管家编排），侧栏在单聊模式展示
    const body = await readBody(req);
    if (!body.text || !String(body.text).trim()) {
      json(res, 400, { success: false, error: 'text 不能为空' });
      return;
    }
    const mode = body.mode === 'scheduled' ? 'scheduled' : 'sequential';
    const runner = body.runner === 'solo' ? 'solo' : '';
    const { added, warnings } = store.importTasks(body.text, mode, runner);
    json(res, 200, { success: true, added, warnings, mode, runner, tasks: store.getTasks() });
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
    // 顺序执行任务：scope='solo' 时由 OpenCode 单体逐个执行（每个任务独立一次性对话）；
    // 默认（群聊）每个任务 = 独立会话 + 一次完整管家调度
    // 未指定 ids 时仅执行顺序待办（未到点的定时任务不在此列，由定时调度器负责）
    if (runLocks.tasks) {
      json(res, 409, { success: false, error: '已有一批任务正在执行，请等待完成或先停止' });
      return;
    }
    runLocks.tasks = true;
    const myToken = stopTokens.tasks; // 执行期间令牌变化 = 用户请求了停止
    const body = await readBody(req);
    const soloScope = body.scope === 'solo';
    const all = store.getTasks().slice().sort((a, b) => a.createdAt - b.createdAt);
    const selected = Array.isArray(body.taskIds) && body.taskIds.length > 0
      ? all.filter(t => body.taskIds.includes(t.id))
      : all.filter(t => (t.status === 'pending' || t.status === 'failed')
        && !(t.kind === 'scheduled' && t.status === 'pending')
        && (soloScope ? t.runner === 'solo' : t.runner !== 'solo'));
    if (selected.length === 0) {
      runLocks.tasks = false;
      json(res, 400, { success: false, error: '没有可执行的任务' });
      return;
    }

    const send = sse(req, res);
    try {
      if (soloScope) {
        await executeSoloTaskBatch(selected, send, myToken);
      } else {
        await executeTaskBatch(selected, send, myToken);
      }
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

  // ---------- 单聊模式：终端 API ----------
  if (p === '/api/term/stream' && req.method === 'GET') {
    const send = sse(req, res);
    termClients.add(send);
    res.on('close', () => termClients.delete(send));
    send({ type: 'init', cwd: termCwd(), platform: process.platform });
    termPush(''); // no-op 占位，确保连接建立
    if (termBuf.length) send({ type: 'data', data: termBuf.join('') });
    return;
  }

  if (p === '/api/term/input' && req.method === 'POST') {
    const body = await readBody(req);
    const data = String(body.data || '');
    if (!data.trim()) { json(res, 200, { success: true }); return; }
    const proc = termShell();
    if (proc) {
      // 输入回显由前端负责（提示符 + 命令），这里只写 stdin
      try { proc.stdin.write(data + '\n'); } catch { termShell() && termProc.stdin.write(data + '\n'); }
    }
    json(res, 200, { success: true });
    return;
  }

  if (p === '/api/term/signal' && req.method === 'POST') {
    const body = await readBody(req);
    if (termProc) {
      try { termProc.kill(body.signal === 'kill' ? 'SIGKILL' : 'SIGINT'); } catch { /* ignore */ }
    }
    json(res, 200, { success: true });
    return;
  }

  if (p === '/api/term/clear' && req.method === 'POST') {
    termBuf = [];
    for (const send of termClients) send({ type: 'clear' });
    json(res, 200, { success: true });
    return;
  }

  // ---------- 单聊工作台（OpenCode）：模型与会话管理 ----------
  if (p === '/api/oc/models' && req.method === 'GET') {
    const { resolveRunner } = require('./lib/agent');
    const runner = resolveRunner();
    if (runner.kind === 'demo') {
      json(res, 200, { success: true, demo: true, models: oc.demoModels() });
      return;
    }
    if (runner.kind !== 'opencode') {
      // 其他内核无模型列表命令：返回空 + 内核标注（前端提示手动填写或用默认）
      json(res, 200, { success: true, models: [], kernel: runner.kernel ? runner.kernel.label : '', noResume: true });
      return;
    }
    const models = oc.listOcModels(runner, parsed.query.refresh === '1');
    json(res, 200, { success: true, models });
    return;
  }

  if (p === '/api/oc/sessions' && req.method === 'GET') {
    json(res, 200, { success: true, sessions: store.getOcSessions() });
    return;
  }

  if (p === '/api/oc/sessions' && req.method === 'POST') {
    // 新建单聊会话
    const body = await readBody(req);
    const id = `oc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const rec = store.upsertOcSession(id, { title: String(body.title || '').slice(0, 60) });
    json(res, 200, { success: true, session: rec });
    return;
  }

  if (p === '/api/oc/sessions/rename' && req.method === 'POST') {
    const body = await readBody(req);
    const id = String(body.id || '');
    if (!store.getOcSession(id)) { json(res, 404, { success: false, error: '会话不存在' }); return; }
    const rec = store.upsertOcSession(id, { title: String(body.title || '').trim().slice(0, 60) });
    json(res, 200, { success: true, session: rec });
    return;
  }

  if (p === '/api/oc/sessions/delete' && req.method === 'POST') {
    const body = await readBody(req);
    const id = String(body.id || '');
    if (!store.getOcSession(id)) { json(res, 404, { success: false, error: '会话不存在' }); return; }
    store.deleteOcSession(id);
    json(res, 200, { success: true, sessions: store.getOcSessions() });
    return;
  }

  if (p === '/api/oc/chat' && req.method === 'POST') {
    // 单聊对话：opencode run（-s 续聊），SSE 转发快照事件
    if (runLocks.solo) {
      json(res, 409, { success: false, error: '上一条消息还在处理中，请等待完成或点「停止」' });
      return;
    }
    const body = await readBody(req);
    const sessionId = String(body.sessionId || '');
    const message = String(body.message || '').trim();
    const model = String(body.model || '');
    const rec = store.getOcSession(sessionId);
    if (!rec) { json(res, 404, { success: false, error: '会话不存在，请先新建' }); return; }
    if (!message) { json(res, 400, { success: false, error: 'message 不能为空' }); return; }

    const { resolveRunner, missingHint } = require('./lib/agent');
    const runner = resolveRunner();
    if (runner.kind === 'missing') {
      json(res, 400, { success: false, error: missingHint(runner) });
      return;
    }

    runLocks.solo = true;
    store.addMessage({ role: 'user', content: message, taskId: sessionId, timestamp: new Date().toISOString() });
    // 标题留空时取首条消息；模型选择随会话记忆
    const patch = {};
    if (!rec.title) patch.title = message.slice(0, 24);
    if (model) patch.model = model;
    store.upsertOcSession(sessionId, patch);

    const send = sse(req, res);
    const texts = new Map();  // partId -> 最新快照
    const order = [];         // 正文 part 出现顺序（多段拼接用）
    send({ type: 'start', sessionId, model });
    try {
      await new Promise((resolve) => {
        const kind = runner.kind === 'demo' ? 'demo' : (runner.kind === 'opencode' ? 'opencode' : 'fallback');
        oc.chatSolo(kind, runner, { prompt: message, model, ocSessionId: rec.ocSessionId || '' }, (ev) => {
          if (ev.type === 'session') {
            // 首个 sessionID 回填：后续轮次经 -s 在同一 opencode 会话续聊
            store.upsertOcSession(sessionId, { ocSessionId: ev.ocSessionId });
            send({ type: 'session', sessionId, ocSessionId: ev.ocSessionId });
          } else if (ev.type === 'text') {
            if (!texts.has(ev.partId)) order.push(ev.partId);
            texts.set(ev.partId, ev.text);
            send({ type: 'text', sessionId, partId: ev.partId, text: ev.text });
          } else if (ev.type === 'reasoning') {
            send({ type: 'reasoning', sessionId, partId: ev.partId, text: ev.text });
          } else if (ev.type === 'tool') {
            send({ type: 'tool', sessionId, name: ev.name, summary: ev.summary });
          } else if (ev.type === 'done') {
            send({ type: 'done', sessionId, error: ev.error || undefined, noResume: !!ev.noResume });
            resolve();
          }
        });
      });
      // 最终正文快照落库（reasoning/tool 过程信息不持久化）
      const finalText = order.map(id => texts.get(id)).join('\n\n').trim();
      if (finalText) {
        store.addMessage({ role: 'assistant', agentId: 'solo', agentName: 'OpenCode', phase: 'work', taskId: sessionId, content: finalText, timestamp: new Date().toISOString() });
      }
      store.upsertOcSession(sessionId, {}); // 刷新 updatedAt（侧栏排序）
    } catch (err) {
      console.error('[oc/chat] 单聊异常:', err && (err.stack || err));
      send({ type: 'error', content: `单聊异常：${err && err.message || err}` });
      send({ type: 'done', sessionId, error: '内部异常' });
    } finally {
      runLocks.solo = false;
      try { res.end(); } catch { /* closed */ }
    }
    return;
  }

  // ---------- Markdown 文件预览（只读，限文本扩展名与大小；本机任意路径均可） ----------
  if (p === '/api/file' && req.method === 'GET') {
    const fp = path.resolve(String(parsed.query.path || ''));
    if (!/\.(md|markdown|txt|json|log|csv|js|mjs|ts|html|htm|css|py|sh|yml|yaml|xml)$/i.test(fp)) {
      json(res, 403, { success: false, error: '仅支持文本类文件预览' });
      return;
    }
    fs.stat(fp, (err, st) => {
      if (err || !st.isFile()) { json(res, 404, { success: false, error: '文件不存在' }); return; }
      if (st.size > 2 * 1024 * 1024) { json(res, 413, { success: false, error: '文件超过 2MB，不支持网页预览' }); return; }
      fs.readFile(fp, 'utf8', (err2, data) => {
        if (err2) { json(res, 500, { success: false, error: '读取失败' }); return; }
        json(res, 200, { success: true, path: fp, name: path.basename(fp), size: st.size, content: data });
      });
    });
    return;
  }

  // ---------- 历史管理：一键清空全部会话 / 导出 sessions.md ----------
  if (p === '/api/history/clear' && req.method === 'POST') {
    const msgCount = store.getMessages().length;
    let outDirs = 0;
    store.clearMessages();
    // 单聊会话记录一并清空（消息已清，保留空会话列表无意义）
    store.saveOcSessions([]);
    // 会话产出目录（BOARD.md、过程存档等）一并清理
    const outRoot = path.join(store.DATA_DIR, 'outputs');
    try {
      for (const d of fs.readdirSync(outRoot)) {
        const full = path.join(outRoot, d);
        try { if (fs.statSync(full).isDirectory()) { fs.rmSync(full, { recursive: true, force: true }); outDirs++; } } catch { /* ignore */ }
      }
    } catch { /* 目录不存在 */ }
    // 流转日志（历史编排记录）同步清空
    try { fs.writeFileSync(path.join(store.DATA_DIR, 'flow.jsonl'), ''); } catch { /* ignore */ }
    json(res, 200, { success: true, messages: msgCount, outputDirs: outDirs });
    return;
  }

  if (p === '/api/history/export' && req.method === 'GET') {
    const msgs = store.getMessages();
    const tasksAll = store.getTasks();
    const ocAll = store.getOcSessions();
    const fmtTs = (t) => { const d = new Date(t); const p2 = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`; };
    const roleOf = (m) => m.role === 'user' ? '👤 用户' : (m.agentName || '智能体') + (m.phase ? `（${m.phase}）` : '');
    const lines = [
      '# Agents Chat 会话导出', '',
      `- 导出时间：${fmtTs(Date.now())}`,
      `- 会话数：${1 + tasksAll.filter(t => store.getMessages(t.id).length > 0).length + ocAll.filter(s => store.getMessages(s.id).length > 0).length}（主会话 + 任务会话 + 单聊会话）`,
      `- 消息总数：${msgs.length}`, ''
    ];
    const main = msgs.filter(m => !m.taskId);
    lines.push('---', '', '## 主会话', '');
    for (const m of main) {
      lines.push(`### ${fmtTs(m.timestamp)} · ${roleOf(m)}`, '');
      lines.push(String(m.content || '').trim() || '（无内容）');
      if (m.outputPath) lines.push('', `> 过程存档：${m.outputPath}`);
      lines.push('');
    }
    for (const t of tasksAll.sort((a, b) => (a.scheduledAt || a.createdAt) - (b.scheduledAt || b.createdAt))) {
      const arr = store.getMessages(t.id);
      if (!arr.length) continue;
      lines.push('---', '', `## 任务：${t.title}`, '',
        `- 状态：${({ pending: '待执行', running: '执行中', done: '已完成', failed: '失败' })[t.status] || t.status}`,
        `- 类型：${t.kind === 'scheduled' ? '定时任务' : '顺序任务'}${t.runner === 'solo' ? '（单聊 OpenCode 执行）' : ''}`, '');
      for (const m of arr) {
        lines.push(`### ${fmtTs(m.timestamp)} · ${roleOf(m)}`, '');
        lines.push(String(m.content || '').trim() || '（无内容）');
        if (m.outputPath) lines.push('', `> 过程存档：${m.outputPath}`);
        lines.push('');
      }
    }
    for (const s of ocAll) {
      const arr = store.getMessages(s.id);
      if (!arr.length) continue;
      lines.push('---', '', `## 单聊会话：${s.title || s.id}`, '',
        `- 模型：${s.model || '默认'}`, '');
      for (const m of arr) {
        lines.push(`### ${fmtTs(m.timestamp)} · ${roleOf(m)}`, '');
        lines.push(String(m.content || '').trim() || '（无内容）');
        lines.push('');
      }
    }
    res.writeHead(200, {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': 'attachment; filename="sessions.md"'
    });
    res.end(lines.join('\n'));
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

// 优雅退出：停掉全部子进程、把执行中任务复位为待执行，避免残留与假死状态
function shutdown(code) {
  try {
    if (termProc) { try { termProc.kill(); } catch { /* ignore */ } termProc = null; }
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

// ---------- 单聊任务批次执行（OpenCode 单体逐个完成，不经管家编排） ----------
// 单聊任务批量执行：按 link 字段编排（导入时 2.-xxx / 3.//xxx 语法解析而来）
//   new（默认）：独立新会话执行；continue：接续上一串行任务的 opencode 会话（同进程续聊）；
//   parallel：连续多个并行任务各自独立进程同时执行（Promise.all）
// 排序：seq 优先，其次 createdAt；会话 ID 记录在任务上（task.ocSessionId）供续聊
// SSE 事件：task_start / text(快照) / tool / notice / task_done / all_done
async function executeSoloTaskBatch(selected, send, myToken) {
  const { resolveRunner, missingHint } = require('./lib/agent');
  const list = selected.slice().sort((a, b) => ((a.seq ?? 0) - (b.seq ?? 0)) || (a.createdAt - b.createdAt));

  // 执行单个任务；ocSessionId 非空 = 在该 opencode 会话中续聊；返回本次会话 id
  const runOne = async (task, ocSessionId) => {
    store.updateTask(task.id, { status: 'running' });
    send({ type: 'task_start', taskId: task.id, title: task.title, solo: true, link: task.link || 'new' });
    const cont = !!ocSessionId; // 续聊：prompt 提示模型这是同一工作的延续
    if (store.getMessages(task.id).length === 0) {
      store.addMessage({
        role: 'user',
        content: `任务：${task.title}${task.notes ? `\n补充说明：${task.notes}` : ''}`,
        taskId: task.id,
        timestamp: new Date().toISOString()
      });
    }

    const runner = resolveRunner();
    if (runner.kind === 'missing') {
      store.updateTask(task.id, { status: 'failed', result: missingHint(runner).slice(0, 2000) });
      send({ type: 'task_done', taskId: task.id, title: task.title, status: 'failed' });
      return '';
    }

    const texts = new Map();
    const order = [];
    let doneError = '';
    let sesId = ocSessionId || '';
    await new Promise((resolve) => {
      const kind = runner.kind === 'demo' ? 'demo' : (runner.kind === 'opencode' ? 'opencode' : 'fallback');
      oc.chatSolo(kind, runner, {
        prompt: cont
          ? `请在当前会话已有工作成果的基础上继续完成下一项任务：\n\n${task.title}${task.notes ? `\n补充说明：${task.notes}` : ''}`
          : `请完成以下任务并给出结果：\n\n${task.title}${task.notes ? `\n补充说明：${task.notes}` : ''}`,
        model: '',
        ocSessionId: sesId,
        behavior: 'solo-task'
      }, (ev) => {
        if (ev.type === 'session') {
          // 首个 sessionID 回填：continue 链与手动重跑都能续上同一会话
          sesId = ev.ocSessionId;
          store.updateTask(task.id, { ocSessionId: sesId });
        } else if (ev.type === 'text') {
          if (!texts.has(ev.partId)) order.push(ev.partId);
          texts.set(ev.partId, ev.text);
          send({ type: 'text', taskId: task.id, partId: ev.partId, text: ev.text, agentId: 'solo', agentName: 'OpenCode', phase: 'work' });
        } else if (ev.type === 'tool') {
          send({ type: 'notice', content: ev.summary, taskId: task.id });
        } else if (ev.type === 'done') {
          doneError = ev.error || '';
          resolve();
        }
      });
    });

    const finalText = order.map(id => texts.get(id)).join('\n\n').trim();
    if (finalText) {
      store.addMessage({ role: 'assistant', agentId: 'solo', agentName: 'OpenCode', phase: 'work', taskId: task.id, content: finalText, timestamp: new Date().toISOString() });
    }
    const stopped = stopTokens.tasks !== myToken;
    store.updateTask(task.id, {
      status: stopped ? 'pending' : (doneError ? 'failed' : 'done'),
      result: (doneError ? `执行出错：${doneError}` : finalText).slice(0, 2000)
    });
    send({ type: 'task_done', taskId: task.id, title: task.title, status: stopped ? 'pending' : (doneError ? 'failed' : 'done') });
    return stopped ? '' : sesId;
  };

  // 编排：串行任务（new/continue）按序执行，continue 复用串行链会话；
  // 连续 parallel 任务聚成一块同时执行（各独立会话），并行块等待前序串行任务完成
  let lastChainSession = '';
  for (let i = 0; i < list.length; i++) {
    if (stopTokens.tasks !== myToken) break;
    const link = list[i].link || 'new';
    if (link === 'parallel') {
      const block = [list[i]];
      while (i + 1 < list.length && (list[i + 1].link || 'new') === 'parallel') block.push(list[++i]);
      if (block.length > 1) {
        send({ type: 'notice', content: `⚡ ${block.length} 个任务并行执行（各自独立进程）：${block.map(t => `「${t.title.slice(0, 20)}」`).join('、')}` });
      }
      await Promise.all(block.map(t => runOne(t, '')));
      continue;
    }
    if (link === 'continue') {
      const tt = String(list[i].title || '').slice(0, 20);
      if (lastChainSession) send({ type: 'notice', content: `↪ 任务「${tt}」接续上一任务的会话执行（同进程续聊）`, taskId: list[i].id });
      else send({ type: 'notice', content: `任务「${tt}」标记续聊但没有前序会话，已按新会话执行`, taskId: list[i].id });
    }
    const ses = await runOne(list[i], link === 'continue' ? lastChainSession : '');
    if (ses) lastChainSession = ses;
  }
  send({ type: 'all_done' });
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
    const groups = due.filter(t => t.runner !== 'solo');
    const solos = due.filter(t => t.runner === 'solo');
    (async () => {
      if (groups.length) await executeTaskBatch(groups, () => {}, myToken);
      if (solos.length) await executeSoloTaskBatch(solos, () => {}, myToken);
    })()
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
  startAutoStop();
  console.log(`Agents Chat 已启动: http://localhost:${PORT}`);
  console.log(`运行内核: ${kindText}`);
  console.log(`本机可用内核: ${avail}（配置页可切换）`);
  console.log(`数据目录: ${store.DATA_DIR}`);
});
