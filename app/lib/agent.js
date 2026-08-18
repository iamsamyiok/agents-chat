// Agent 运行器：OpenCode 内核（复用本机已安装的 opencode CLI）
// - 非交互执行：opencode run --format json，prompt 经 stdin 传入（避免命令行引号转义问题）
// - stdout 为 NDJSON 事件流：text / tool_use / error 事件实时回调，工具调用过程对用户可见
// - 未检测到 opencode 时显式报错，绝不静默回退演示模式
// - 仅当 .env 明确设置 AGENTS_CHAT_MOCK=1 才进入演示模式（输出带演示标识）
// - 每次调用独立进程、全新会话：任务之间上下文不互通
const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const DATA_DIR = process.env.AGENTS_CHAT_DATA || path.join(ROOT, '.data');
const MOCK_SCRIPT = path.join(__dirname, '..', 'mock', 'mock-agent.js');

// 模型标识必须形如 provider/model，且只含安全字符（会进入命令行参数）
const MODEL_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

// ---------- OpenCode 检测 ----------
// 优先级：AGENTS_CHAT_OPENCODE_CMD 显式指定 > PATH 查找（where/which）
// Windows 下 npm 安装的 opencode 是 .cmd 垫片，Node 18.20+ 禁止直接 spawn，须走 shell
function findOpenCode() {
  const custom = process.env.AGENTS_CHAT_OPENCODE_CMD;
  if (custom && fs.existsSync(custom)) {
    return { cmd: custom, shell: /\.(cmd|bat)$/i.test(custom) };
  }
  try {
    const finder = process.platform === 'win32' ? 'where opencode' : 'which opencode';
    const out = execSync(finder, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
    const all = String(out).split(/\r?\n/).map(s => s.trim()).filter(Boolean).filter(p => fs.existsSync(p));
    if (all.length) {
      // Windows 上 where 可能先返回无扩展名的 bash 垫片（存在但无法被 spawn 直接执行，报 ENOENT），
      // 须优先选 .exe/.cmd/.bat 等 Windows 可执行垫片
      const winExe = all.find(p => /\.(exe|cmd|bat|com)$/i.test(p));
      const first = process.platform === 'win32' && winExe ? winExe : all[0];
      return { cmd: first, shell: /\.(cmd|bat)$/i.test(first) };
    }
  } catch { /* 未安装 */ }
  return null;
}

function resolveRunner() {
  if (process.env.AGENTS_CHAT_MOCK === '1') {
    return { kind: 'demo', configured: false };
  }
  const oc = findOpenCode();
  if (oc) return { kind: 'opencode', configured: true, cmd: oc.cmd, shell: oc.shell };
  return { kind: 'missing', configured: false };
}

const MISSING_HINT = [
  '未检测到 OpenCode。请先在本机安装并确认命令行可用：',
  '  npm install -g opencode-ai',
  '  opencode --version',
  '安装后重启本程序；也可在 .env 中用 AGENTS_CHAT_OPENCODE_CMD 指定完整路径。'
].join('\n');

// ---------- NDJSON 事件 → 文本流 ----------
// 从工具入参提取操作对象摘要（路径/命令/网址等），让用户知道工具到底动了什么
function toolTarget(part) {
  const state = (part && part.state) || {};
  const input = state.input || part.input;
  if (!input || typeof input !== 'object') return '';
  const keys = ['filePath', 'path', 'file_path', 'command', 'cmd', 'url', 'pattern', 'query', 'name', 'content'];
  for (const k of keys) {
    const v = input[k];
    if (typeof v === 'string' && v.trim()) return `（${v.slice(0, 60)}）`;
  }
  const first = Object.values(input).find(v => typeof v === 'string' && v.trim());
  return first ? `（${first.slice(0, 60)}）` : '';
}

function describeTool(part) {
  const name = part && part.tool ? part.tool : 'tool';
  const state = (part && part.state) || {};
  if (state.status === 'error') {
    return `[工具] ${name} 失败：${String(state.error || '').slice(0, 300)}`;
  }
  return `[工具] ${name}${toolTarget(part)} 执行完成`;
}

// ---------- 运行中的子进程登记（手动停止 / 退出清理用） ----------
const activeChildren = new Map(); // child -> scope（'chat' | 'tasks'）
function registerChild(child, scope) {
  if (!child) return;
  activeChildren.set(child, scope || 'chat');
  child.on('close', () => activeChildren.delete(child));
}

// 停止某作用域的全部子进程：标记后强杀进程树，close 回调会给出友好提示
function stopScope(scope) {
  let n = 0;
  for (const [child, s] of activeChildren) {
    if (s !== scope) continue;
    child._stopped = true;
    killTree(child);
    n++;
  }
  return n;
}

function stopAllChildren() {
  let n = 0;
  for (const [child] of activeChildren) { child._stopped = true; killTree(child); n++; }
  return n;
}

// 运行一次 agent，流式回调 onChunk({content, done, error})；scope 用于停止定位
function runAgent(agent, prompt, onChunk, scope) {
  const runner = resolveRunner();

  if (runner.kind === 'missing') {
    onChunk({ content: '', done: true, error: MISSING_HINT });
    return null;
  }

  if (runner.kind === 'demo') {
    const env = {
      ...process.env,
      MOCK_BEHAVIOR: agent.behavior || 'echo',
      MOCK_AGENT_ID: agent.id
    };
    return spawnMock([MOCK_SCRIPT, prompt], agent, env, onChunk, scope);
  }

  // ---------- opencode 真实执行 ----------
  const args = ['run', '--format', 'json'];

  const model = agent.model || process.env.AGENTS_CHAT_MODEL || '';
  if (model && MODEL_RE.test(model)) {
    args.push('-m', model);
  } else if (model) {
    // 格式非法的模型配置忽略并提示，使用 opencode 自身默认模型
    console.warn(`[agent] 忽略格式非法的模型配置（应为 provider/model，如 openai/gpt-4o）: ${JSON.stringify(model)}`);
  }

  // 非交互模式下 opencode 对权限请求默认自动拒绝，会导致无法真实干活；
  // 因此默认加 --auto（自动批准未被显式拒绝的权限），.env 可用 AGENTS_CHAT_AUTO_APPROVE=0 关闭
  if (process.env.AGENTS_CHAT_AUTO_APPROVE !== '0') {
    args.push('--auto');
  }

  // 人设注入：opencode run 不支持自定义 system prompt，拼进 prompt 开头
  const fullPrompt = agent.systemPrompt
    ? `${agent.systemPrompt}\n\n${prompt}`
    : prompt;

  return spawnOpenCode(runner, args, fullPrompt, agent, onChunk, scope);
}

// 智能体工作目录：
// - 配置了有效 cwd → 用之（相关文件资料保存在该文件夹）
// - 否则默认每个智能体独立工作区 <数据目录>/workspaces/<agentId>/，避免多智能体互踩文件
function resolveCwd(agent) {
  const custom = agent && agent.cwd;
  if (custom && typeof custom === 'string') {
    try { if (fs.existsSync(custom) && fs.statSync(custom).isDirectory()) return custom; } catch { /* ignore */ }
  }
  const dir = path.join(DATA_DIR, 'workspaces', String((agent && agent.id) || 'default').replace(/[^\w-]/g, '_'));
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  return dir;
}

function spawnOpenCode(runner, args, prompt, agent, onChunk, scope) {
  let child;
  try {
    child = spawn(runner.cmd, args, {
      cwd: resolveCwd(agent),
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: runner.shell,
      windowsHide: true
    });
  } catch (error) {
    onChunk({ content: '', done: true, error: `启动 OpenCode 失败：${error.message}` });
    return null;
  }
  registerChild(child, scope);

  // prompt 全文经 stdin 传入：任意字符都安全
  child.stdin.on('error', () => { /* stdin 已关闭则忽略 */ });
  child.stdin.write(prompt);
  child.stdin.end();

  let stdoutBuf = '';
  let stderrBuf = '';
  let errEvents = [];
  let killed = false;

  // 超时保护：默认 10 分钟，超时强杀整个进程树
  const timeoutMs = Number(process.env.AGENTS_CHAT_TIMEOUT_MS) > 0
    ? Number(process.env.AGENTS_CHAT_TIMEOUT_MS)
    : 600000;
  const timer = setTimeout(() => {
    killed = true;
    killTree(child);
  }, timeoutMs);

  child.stdout.on('data', (data) => {
    stdoutBuf += data.toString();
    let idx;
    while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
      const line = stdoutBuf.slice(0, idx).trim();
      stdoutBuf = stdoutBuf.slice(idx + 1);
      if (!line) continue;
      handleEventLine(line, onChunk, errEvents);
    }
  });

  child.stderr.on('data', (data) => { stderrBuf += data.toString(); });

  child.on('error', (error) => {
    clearTimeout(timer);
    onChunk({ content: '', done: true, error: `调用 OpenCode 失败：${error.message}` });
  });

  child.on('close', (code) => {
    clearTimeout(timer);
    // 处理没有换行结尾的残留行
    if (stdoutBuf.trim()) handleEventLine(stdoutBuf.trim(), onChunk, errEvents);
    let error;
    if (child._stopped) {
      error = '已手动停止';
    } else if (killed) {
      error = `执行超时（超过 ${Math.round(timeoutMs / 1000)} 秒已强制终止）。可在 .env 调大 AGENTS_CHAT_TIMEOUT_MS`;
    } else if (errEvents.length > 0) {
      error = errEvents.join('\n').slice(0, 2000);
    } else if (code !== 0) {
      error = (stderrBuf.trim() || `opencode 进程异常退出（退出码 ${code}）`).slice(0, 2000);
    }
    onChunk({ content: '', done: true, error });
  });

  return child;
}

