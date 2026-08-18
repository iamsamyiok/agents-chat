// 辅助小模型客户端：管家记忆整理 / 上下文压缩（任意 OpenAI 兼容接口）
// 设计原则——绝不抛异常、绝不阻塞主流程：
// - 未配置/网络失败/超时/响应异常 → 一律返回 {ok:false}，调用方走确定性回退
// - 超时控制（AbortController）+ 失败重试 1 次（网络错误/429/5xx）
// - Qwen3 等思考型模型兼容：content 为空时回退 reasoning_content，并剥离 <think> 标签
const AUX_BASE = () => String(process.env.AGENTS_CHAT_AUX_BASE_URL || '').trim().replace(/\/+$/, '');
const AUX_MODEL = () => String(process.env.AGENTS_CHAT_AUX_MODEL || '').trim();
const AUX_KEY = () => String(process.env.AGENTS_CHAT_AUX_API_KEY || '').trim();

const PLACEHOLDER_RE = /^your-api-key|^changeme$/i;

function auxReady() {
  const base = AUX_BASE(), model = AUX_MODEL(), key = AUX_KEY();
  return !!(base && model && key && !PLACEHOLDER_RE.test(key));
}

// 剥离思考型模型的 <think>…</think> 段与首尾空白；未闭合的 <think>（流截断，答案未产出）丢弃其后全部内容
function stripThinking(text) {
  return String(text || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/^[\s]*<\/?think>[\s]*$/gim, '')
    .replace(/<think>[\s\S]*$/i, '')
    .trim();
}

// 从 OpenAI 兼容响应中取文本（content 空 → 回退 reasoning_content）
function pickContent(data) {
  const msg = data && data.choices && data.choices[0] && data.choices[0].message;
  if (!msg) return '';
  const c = typeof msg.content === 'string' ? msg.content
    : (Array.isArray(msg.content) && msg.content.map(b => (b && typeof b.text === 'string') ? b.text : '').join('')) || '';
  if (c && c.trim()) return c;
  if (typeof msg.reasoning_content === 'string' && msg.reasoning_content.trim()) return msg.reasoning_content;
  return '';
}

async function auxChatOnce(messages, opts, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(`${AUX_BASE()}/chat/completions`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${AUX_KEY()}`
      },
      body: JSON.stringify({
        model: AUX_MODEL(),
        messages,
        temperature: opts.temperature !== undefined ? opts.temperature : 0.3,
        max_tokens: opts.maxTokens || 600,
        stream: false
      })
    });
    if (!resp.ok) {
      const err = new Error(`HTTP ${resp.status}`);
      err.status = resp.status;
      throw err;
    }
    const data = await resp.json();
    const text = stripThinking(pickContent(data));
    if (!text) return { ok: false, error: '辅助模型返回空内容' };
    return { ok: true, text };
  } finally {
    clearTimeout(timer);
  }
}

// 统一入口：messages=[{role,content}]，返回 {ok, text, error}
// 可重试：网络错误/超时/429/5xx 重试 1 次；4xx（配置错）不重试
async function auxChat(messages, opts) {
  const o = opts || {};
  if (!auxReady()) return { ok: false, error: '辅助模型未配置' };
  const timeoutMs = o.timeoutMs || 45000;
  let last = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await auxChatOnce(messages, o, timeoutMs);
    } catch (e) {
      last = e;
      const status = e && e.status;
      const retryable = !status || status === 429 || status >= 500;
      if (!retryable) break;
    }
  }
  const msg = last && last.name === 'AbortError' ? `辅助模型超时（${Math.round(timeoutMs / 1000)}s）` : `辅助模型调用失败：${(last && last.message) || last}`;
  return { ok: false, error: msg };
}

// 便捷：单轮指令 → 纯文本
async function auxTask(instruction, o) {
  return auxChat([{ role: 'user', content: instruction }], o);
}

// 便捷：要求输出 JSON（截取首个 JSON 对象，容错代码块包裹/前后缀文本）
function parseAuxJSON(text) {
  const raw = String(text || '');
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : raw;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(body.slice(start, end + 1)); } catch { return null; }
}

module.exports = { auxReady, auxChat, auxTask, parseAuxJSON, stripThinking };
