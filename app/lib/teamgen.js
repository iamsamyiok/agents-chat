// AI 智能组队：由执行内核根据用户需求生成子智能体团队配置
// 纯函数模块（buildPrompt/extractTeamJSON/cleanSuggestedTeam）可独立单测；
// suggestTeam 注入 runAgentFn 便于测试内核交互链路
const agentMod = require('./agent');

const LIMITS = { name: 20, icon: 8, desc: 100, systemPrompt: 8000 };
const TEAM_MIN = 2;
const TEAM_MAX = 6;
const REQ_MAX = 2000;
const SUGGEST_TIMEOUT_MS = Number(process.env.AGENTS_CHAT_SUGGEST_TIMEOUT_MS) > 0
  ? Number(process.env.AGENTS_CHAT_SUGGEST_TIMEOUT_MS)
  : 120000; // 真实内核生成整队提示词输出量大，60s 偏紧；.env 可覆盖

// 结构化生成提示词：要求内核输出纯 JSON 数组（容错解析见 extractTeamJSON）
function buildPrompt(requirements, existingNames) {
  const avoid = (Array.isArray(existingNames) ? existingNames : [])
    .map(n => String(n || '').trim()).filter(Boolean);
  return [
    '你是一位资深多智能体系统团队设计师。请根据用户需求，设计一支协作完成该需求的智能体团队。',
    '',
    '【用户需求】',
    String(requirements || '').trim(),
    '',
    '【输出要求】只输出一个 JSON 数组，不要输出任何其他文字、解释或 markdown 代码块标记。数组包含 2 到 6 个对象，每个对象字段：',
    '- name：智能体名称，简短（不超过 8 个字），团队内不得重名',
    '- icon：单个 emoji 图标',
    '- desc：一句话技能说明（不超过 50 字），明确该智能体的能力边界，供调度者据此分派任务',
    '- systemPrompt：自定义提示词，包含角色定位、专业技能与输出要求，100 到 300 字，具体可执行',
    '',
    avoid.length ? `【命名避让】以下名称已被现有智能体占用，生成的 name 不得与之重复：${avoid.join('、')}` : '',
    '',
    '【设计原则】',
    '1. 按需求拆解出真正需要的分工，每个智能体职责单一且清晰，避免出现职责重叠的成员',
    '2. 语言与用户需求语言一致（用户用中文则全部用中文）',
    '3. systemPrompt 要具体可执行，写清楚该角色拿到任务后应该怎么做、输出什么格式的成果',
    '4. 若需求较简单，团队从简（2 到 3 个）；需求复杂才增加分工'
  ].filter(line => line !== '').join('\n');
}

// 通用容错提取 JSON 数组（planner 等模块共享）：裸数组 → ```json 代码块 → 首个 [ 到最后一个 ] 的子串
function extractJSONArray(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  // 1. 整体就是合法 JSON
  try { const v = JSON.parse(raw); if (Array.isArray(v)) return v; } catch { /* 继续尝试 */ }
  // 2. markdown 代码块（```json ... ``` 或 ``` ... ```）
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    try { const v = JSON.parse(fence[1].trim()); if (Array.isArray(v)) return v; } catch { /* 继续尝试 */ }
  }
  // 3. 首个 [ 到最后一个 ] 之间（容忍前后杂文；字符串中含 ] 不影响，因为取最后一个 ]）
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start >= 0 && end > start) {
    try { const v = JSON.parse(raw.slice(start, end + 1)); if (Array.isArray(v)) return v; } catch { /* 放弃 */ }
  }
  return null;
}

// 兼容保留：团队配置提取（实现转用通用函数）
function extractTeamJSON(text) {
  return extractJSONArray(text);
}

