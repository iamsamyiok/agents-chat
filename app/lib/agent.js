// Agent 运行器：多内核适配（OpenCode / Claude Code / Codex / pi 任选其一）
// - 统一执行协议：非交互 CLI + prompt 经 stdin 传入 + stdout NDJSON 事件流
// - 各内核只实现三件事：命令行参数构造、事件行解析、检测方式
// - 内核选择：配置页下拉框（config.kernel，'auto' 为按检测顺序自动）
// - 未检测到任何内核时显式报错，绝不静默回退演示模式
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

// ---------- 内核注册表 ----------
// 新增内核只需：在此登记 + 实现 buildKernelArgs/parseKernelEvent 两个分支
const KERNEL_DEFS = [
  {
    id: 'opencode', label: 'OpenCode', cmd: 'opencode',
    install: 'npm install -g opencode-ai',
    auth: 'opencode auth login（配置模型与密钥）',
    note: '多 Provider，与本项目默认行为一致'
  },
  {
    id: 'claude', label: 'Claude Code', cmd: 'claude',
    install: 'npm install -g @anthropic-ai/claude-code',
    auth: 'claude 首次运行按提示登录（Anthropic 订阅或 ANTHROPIC_API_KEY）',
    note: 'Anthropic 系模型，headless 文档最完善'
  },
  {
    id: 'codex', label: 'Codex CLI', cmd: 'codex',
    install: 'npm install -g @openai/codex',
    auth: 'codex login（ChatGPT 订阅或 OPENAI_API_KEY）',
    note: 'OpenAI 系模型，自带沙箱隔离'
  },
  {
    id: 'pi', label: 'pi', cmd: 'pi',
    install: 'npm install -g @earendil-works/pi-coding-agent',
    auth: 'pi 内运行 /login（各 Provider 密钥写入 ~/.pi/agent/auth.json）',
    note: '多 Provider 极简内核，MIT 开源'
  }
];

// ---------- CLI 检测（通用 where/which，带 10s 缓存） ----------
// Windows 下 npm 安装的 CLI 是 .cmd 垫片，Node 18.20+ 禁止直接 spawn，须走 shell
// 显式路径优先级：AGENTS_CHAT_<ID>_CMD（如 AGENTS_CHAT_OPENCODE_CMD）> PATH 查找
let detectCache = { ts: 0, map: null };
// 安装新内核后刷新缓存（否则同进程 10 秒内仍认为未安装）
function resetDetectCache() { detectCache = { ts: 0, map: null }; }

