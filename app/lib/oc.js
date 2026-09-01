// 单聊工作台引擎：网页会话 ←→ opencode 会话（-s 续聊）
// - chatSolo：spawn `opencode run --format json [-m model] [-s ses_xxx]`，prompt 经 stdin
// - 事件流：text/reasoning 为全量快照（按 partId 覆盖渲染），tool_use 为过程提示
// - 首个 sessionID 事件回填 store，实现同一网页会话跨轮次续聊
// - 非 opencode 内核（claude/codex/pi）无 -s 续聊能力：单聊退化为一次性对话，每轮全新上下文
// - 演示模式（AGENTS_CHAT_MOCK=1）走 mock 子进程，输出模拟为快照事件
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { registerChild, describeTool, resolveCwd } = require('./agent');

const MOCK_SCRIPT = path.join(__dirname, '..', 'mock', 'mock-agent.js');

// 模型标识必须形如 provider/model，且只含安全字符（会进入命令行参数）
const MODEL_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
// opencode 会话 ID（ses_ 开头的安全字符序列）
const OC_SESSION_RE = /^[A-Za-z0-9_-]{1,128}$/;

// ---------- 模型列表：`opencode models` 输出尽力解析（60s 缓存） ----------
let modelCache = { ts: 0, list: null };

function listOcModels(runner, force) {
  if (!runner || runner.kind !== 'opencode' || !runner.cmd) return [];
  if (!force && modelCache.list && Date.now() - modelCache.ts < 60000) return modelCache.list;
  let out = '';
  try {
    // 同步执行（带超时）；输出为人类可读列表，统一按 provider/model 形态抓取
    out = execFileSync(runner.cmd, ['models'], {
      encoding: 'utf8', timeout: 20000, shell: runner.shell,
      windowsHide: true, cwd: resolveCwd(), maxBuffer: 4 * 1024 * 1024
    });
  } catch (e) {
    // 失败时仍可能带部分 stdout，尽力解析
    out = (e && e.stdout) ? String(e.stdout) : '';
  }
  const ids = new Set();
  for (const m of String(out).match(/[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*/g) || []) {
    if (MODEL_RE.test(m)) ids.add(m);
  }
  const list = [...ids].sort().map(id => ({ id, label: id.split('/').pop() }));
  modelCache = { ts: Date.now(), list };
  return list;
}

// 演示模式的假模型列表（仅 UI 可交互，无真实调用）
function demoModels() {
  return [
    { id: 'demo/qwen-plus', label: 'qwen-plus（演示）' },
    { id: 'demo/glm', label: 'glm（演示）' }
  ];
}

// ---------- opencode 事件行 → 统一单聊事件 ----------
// onEvent 事件：
//   {type:'session', ocSessionId}        首个 sessionID（回填续聊）
//   {type:'text', partId, text}          正文快照（覆盖式）
//   {type:'reasoning', partId, text}     思考快照（覆盖式）
//   {type:'tool', partId, name, summary} 工具调用提示
// state.errEvents 收集错误，close 时合并上报
function parseSoloEventLine(line, onEvent, state) {
  let ev;
  try { ev = JSON.parse(line); } catch { return; }
  if (!ev || !ev.type) return;
  if (ev.sessionID && !state.ocSessionId && OC_SESSION_RE.test(String(ev.sessionID))) {
    state.ocSessionId = String(ev.sessionID);
    onEvent({ type: 'session', ocSessionId: state.ocSessionId });
  }
  const part = ev.part;
  if (ev.type === 'text' && part && typeof part.text === 'string') {
    if (part.text.trim()) {
      onEvent({ type: 'text', partId: String(part.id || part.messageID || 'txt'), text: part.text });
    }
    return;
  }
  if (ev.type === 'reasoning' && part && typeof part.text === 'string') {
    if (part.text.trim()) {
      onEvent({ type: 'reasoning', partId: String(part.id || 'rs'), text: part.text });
    }
    return;
  }
  if (ev.type === 'tool_use' && part) {
    const name = String(part.tool || 'tool');
    let summary = '';
    try { summary = describeTool(part).replace(/\n$/, ''); } catch { /* ignore */ }
    state.toolSeq = (state.toolSeq || 0) + 1;
    onEvent({ type: 'tool', partId: `tool-${state.toolSeq}`, name, summary });
    return;
  }
  if (ev.type === 'error') {
    const e = ev.error;
    let msg;
    if (e && e.data && e.data.message) msg = String(e.data.message);
    else if (e && e.name) msg = String(e.name);
    else msg = JSON.stringify(e).slice(0, 500);
    if (msg) state.errEvents.push(msg);
  }
  // step_start / step_finish / message.updated 等对聊天界面是噪音，忽略
}

// ---------- 通用子进程运行器 ----------
// runnerSpec: { cmd, shell, json, cwd }；json=false 时把输出行累积为快照（演示模式用）
function spawnSoloRunner(runnerSpec, args, prompt, env, onEvent, finish, scope) {
  let child;
  try {
    child = spawn(runnerSpec.cmd, args, {
      cwd: runnerSpec.cwd || process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: !!runnerSpec.shell,
      windowsHide: true,
      env: env || process.env
    });
  } catch (error) {
    finish(`启动失败：${error.message}`);
    return null;
  }
  registerChild(child, scope || 'solo'); // 停止/退出清理复用 agent.js 的登记表（scope 可区分编排与追加聊天）

  child.stdin.on('error', () => { /* stdin 已关闭则忽略 */ });
  if (prompt) child.stdin.write(prompt);
  child.stdin.end();

  let stdoutBuf = '';
  let stderrBuf = '';
  let killed = false;
  const state = { ocSessionId: '', errEvents: [], toolSeq: 0, mockText: '', textOrder: [] };

  const timeoutMs = Number(process.env.AGENTS_CHAT_TIMEOUT_MS) > 0
    ? Number(process.env.AGENTS_CHAT_TIMEOUT_MS)
    : 600000;
  const timer = setTimeout(() => { killed = true; killTree(child); }, timeoutMs);

  const runLine = (line) => {
    if (runnerSpec.json) {
      parseSoloEventLine(line, onEvent, state);
    } else {
      // 非 JSON 输出（演示模式）：按行累积成快照
      state.mockText += line + '\n';
      onEvent({ type: 'text', partId: 'mock', text: state.mockText });
    }
  };

  child.stdout.on('data', (data) => {
    stdoutBuf += data.toString();
    let idx;
    while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
      const line = stdoutBuf.slice(0, idx).trim();
      stdoutBuf = stdoutBuf.slice(idx + 1);
      if (line) runLine(line);
    }
  });

  child.stderr.on('data', (data) => { stderrBuf += data.toString(); });

  child.on('error', (error) => {
    clearTimeout(timer);
    finish(`调用失败：${error.message}`, state);
  });

  child.on('close', (code) => {
    clearTimeout(timer);
    if (stdoutBuf.trim()) runLine(stdoutBuf.trim());
    let error;
    if (child._stopped) error = '已手动停止';
    else if (killed) error = `执行超时（超过 ${Math.round(timeoutMs / 1000)} 秒已强制终止）。可在 .env 调大 AGENTS_CHAT_TIMEOUT_MS`;
    else if (state.errEvents.length) error = state.errEvents.join('\n').slice(0, 2000);
    else if (code !== 0) error = (stderrBuf.trim() || `进程异常退出（退出码 ${code}）`).slice(0, 2000);
    finish(error, state);
  });

  return child;
}

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') {
      require('child_process').execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore', timeout: 10000 });
    } else {
      child.kill('SIGKILL');
    }
  } catch { /* 进程可能已退出 */ }
}

