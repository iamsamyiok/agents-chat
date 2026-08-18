// 管家长期记忆：跨会话记住用户偏好、项目事实与教训（借鉴 Hermes MEMORY.md/USER.md 双仓设计）
// 鲁棒性原则（任何一步失败都不阻塞、不报硬错）：
// - 写入阶梯：直接写入 → 超限时辅助小模型整理合并 → 辅助失败/输出无效时淘汰最旧条目
// - 一切异常吞掉并返回结果说明，调用方据此展示 💾 提示或静默降级
// - 未配置辅助模型时全部走确定性路径，功能照常
const store = require('./store');
const { auxReady, auxChat, parseAuxJSON } = require('./aux-llm');

const LIMITS = { memory: 2000, user: 1200 }; // 字符上限（约 700/450 tokens，常驻规划上下文）

function memoryEnabled() {
  return process.env.AGENTS_CHAT_MEMORY !== '0';
}

const entryChars = (entries) => entries.reduce((n, e) => n + String(e).length, 0);
const usage = (target) => {
  const d = store.getMemoryData();
  const used = entryChars(d[target]);
  return { used, limit: LIMITS[target], pct: Math.round(used / LIMITS[target] * 100) };
};

// 注入管家的记忆块（冻结快照，带用量便于模型自觉控制）
function memoryBlock(targets) {
  const d = store.getMemoryData();
  const parts = [];
  for (const t of (targets || ['memory', 'user'])) {
    const entries = d[t];
    if (!entries.length) continue;
    const label = t === 'user' ? '用户画像' : '工作笔记';
    const u = usage(t);
    parts.push(`〔${label} ${u.pct}% ${u.used}/${u.limit}字〕\n${entries.join('\n§\n')}`);
  }
  return parts.join('\n\n');
}

// ---------- 确定性整理（无辅助模型时的兜底） ----------
// 淘汰最旧条目直到放得下；至少保留 1 条（单条超长则截断该条）
function makeRoom(entries, incoming, limit) {
  const list = entries.slice();
  while (list.length > 0 && entryChars(list) + incoming.length > limit) list.shift();
  if (!list.length && incoming.length > limit) return [incoming.slice(0, limit)];
  return list;
}

const isDup = (entries, text) => entries.some(e => e.trim() === text.trim());

// ---------- 辅助小模型整理：把现有条目 + 新条目合并成更紧凑的清单 ----------
async function llmConsolidate(target, entries, incoming) {
  const limit = LIMITS[target];
  const label = target === 'user' ? '用户画像' : '工作笔记';
  const res = await auxChat([
    { role: 'system', content: `你是记忆整理器。把「现有条目」与「新条目」合并成一份更紧凑的清单：合并重复信息、删去过时内容、保留全部关键事实。总字数必须不超过 ${limit} 字。直接输出 JSON：{"entries":["条目1","条目2"]}，每条是一句信息密集的完整陈述，不要输出其他内容。` },
    { role: 'user', content: `〔${label}·现有条目〕\n${entries.join('\n§\n') || '（空）'}\n\n〔新条目〕\n${incoming}` }
  ], { maxTokens: 700, timeoutMs: 30000 });
  if (!res.ok) return null;
  const j = parseAuxJSON(res.text);
  if (!j || !Array.isArray(j.entries)) return null;
  const merged = j.entries.map(s => String(s).trim()).filter(Boolean).slice(0, 20);
  if (!merged.length || entryChars(merged) > limit) return null; // 输出仍超限视为无效
  return merged;
}

// ---------- 写入操作（鲁棒阶梯，永不抛异常） ----------
// op: {action:'add'|'replace'|'remove', target:'memory'|'user', content, old}
async function applyOps(ops) {
  const results = [];
  for (const op of (Array.isArray(ops) ? ops : []).slice(0, 10)) {
    const target = op.target === 'user' ? 'user' : 'memory';
    const action = op.action;
    const content = String(op.content || '').trim().slice(0, Math.max(200, LIMITS[target]));
    const old = String(op.old || '').trim();
    if (action !== 'add' && !old) { results.push({ ok: false, why: '缺少 old' }); continue; }

    const d = store.getMemoryData();
    const entries = d[target].slice();
    let note = '';

    if (action === 'remove') {
      const i = entries.findIndex(e => e.includes(old));
      if (i < 0) { results.push({ ok: false, why: '未匹配' }); continue; }
      entries.splice(i, 1);
      note = '删除 1 条';
    } else if (action === 'replace') {
      if (!content) { results.push({ ok: false, why: '缺少 content' }); continue; }
      const i = entries.findIndex(e => e.includes(old));
      if (i < 0) { results.push({ ok: false, why: '未匹配' }); continue; }
      entries[i] = content;
      note = '更新 1 条';
    } else { // add
      if (!content) { results.push({ ok: false, why: '空内容' }); continue; }
      if (isDup(entries, content)) { results.push({ ok: true, note: '重复已跳过', dup: true }); continue; }
      if (entryChars(entries) + content.length <= LIMITS[target]) {
        entries.push(content);
        note = '新增 1 条';
      } else {
        // 超限 → 辅助模型整理；失败 → 淘汰最旧
        const merged = auxReady() ? await llmConsolidate(target, entries, content) : null;
        if (merged) {
          entries.length = 0;
          entries.push(...merged);
          note = `整理合并后写入（${merged.length} 条）`;
        } else {
          entries.length = 0;
          entries.push(...makeRoom(entries, content, LIMITS[target]));
          if (!entries.includes(content)) entries.push(content);
          note = '空间不足，淘汰最旧后写入';
        }
      }
    }
    d[target] = entries;
    store.saveMemoryData(d);
    results.push({ ok: true, note });
  }
  return results;
}