// 单行 NDJSON 事件解析
function handleEventLine(line, onChunk, errEvents) {
  let ev;
  try {
    ev = JSON.parse(line);
  } catch {
    return; // 非 JSON 行（崩溃输出等）忽略，退出码会兜底
  }
  if (!ev || !ev.type) return;

  if (ev.type === 'text' && ev.part && typeof ev.part.text === 'string') {
    const text = ev.part.text;
    if (text.trim()) onChunk({ content: text, done: false });
    return;
  }
  if (ev.type === 'tool_use' && ev.part) {
    onChunk({ content: `${describeTool(ev.part)}\n`, done: false });
    return;
  }
  if (ev.type === 'error') {
    const e = ev.error;
    let msg;
    if (e && e.data && e.data.message) msg = String(e.data.message);
    else if (e && e.name) msg = String(e.name);
    else msg = JSON.stringify(e).slice(0, 500);
    if (msg) errEvents.push(msg);
  }
  // step_start / step_finish / reasoning 等事件对聊天界面是噪音，忽略
}

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore', timeout: 10000 });
    } else {
      child.kill('SIGKILL');
    }
  } catch { /* 进程可能已退出 */ }
}

// ---------- 演示模式 ----------
function spawnMock(args, agent, env, onChunk, scope) {
  let child;
  try {
    child = spawn(process.execPath, args, {
      cwd: resolveCwd(agent),
      stdio: ['ignore', 'pipe', 'pipe'],
      env
    });
  } catch (error) {
    onChunk({ content: '', done: true, error: String(error) });
    return null;
  }
  registerChild(child, scope);

  let stderrBuf = '';
  child.stdout.on('data', (data) => {
    onChunk({ content: data.toString(), done: false });
  });
  child.stderr.on('data', (data) => { stderrBuf += data.toString(); });
  child.on('error', (error) => {
    onChunk({ content: '', done: true, error: error.message });
  });
  child.on('close', (code) => {
    onChunk({
      content: '',
      done: true,
      error: child._stopped
        ? '已手动停止'
        : (code !== 0 && stderrBuf.trim() ? stderrBuf.trim().slice(0, 2000) : undefined)
    });
  });
  return child;
}

module.exports = { runAgent, resolveRunner, findOpenCode, describeTool, stopScope, stopAllChildren, MISSING_HINT };