// ---------- 单轮对话 ----------
// runnerKind:
//   'demo'：演示模式（mock 子进程，快照事件 + 本地 fake 会话 ID）
//   'opencode'：真实链路（ocSessionId 存在则 -s 续聊；首个 sessionID 事件回填）
//   其他内核：退化为一次性对话（无续聊，文本经 agent.js 内核解析转发）
// onEvent 收到 {type:'done', error} 即本轮结束
function chatSolo(runnerKind, runner, opts, onEvent) {
  const prompt = String(opts.prompt || '');
  const model = String(opts.model || '');
  const ocSessionId = String(opts.ocSessionId || '');
  // 进程归属 scope：停止编排（stopScope('solo')）只杀编排任务，追加聊天用独立 scope 免受牵连
  const scope = String(opts.scope || 'solo');
  // 工作区：指定后 Agent 在该目录读写文件（卡牌可选 workspace；任务隔离 worktree 经 ALS 注入）
  const alsCwd = require('./worktree').currentTaskCwd();
  const cwdInput = opts.cwd || alsCwd;
  const cwd = cwdInput && fs.existsSync(cwdInput) && fs.statSync(cwdInput).isDirectory() ? cwdInput : '';
  // 演示模式按调用场景选择 mock 行为（solo-task 会真实写产出文件，供隔离区 diff 演示）
  const cwdEnv = {
    ...process.env,
    ...(cwd ? { AGENTS_CHAT_CWD: cwd } : {}),
    ...(runnerKind === 'demo' ? { MOCK_BEHAVIOR: String(opts.behavior || 'echo') } : {})
  };

  // ---- 演示模式：mock 子进程 + 快照模拟 ----
  if (runnerKind === 'demo') {
    return spawnSoloRunner(
      { cmd: process.execPath, shell: false, json: false, cwd: cwd || process.cwd() },
      [MOCK_SCRIPT, prompt],
      '',
      cwdEnv,
      onEvent,
      (error) => {
        // 演示模式的会话 ID：续聊时复用传入 ID（打通链路），新任务本地生成（无真实续聊）
        onEvent({ type: 'session', ocSessionId: ocSessionId || 'ses_demo-' + Date.now().toString(36) });
        onEvent({ type: 'done', error });
      },
      scope
    );
  }

  // ---- opencode 真实链路 ----
  if (runnerKind === 'opencode') {
    const args = ['run', '--format', 'json'];
    if (model && MODEL_RE.test(model)) args.push('-m', model);
    if (ocSessionId && OC_SESSION_RE.test(ocSessionId)) args.push('-s', ocSessionId);
    // 附件：opencode 官方 -f/--file 直传（文本/代码/图片原生可读，图片走视觉）
    const files = Array.isArray(opts.files) ? opts.files.filter(f => typeof f === 'string' && fs.existsSync(f)) : [];
    for (const f of files) args.push('-f', f);
    // 非交互模式下 opencode 对权限请求默认自动拒绝，导致无法真实干活；
    // 默认加 --auto，.env 可用 AGENTS_CHAT_AUTO_APPROVE=0 关闭（与群聊一致）
    if (process.env.AGENTS_CHAT_AUTO_APPROVE !== '0') args.push('--auto');
    return spawnSoloRunner(
      { cmd: runner.cmd, shell: runner.shell, json: true, cwd: cwd || resolveCwd() },
      args, prompt, cwdEnv,
      onEvent,
      (error) => onEvent({ type: 'done', error }),
      scope
    );
  }

  // ---- 其他内核（claude/codex/pi）：一次性对话，无续聊 ----
  // 这些内核的文本事件是增量块，这里累积成快照后再发（与 opencode 快照语义对齐）
  const { runAgent } = require('./agent');
  let acc = '';
  return runAgent(
    { model: model || process.env.AGENTS_CHAT_MODEL || '', behavior: 'echo', id: 'solo', name: runner.kernel ? runner.kernel.label : 'AI' },
    prompt,
    (chunk) => {
      if (chunk.content) { acc += chunk.content; onEvent({ type: 'text', partId: 'solo', text: acc }); }
      if (chunk.done) onEvent({ type: 'done', error: chunk.error, noResume: true });
    },
    'solo'
  );
}