// ---------- 历史回忆：跨会话/跨任务关键词检索（确定性、毫秒级、零 token） ----------
// 返回拼接片段（含来源标注），供规划时注入「以前聊过什么」
function recallFromMessages(allMessages, query, opts) {
  const o = opts || {};
  const terms = String(query || '')
    .replace(/[，。！？、,.!?；;：:\s@]+/g, ' ')
    .split(' ')
    .filter(t => t.length >= 2 && t.length <= 12)
    .slice(0, 8);
  if (!terms.length) return '';
  const curTask = o.excludeTaskId || '';
  const curEpoch = o.excludeEpoch;
  const scored = [];
  for (const m of allMessages) {
    if (!m || !m.content) continue;
    if (curTask && (m.taskId || '') === curTask) continue; // 同一任务的历史不重复回忆（已在工作背景里）
    if (!curTask && curEpoch !== undefined && !m.taskId && (Number(m.epoch) || 0) === curEpoch) continue; // 主会话排除当前轮次（已在会话背景里）
    const text = String(m.content);
    if (text.length < 10) continue;
    let score = 0;
    for (const t of terms) {
      let idx = text.indexOf(t);
      while (idx >= 0 && score < 50) { score++; idx = text.indexOf(t, idx + t.length); }
    }
    if (score >= 2) scored.push({ m, score, text });
  }
  scored.sort((a, b) => b.score - a.score);
  const parts = [];
  let total = 0;
  for (const s of scored.slice(0, 4)) {
    const src = s.m.taskId ? '历史任务' : '早前会话';
    const who = s.m.role === 'user' ? '用户' : (s.m.agentName || '智能体');
    const line = `[${src}] ${who}：${s.text.replace(/\s+/g, ' ').slice(0, 260)}`;
    if (total + line.length > 900) break;
    parts.push(line);
    total += line.length;
  }
  return parts.join('\n');
}

// ---------- 上下文压缩：辅助模型把长历史压成要点（失败→确定性保留结尾） ----------
async function compressHistory(history, opts) {
  const o = opts || {};
  const limit = o.limit || 1200;
  const text = String(history || '').trim();
  if (!text || text.length <= (o.minLen || 4000)) return { text, compressed: false };
  const head = text.slice(0, 200);
  const res = await auxChat([
    { role: 'system', content: `把这段会话历史压缩成不超过 ${limit} 字的要点：保留用户偏好、已做决定、关键事实与结论，去掉寒暄与过程细节。直接输出要点文本。` },
    { role: 'user', content: `${head}\n…（中略）…\n${text.slice(-2500)}` }
  ], { maxTokens: Math.min(900, limit), timeoutMs: 30000 });
  if (res.ok && res.text.length >= 50) {
    return { text: `〔会话历史要点（原文 ${text.length} 字已压缩）〕\n${res.text}`, compressed: true };
  }
  // 确定性回退：直接保留结尾（最近的内容通常最重要）
  return { text: text.slice(-limit), compressed: false };
}

// ---------- 编排后自省：从本轮对话提取值得长期记住的内容 ----------
async function reflectOnRun(digest) {
  if (!auxReady()) return null;
  const mem = memoryBlock(['memory', 'user']);
  const res = await auxChat([
    { role: 'system', content: `你是管家的记忆助手。根据本轮对话提取「值得跨会话长期记住」的信息，只记稳定的偏好与事实，忽略一次性细节。
当前记忆：
${mem || '（空）'}

输出 JSON（无值得记的输出 {"ops":[]}）：
{"ops":[{"action":"add","target":"user 或 memory","content":"一句完整陈述"}],"note":"不超过 15 字的说明"}
target 规则：用户偏好/沟通习惯/身份 → user；项目事实/环境/教训/约定 → memory。
优先 add；若新内容与现有条目重复或更新现有条目，用 {"action":"replace","target":"…","old":"现有条目的唯一片段","content":"更新后的完整条目"}。` },
    { role: 'user', content: digest }
  ], { maxTokens: 500, timeoutMs: 30000 });
  if (!res.ok) return null;
  const j = parseAuxJSON(res.text);
  if (!j || !Array.isArray(j.ops) || !j.ops.length) return null;
  const results = await applyOps(j.ops);
  const applied = results.filter(r => r.ok && !r.dup);
  if (!applied.length) return null;
  return { note: String(j.note || '').slice(0, 30), applied: applied.length, results };
}

module.exports = {
  LIMITS, memoryEnabled, memoryBlock, usage, applyOps,
  recallFromMessages, compressHistory, reflectOnRun, makeRoom, isDup
};