function findCli(def) {
  const custom = process.env[`AGENTS_CHAT_${def.id.toUpperCase()}_CMD`];
  if (custom && fs.existsSync(custom)) {
    return { cmd: custom, shell: /\.(cmd|bat)$/i.test(custom) };
  }
  try {
    const finder = process.platform === 'win32' ? `where ${def.cmd}` : `which ${def.cmd}`;
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

function detectKernels() {
  if (detectCache.map && Date.now() - detectCache.ts < 10000) return detectCache.map;
  const map = {};
  for (const def of KERNEL_DEFS) {
    const found = findCli(def);
    map[def.id] = { id: def.id, label: def.label, ok: !!found, cmd: found ? found.cmd : '', shell: !!(found && found.shell) };
  }
  detectCache = { ts: Date.now(), map };
  return map;
}

// 解析当前生效内核：
// - demo：.env 显式 AGENTS_CHAT_MOCK=1
// - <内核id>：配置指定的内核（须已安装）或自动按注册表顺序选第一个已安装的
// - missing：一个都没装 / 选中的内核未安装（missingKernel 指明缺哪个）
const storeRef = require('./store');
function resolveRunner() {
  if (process.env.AGENTS_CHAT_MOCK === '1') {
    return { kind: 'demo', configured: false };
  }
  const detected = detectKernels();
  let pref = '';
  try { pref = String(storeRef.getConfig().kernel || '').trim(); } catch { /* ignore */ }
  if (pref && pref !== 'auto') {
    const def = KERNEL_DEFS.find(k => k.id === pref);
    const d = def && detected[pref];
    if (def && d && d.ok) {
      return { kind: pref, kernel: def, cmd: d.cmd, shell: d.shell, configured: true };
    }
    return { kind: 'missing', configured: false, missingKernel: def || null };
  }
  for (const def of KERNEL_DEFS) {
    const d = detected[def.id];
    if (d && d.ok) return { kind: def.id, kernel: def, cmd: d.cmd, shell: d.shell, configured: true };
  }
  return { kind: 'missing', configured: false, missingKernel: null };
}

function missingHint(runner) {
  if (runner && runner.missingKernel) {
    const k = runner.missingKernel;
    return [
      `未检测到已选择的执行内核 ${k.label}。请先安装并确认命令行可用：`,
      `  ${k.install}`,
      `  ${k.auth}`,
      `安装后重启本程序；也可在 .env 中用 AGENTS_CHAT_${k.id.toUpperCase()}_CMD 指定完整路径。`
    ].join('\n');
  }
  return [
    '未检测到任何可用的智能体内核。请至少安装其中一个：',
    ...KERNEL_DEFS.map(k => `  ${k.label}: ${k.install}（${k.auth}）`),
    '安装后重启本程序；也可在 .env 中用 AGENTS_CHAT_<内核>_CMD 指定完整路径。'
  ].join('\n');
}

// ---------- 各内核：命令行参数构造 ----------
// sessionId：opencode 会话续聊（-s ses_xxx）；群聊多段工作复用同一会话保持工作记忆
const OC_SESSION_RE = /^[A-Za-z0-9_-]{1,128}$/; // 与 oc.js 保持一致（会话 ID 安全字符）
function buildKernelArgs(kernelId, agent, sessionId) {
  const model = agent.model || process.env.AGENTS_CHAT_MODEL || '';

  if (kernelId === 'opencode') {
    const args = ['run', '--format', 'json'];
    if (model && MODEL_RE.test(model)) args.push('-m', model);
    if (sessionId && OC_SESSION_RE.test(sessionId)) args.push('-s', sessionId);
    // 非交互模式下 opencode 对权限请求默认自动拒绝，会导致无法真实干活；
    // 因此默认加 --auto，.env 可用 AGENTS_CHAT_AUTO_APPROVE=0 关闭
    if (process.env.AGENTS_CHAT_AUTO_APPROVE !== '0') args.push('--auto');
    return args;
  }

  if (kernelId === 'claude') {
    // headless print 模式；stream-json 事件流需要 --verbose 才包含 assistant 块
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'];
    // claude 只认纯模型名（如 sonnet / claude-sonnet-4-5），provider/model 取后半
    if (model) args.push('--model', model.split('/').pop());
    return args;
  }

  if (kernelId === 'codex') {
    // exec 非交互 + JSONL 事件流；末尾 "-" 表示 prompt 从 stdin 读
    const args = ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'workspace-write'];
    if (model) args.push('-m', model.split('/').pop());
    args.push('-');
    return args;
  }

  if (kernelId === 'pi') {
    // --mode json 输出 JSONL 事件流；--no-session 不落会话文件（每次全新会话）
    // 位置参数只放一句引导语，完整任务经 stdin 传入（避免命令行长度/转义问题）
    const args = ['--mode', 'json', '--no-session', '请完成标准输入（stdin）中给出的任务，任务说明以 stdin 内容为准。'];
    if (model && MODEL_RE.test(model)) args.push('-m', model);
    return args;
  }

  return null;
}

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

// ---------- 各内核：单行事件解析（统一映射为 onChunk/errEvents） ----------
function parseKernelEvent(kernelId, ev, onChunk, errEvents) {
  // ---- OpenCode：text / tool_use / error / session ----
  if (kernelId === 'opencode') {
    if (ev.type === 'text' && ev.part && typeof ev.part.text === 'string') {
      if (ev.part.text.trim()) onChunk({ content: ev.part.text, done: false });
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
      return;
    }
    // 会话 ID 捕获：非内容事件（step_start 等）携带 sessionID 即回传（-s 续聊锚点）。
    // 注意必须放在 text/tool_use 之后——text 事件顶层同样带 sessionID，先命中会吞掉正文
    if (ev.sessionID && OC_SESSION_RE.test(String(ev.sessionID))) {
      onChunk({ session: String(ev.sessionID), done: false });
    }
    return; // step_start / step_finish / reasoning 等事件对聊天界面是噪音，忽略
  }

  // ---- Claude Code：assistant 内容块 + result 终态 ----
  if (kernelId === 'claude') {
    if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
      for (const b of ev.message.content) {
        if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
          onChunk({ content: b.text, done: false });
        } else if (b.type === 'tool_use' && b.name) {
          onChunk({ content: `${describeTool({ tool: b.name, state: { input: b.input } })}\n`, done: false });
        }
      }
      return;
    }
    if (ev.type === 'result') {
      if (ev.is_error || (ev.subtype && String(ev.subtype).startsWith('error'))) {
        errEvents.push(String(ev.result || ev.subtype || 'claude 执行出错').slice(0, 1000));
      }
      // subtype=success 时 result 为最终文本，assistant 事件已发过，跳过避免重复
    }
    return; // system/init、user（工具结果回灌）等忽略
  }

  // ---- Codex：item.completed 携带成品条目 ----
  if (kernelId === 'codex') {
    if (ev.type === 'item.completed' && ev.item) {
      const it = ev.item;
      if (it.type === 'agent_message' && typeof it.text === 'string' && it.text.trim()) {
        onChunk({ content: it.text, done: false });
      } else if (it.type === 'command_execution') {
        onChunk({ content: `${describeTool({ tool: 'bash', state: { input: { command: it.command } } })}\n`, done: false });
      } else if (it.type === 'file_change') {
        const paths = (it.changes || []).map(c => c.path || '').filter(Boolean).join('、');
        onChunk({ content: `${describeTool({ tool: 'edit', state: { input: { path: paths } } })}\n`, done: false });
      } else if (it.type === 'mcp_tool_call') {
        onChunk({ content: `${describeTool({ tool: it.tool || 'mcp', state: { input: it.arguments || it.input } })}\n`, done: false });
      }
      return; // item.started / item.updated 是过程噪音，reasoning / todo_list 忽略
    }
    if (ev.type === 'error' && ev.message) {
      errEvents.push(String(ev.message).slice(0, 1000));
    } else if (ev.type === 'turn.failed' && ev.error) {
      errEvents.push(String(ev.error.message || ev.error).slice(0, 1000));
    }
    return;
  }

  // ---- pi：message_end 携带最终 assistant 消息（content 块数组） ----
  if (kernelId === 'pi') {
    if (ev.type === 'message_end' && ev.message && ev.message.role === 'assistant') {
      const blocks = Array.isArray(ev.message.content) ? ev.message.content : [];
      for (const b of blocks) {
        if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
          onChunk({ content: b.text, done: false });
        } else if (b.type === 'toolCall' && b.name) {
          onChunk({ content: `${describeTool({ tool: b.name, state: { input: b.arguments } })}\n`, done: false });
        }
      }
      if (ev.message.stopReason === 'error') {
        errEvents.push(String(ev.message.errorMessage || 'pi 执行出错').slice(0, 1000));
      }
    }
    return; // session 头 / agent_* / turn_* / tool_execution_* 事件忽略
  }
}