// ---------- LLM 默认模型：读写 OpenCode 全局配置（~/.config/opencode/opencode.json 的 model 字段） ----------
function ocConfigPath() {
  const os = require('os');
  const xdg = process.env.XDG_CONFIG_HOME;
  return path.join(xdg || path.join(os.homedir(), '.config'), 'opencode', 'opencode.json');
}

function readDefaultModel() {
  try {
    const cfg = JSON.parse(fs.readFileSync(ocConfigPath(), 'utf8'));
    return typeof cfg.model === 'string' ? cfg.model : '';
  } catch { return ''; } // 无文件/无字段：用内核默认
}

// 读取整份配置对象；无文件返回 {}，损坏抛错（提示人工处理）
function loadOcConfig() {
  const p = ocConfigPath();
  let existed = false;
  try {
    const raw = fs.readFileSync(p, 'utf8');
    existed = true;
    const cfg = JSON.parse(raw);
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error('not an object');
    return cfg;
  } catch (e) {
    if (existed) throw new Error(`OpenCode 配置文件损坏（${p}），请人工检查后再试，已跳过覆盖以防丢失配置`);
    return {};
  }
}

// 原子写回（保留用户其余配置）
function saveOcConfig(cfg) {
  const p = ocConfigPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8');
  fs.renameSync(tmp, p); // 原子替换，中断不留半截
}

// merge 写回（保留用户其余配置）；文件损坏时拒绝覆盖，提示人工处理
function writeDefaultModel(model) {
  const cfg = loadOcConfig();
  if (model) cfg.model = model; else delete cfg.model;
  saveOcConfig(cfg);
}