// 从可能带杂文的输出中提取 JSON 对象（整体 → 代码块 → 首个 { 到最后一个 }）
function extractJSONObject(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  try { const v = JSON.parse(raw); if (v && typeof v === 'object' && !Array.isArray(v)) return v; } catch { /* 继续尝试 */ }
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    try { const v = JSON.parse(fence[1].trim()); if (v && typeof v === 'object' && !Array.isArray(v)) return v; } catch { /* 继续尝试 */ }
  }
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { const v = JSON.parse(raw.slice(start, end + 1)); if (v && typeof v === 'object' && !Array.isArray(v)) return v; } catch { /* 放弃 */ }
  }
  return null;
}

// 清洗生成结果：字段类型归一 + 长度截断 + 空名补名 + 重名后缀 + 数量上限
// existingNames：现有智能体名（含管家），重名自动加序号，保证 @ 点名无歧义
function cleanSuggestedTeam(arr, existingNames) {
  if (!Array.isArray(arr)) return [];
  const names = new Set(['管家', 'butler']);
  for (const n of existingNames || []) {
    const s = String(n || '').trim();
    if (s) names.add(s);
  }
  const clean = [];
  for (const a of arr) {
    if (!a || typeof a !== 'object') continue;
    let name = String(a.name || '').replace(/\s+/g, '').slice(0, LIMITS.name);
    if (!name) name = `智能体${clean.length + 1}`;
    let final = name;
    let i = 2;
    while (names.has(final)) final = `${name}${i++}`;
    names.add(final);
    clean.push({
      name: final,
      icon: String(a.icon || '').trim().slice(0, LIMITS.icon),
      desc: String(a.desc || '').slice(0, LIMITS.desc),
      systemPrompt: String(a.systemPrompt || '').slice(0, LIMITS.systemPrompt)
    });
    if (clean.length >= TEAM_MAX) break;
  }
  return clean;
}

// 完整生成链路：调内核一次 → 容错解析 → 清洗 → 数量校验
// 返回 { success, agents, error }；任何失败都不影响现有配置（调用方不落盘）
async function suggestTeam({ requirements, existingNames, runAgentFn, timeoutMs }) {
  const run = runAgentFn || agentMod.runAgent;
  const timeout = Number(timeoutMs) > 0 ? Number(timeoutMs) : SUGGEST_TIMEOUT_MS;
  const scope = 'teamgen';
  const prompt = buildPrompt(requirements, existingNames);

  let settled = false;
  let content = '';
  let runError = '';
  const done = new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      runError = `生成超时（${Math.round(timeout / 1000)} 秒），请稍后重试或简化需求描述`;
      try { agentMod.stopScope(scope); } catch { /* ignore */ }
      resolve();
    }, timeout);
    try {
      run(
        { id: scope, name: scope, model: '', behavior: 'echo', systemPrompt: '' },
        prompt,
        (chunk) => {
          if (chunk && chunk.content) content += chunk.content;
          if (chunk && chunk.error) runError = runError || String(chunk.error);
          if (chunk && chunk.done && !settled) { settled = true; clearTimeout(timer); resolve(); }
        },
        scope
      );
    } catch (e) {
      if (!settled) { settled = true; clearTimeout(timer); runError = `调用内核失败：${e.message}`; resolve(); }
    }
  });
  await done;

  if (runError) return { success: false, agents: [], error: runError };

  const parsed = extractTeamJSON(content);
  if (!parsed) {
    return { success: false, agents: [], error: '生成结果无法解析为团队配置，请换个说法重试（例如补充更多分工细节）' };
  }
  const agents = cleanSuggestedTeam(parsed, existingNames);
  if (agents.length < TEAM_MIN) {
    return { success: false, agents: [], error: `生成结果只有 ${agents.length} 个智能体，至少需要 ${TEAM_MIN} 个，请补充更多分工细节后重试` };
  }
  return { success: true, agents };
}

module.exports = { buildPrompt, extractTeamJSON, extractJSONArray, extractJSONObject, cleanSuggestedTeam, suggestTeam, LIMITS, TEAM_MIN, TEAM_MAX, REQ_MAX };