// 单行 NDJSON 事件解析入口
function handleEventLine(line, kernelId, onChunk, errEvents) {
  let ev;
  try {
    ev = JSON.parse(line);
  } catch {
    return; // 非 JSON 行（崩溃输出等）忽略，退出码会兜底
  }
  if (!ev || !ev.type) return;
  parseKernelEvent(kernelId, ev, onChunk, errEvents);
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
function runAgent(agent, prompt, onChunk, scope, sessionId) {
  const runner = resolveRunner();

  if (runner.kind === 'missing') {
    onChunk({ content: '', done: true, error: missingHint(runner) });
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

  const args = buildKernelArgs(runner.kind, agent, sessionId);
  if (!args) {
    onChunk({ content: '', done: true, error: `内核 ${runner.kind} 暂不支持` });
    return null;
  }

  // 人设注入：各内核均不支持/不宜命令行传 system prompt，统一拼进 prompt 开头
  const fullPrompt = agent.systemPrompt
    ? `${agent.systemPrompt}\n\n${prompt}`
    : prompt;

  return spawnKernel(runner, args, fullPrompt, agent, onChunk, scope);
}

// 智能体工作目录（全局统一）：
// - 任务隔离上下文优先（worktree 任务执行期间注入，见 lib/worktree.js runWithTaskCwd）
// - 环境变量 AGENTS_CHAT_CWD 次之（卡牌 workspace 等单次执行场景注入）
// - 配置了有效 globalCwd → 所有智能体共用该目录（文件资料集中在一处）
// - 否则默认 <数据目录>/workspace/ 共享目录
function resolveCwd() {
  const wtCwd = require('./worktree').currentTaskCwd();
  if (wtCwd) return wtCwd;
  const envCwd = String(process.env.AGENTS_CHAT_CWD || '').trim();
  if (envCwd) {
    try { if (fs.existsSync(envCwd) && fs.statSync(envCwd).isDirectory()) return envCwd; } catch { /* ignore */ }
  }
  let g = '';
  try { g = String(storeRef.getConfig().globalCwd || '').trim(); } catch { /* ignore */ }
  if (g) {
    try { if (fs.existsSync(g) && fs.statSync(g).isDirectory()) return g; } catch { /* ignore */ }
  }
  const dir = path.join(DATA_DIR, 'workspace');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  return dir;
}

function spawnKernel(runner, args, prompt, agent, onChunk, scope) {
  const label = runner.kernel ? runner.kernel.label : runner.kind;
  let child;
  try {
    child = spawn(runner.cmd, args, {
      cwd: resolveCwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: runner.shell,
      windowsHide: true
    });
  } catch (error) {
    onChunk({ content: '', done: true, error: `启动 ${label} 失败：${error.message}` });
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
      handleEventLine(line, runner.kind, onChunk, errEvents);
    }
  });

  child.stderr.on('data', (data) => { stderrBuf += data.toString(); });

  child.on('error', (error) => {
    clearTimeout(timer);
    onChunk({ content: '', done: true, error: `调用 ${label} 失败：${error.message}` });
  });

  child.on('close', (code) => {
    clearTimeout(timer);
    // 处理没有换行结尾的残留行
    if (stdoutBuf.trim()) handleEventLine(stdoutBuf.trim(), runner.kind, onChunk, errEvents);
    let error;
    if (child._stopped) {
      error = '已手动停止';
    } else if (killed) {
      error = `执行超时（超过 ${Math.round(timeoutMs / 1000)} 秒已强制终止）。可在 .env 调大 AGENTS_CHAT_TIMEOUT_MS`;
    } else if (errEvents.length > 0) {
      error = errEvents.join('\n').slice(0, 2000);
    } else if (code !== 0) {
      error = (stderrBuf.trim() || `${label} 进程异常退出（退出码 ${code}）`).slice(0, 2000);
    }
    onChunk({ content: '', done: true, error });
  });

  return child;
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
      cwd: resolveCwd(),
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

module.exports = { runAgent, resolveRunner, detectKernels, resetDetectCache, KERNEL_DEFS, missingHint, describeTool, stopScope, stopAllChildren, resolveCwd, registerChild, buildKernelArgs };
