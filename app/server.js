// Agents Chat Portable - 零依赖 HTTP 服务
// 启动：node app/server.js [--port 3456]
const APP_VERSION = '3.3.0'; // 页面与服务端版本互检，不一致提示强刷
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
const { runButler, runMentioned, runTasks } = require('./lib/orchestrator');

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
    const { resolveRunner } = require('./lib/agent');
    const runner = resolveRunner();
    json(res, 200, {
      success: true,
      version: APP_VERSION,
      runner: runner.kind,
      opencode: runner.kind === 'opencode' ? runner.cmd : '',
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

  if (p === '/api/agents' && req.method === 'GET') {
    json(res, 200, { success: true, agents: store.getAgents(), butlerId: store.BUTLER.id });
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
    // 保存用户自定义子智能体（管家内置，不接受修改）
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
      let cwd = String(a.cwd || '').trim().replace(/["']/g, '');
      if (cwd && !isDir(cwd)) {
        dirWarn.push(`「${final}」的工作目录不存在或不是文件夹：${cwd}，已忽略（将使用程序根目录）`);
        cwd = '';
      }
      clean.push({
        id: String(a.id || '').replace(/[^\w-]/g, '') || `ag-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        name: final,
        desc: String(a.desc || '').slice(0, 100),
        cwd,
        model: '', // 统一使用 OpenCode 默认模型配置，不接受自定义
        systemPrompt: String(a.systemPrompt || '').slice(0, 8000), // 下发任务时附加在用户提示词前
        behavior: String(a.behavior || 'echo')
      });
    }
    store.saveAgents(clean);
    json(res, 200, { success: true, agents: store.getAgents(), butlerId: store.BUTLER.id, warnings: dirWarn });
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
    // 从文本自动提取任务（每行一个，支持时间前缀；行末可 @智能体 指派，默认管家）
    const body = await readBody(req);
    if (!body.text || !String(body.text).trim()) {
      json(res, 400, { success: false, error: 'text 不能为空' });
      return;
    }
    const { added, warnings } = store.importTasks(body.text);
    json(res, 200, { success: true, added, warnings, tasks: store.getTasks() });
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
      : all.filter(t => t.status === 'pending' || t.status === 'failed');
    if (selected.length === 0) {
      runLocks.tasks = false;
      json(res, 400, { success: false, error: '没有可执行的任务' });
      return;
    }
    const agents = store.getAgents();
    const butler = agents.find(a => a.id === 'butler');
    if (!butler) {
      runLocks.tasks = false;
      json(res, 400, { success: false, error: '管家智能体缺失，配置异常' });
      return;
    }
    const subAgents = agents.filter(a => a.id !== 'butler');
    const resolveAssign = (task) => {
      if (!task.assign) return null;
      return agents.find(a => a.id === task.assign) || null;
    };

    const send = sse(req, res);
    const persist = (m) => store.addMessage({ ...m, timestamp: new Date().toISOString() });
    try {
      await runTasks(
        selected, butler, subAgents,
        { getHistory: (tid) => buildHistoryText(tid), resolveAssign, scope: 'tasks', isStopped: () => stopTokens.tasks !== myToken },
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
    const opts = { taskId, history: buildHistoryText(taskId), scope: 'chat', isStopped: () => stopTokens.chat !== myToken };
    store.addMessage({ role: 'user', content: message, taskId, timestamp: new Date().toISOString() });

    const send = sse(req, res);
    const persist = (m) => store.addMessage({ ...m, taskId, timestamp: new Date().toISOString() });
    try {
      const run = mentionAgents.length > 0
        ? runMentioned(mentionAgents, clean, opts, send, persist)
        : runButler(butler, subAgents, clean, opts, send, persist);
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
  const { resolveRunner } = require('./lib/agent');
  const runner = resolveRunner();
  const kindText = runner.kind === 'opencode'
    ? `OpenCode 真实执行（${runner.cmd}）`
    : runner.kind === 'demo'
      ? '演示模式（AGENTS_CHAT_MOCK=1，输出为模拟结果）'
      : '未检测到 OpenCode！任务将报错，请先安装 opencode 并重启';
  // 启动即修复孤儿状态：上次异常退出时仍标记「执行中」的任务复位为待执行
  const orphan = store.resetRunningTasks();
  if (orphan > 0) console.log(`检测到 ${orphan} 个上次未正常结束的任务，已复位为待执行`);
  console.log(`Agents Chat 已启动: http://localhost:${PORT}`);
  console.log(`运行内核: ${kindText}`);
  console.log(`数据目录: ${store.DATA_DIR}`);
});