// ---------- 自定义 LLM 接入：用户自带 OpenAI 兼容端点（baseURL + apiKey + 模型名） ----------
// 写入 opencode.json 的 provider.custom（@ai-sdk/openai-compatible），并联动默认模型 custom/<id>
// API key 不回传明文：读取只回 hasApiKey + 尾 4 位；写入时空 key = 沿用已存 key
const CUSTOM_PROVIDER_ID = 'custom';
const CUSTOM_BASEURL_RE = /^https?:\/\/[^\s]+$/;
const CUSTOM_MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

// 模型名安全化为 provider 内合法 id（非安全字符折叠为 -，空则占位名）
function sanitizeCustomModelId(name) {
  const id = String(name || '').replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
  return id || 'custom-model';
}

function readCustomProvider() {
  let cfg;
  try { cfg = loadOcConfig(); } catch { return null; } // 文件损坏按未配置处理（读取不抛错）
  const pv = cfg.provider && cfg.provider[CUSTOM_PROVIDER_ID];
  if (!pv || typeof pv !== 'object' || !pv.options || !pv.options.baseURL) return null;
  const modelIds = Object.keys(pv.models || {});
  const model = modelIds[0] || '';
  const key = String(pv.options.apiKey || '');
  return {
    baseURL: String(pv.options.baseURL),
    model,
    hasApiKey: !!key,
    apiKeyTail: key ? key.slice(-4) : ''
  };
}

function writeCustomProvider({ baseURL, apiKey, model }) {
  const url = String(baseURL || '').trim();
  const name = String(model || '').trim();
  if (!CUSTOM_BASEURL_RE.test(url)) throw new Error('Base URL 需以 http(s):// 开头且不含空白字符');
  if (!name) throw new Error('模型名不能为空');
  const id = sanitizeCustomModelId(name);
  if (!CUSTOM_MODEL_ID_RE.test(id)) throw new Error('模型名安全化后仍非法');
  const cfg = loadOcConfig();
  const prev = (cfg.provider && cfg.provider[CUSTOM_PROVIDER_ID] && cfg.provider[CUSTOM_PROVIDER_ID].options) || {};
  // apiKey 为空 = 沿用已存 key（前端只在用户换了新 key 时才传值）；端点无鉴权则留空串
  const key = String(apiKey || '').trim() !== '' ? String(apiKey).trim() : (prev.apiKey !== undefined ? String(prev.apiKey) : '');
  if (!cfg.provider || typeof cfg.provider !== 'object') cfg.provider = {};
  cfg.provider[CUSTOM_PROVIDER_ID] = {
    npm: '@ai-sdk/openai-compatible',
    name: `自定义接入 (${name})`,
    options: { baseURL: url, apiKey: key },
    models: { [id]: { name } }
  };
  cfg.model = `${CUSTOM_PROVIDER_ID}/${id}`; // 联动设为全局默认（编排/未指定模型任务直接生效）
  saveOcConfig(cfg);
  return { model: cfg.model, modelId: id };
}

function clearCustomProvider() {
  const cfg = loadOcConfig();
  let removed = false;
  if (cfg.provider && cfg.provider[CUSTOM_PROVIDER_ID]) {
    delete cfg.provider[CUSTOM_PROVIDER_ID];
    removed = true;
    if (Object.keys(cfg.provider).length === 0) delete cfg.provider;
  }
  if (typeof cfg.model === 'string' && cfg.model.startsWith(`${CUSTOM_PROVIDER_ID}/`)) delete cfg.model;
  saveOcConfig(cfg);
  return removed;
}

// `opencode auth list` 人类可读输出 → 已认证 provider 列表（纯函数便于测试）
function parseAuthList(text) {
  const plain = String(text || '').replace(/\x1b\[[0-9;]*m/g, ''); // 去 ANSI 颜色码
  const out = [];
  for (const line of plain.split('\n')) {
    const m = line.match(/^\s*[•*]\s+(\S+)\s+(\S+)/);
    if (m && m[2] !== '—') out.push({ provider: m[1], type: m[2] });
  }
  return out;
}

function authProviders(runnerCmd) {
  try {
    const out = execFileSync(runnerCmd, ['auth', 'list'], { timeout: 8000, encoding: 'utf8' });
    return parseAuthList(out);
  } catch { return null; } // 命令不可用/超时：未知状态（与"明确无认证"区分）
}

module.exports = { chatSolo, listOcModels, demoModels, MODEL_RE, parseSoloEventLine, ocConfigPath, readDefaultModel, writeDefaultModel, parseAuthList, authProviders, readCustomProvider, writeCustomProvider, clearCustomProvider, sanitizeCustomModelId };
