// 零依赖文件解析：MinerU(Flash 云端) + Agnes(视觉) + 原生文本
// 供 /api/chat（服务端注入上下文）与 /api/attachment（独立端点）复用。
// 仅使用 Node 内置 fetch（Node 18+ / Bun），不引入任何 npm 依赖，
// 因此可随 agents-chat 的 npm 包 / 单文件 exe 直接运行，无需 Python。
'use strict';

const MINERU_FLASH_BASE = process.env.MINERU_FLASH_BASE_URL || 'https://mineru.net/api/v1/agent';
const AGNES_BASE = process.env.AGNES_BASE_URL || 'https://apihub.agnes-ai.com/v1';
const AGNES_MODEL = process.env.AGNES_MODEL || 'agnes-2.0-flash';
const { auxChat } = require('./aux-llm');

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp']);
// 注意：MinerU Flash（免登录轻量接口）不支持 html/htm，故 html 走原生文本读取
const MINERU_EXT = new Set(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx']);
// CSV/TSV 原生解析转 Markdown 表格（小表格走 MinerU 属杀鸡用牛刀）
const SHEET_EXT = new Set(['csv', 'tsv']);
const TEXT_EXT = new Set([
  // 文档/数据
  'txt', 'md', 'markdown', 'json', 'xml', 'log', 'yaml', 'yml', 'html', 'htm',
  'rst', 'adoc', 'tex', 'srt', 'vtt', 'ics', 'ndjson', 'jsonl', 'sql',
  // 代码
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'java', 'c', 'h', 'cpp', 'hpp', 'cc',
  'cs', 'go', 'rs', 'rb', 'php', 'swift', 'kt', 'scala', 'lua', 'r', 'dart', 'vue', 'svelte',
  // 脚本/配置
  'sh', 'bash', 'zsh', 'bat', 'cmd', 'ps1', 'env', 'ini', 'toml', 'conf', 'cfg',
  'properties', 'gitignore', 'npmrc', 'editorconfig', 'dockerfile', 'makefile', 'gradle'
]);

const MIME_EXT = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp',
  'image/gif': 'gif', 'image/bmp': 'bmp', 'application/pdf': 'pdf', 'text/csv': 'csv',
  'text/plain': 'txt', 'text/markdown': 'md', 'application/json': 'json',
  'text/xml': 'xml', 'application/xml': 'xml'
};

function extOf(name = '') {
  const m = String(name).toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : '';
}

// 极简 HTML 标签剥离（用于 html/htm 附件的原生文本提取）
function stripHtml(s) {
  return String(s)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

// 无扩展名的惯例命名（Dockerfile/makefile）按文件名识别为文本
const BASENAME_TEXT = new Set(['dockerfile', 'makefile']);

function detectFormat(name, mime) {
  const base = String(name).toLowerCase().trim();
  const e = extOf(name) || MIME_EXT[String(mime || '').toLowerCase()] || '';
  if (IMAGE_EXT.has(e)) return 'image';
  if (MINERU_EXT.has(e)) return 'mineru';
  if (SHEET_EXT.has(e)) return 'sheet';
  if (TEXT_EXT.has(e) || BASENAME_TEXT.has(base)) return 'text';
  return 'unknown';
}

function bufFromData(data) {
  if (Buffer.isBuffer(data)) return data;
  if (data && data.type === 'Buffer' && Array.isArray(data.data)) return Buffer.from(data.data);
  if (typeof data === 'string') return Buffer.from(data, 'base64');
  throw new Error('不支持的附件数据格式');
}

// ---------- Agnes 视觉理解 ----------
async function agnesVision(buffer, mime, opts) {
  const key = (opts && opts.agnesKey) || process.env.AGNES_API_KEY || '';
  if (!key) throw new Error('未配置 AGNES_API_KEY，无法解析图片附件');
  const base = (opts && opts.agnesBase) || AGNES_BASE;
  const model = (opts && opts.agnesModel) || AGNES_MODEL;
  const b64 = buffer.toString('base64');
  const dataUrl = `data:${mime || 'image/png'};base64,${b64}`;
  const prompt = (opts && opts.visionPrompt) ||
    '请尽可能完整地提取并描述这张图片中的全部信息：可见文字、表格、图表数据、布局结构。' +
    '若为扫描文档/截图，请按原文顺序输出文字；若为图表，请描述其结论与关键数值。';
  const resp = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: dataUrl } }
        ]
      }],
      temperature: 0.1,
      max_tokens: 4000
    })
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error(`Agnes ${resp.status}: ${t.slice(0, 200)}`);
  }
  const j = await resp.json().catch(() => ({}));
  const txt = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  return txt || '';
}

// ---------- MinerU Flash（免登录，本地文件字节直传） ----------
async function mineruFlash(buffer, name, opts) {
  const base = (opts && opts.mineruBase) || MINERU_FLASH_BASE;
  const lang = (opts && opts.language) || 'ch';
  // 1) 申请任务与上传地址（source 头为 Flash 轻量接口必需，缺失会导致上传 403）
  const submit = await fetch(`${base}/parse/file`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'source': 'open-api-sdk-js' },
    body: JSON.stringify({ file_name: name, language: lang })
  });
  const sj = await submit.json().catch(() => ({}));
  if (sj.code !== 0) throw new Error(`MinerU 提交失败: ${sj.msg || submit.status}`);
  const taskId = sj.data && sj.data.task_id;
  const fileUrl = sj.data && sj.data.file_url;
  if (!taskId || !fileUrl) throw new Error('MinerU 未返回任务/上传地址');
  // 2) 直传文件字节（预签名 URL 对请求头签名，不可额外加 Content-Type 等头，否则 403）
  const put = await fetch(fileUrl, {
    method: 'PUT',
    body: buffer
  });
  if (!put.ok) throw new Error(`MinerU 上传失败: ${put.status}`);
  // 3) 轮询直至完成
  const deadline = Date.now() + ((opts && opts.timeoutMs) || 120000);
  let interval = 2000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval));
    const r = await fetch(`${base}/parse/${taskId}`);
    const j = await r.json().catch(() => ({}));
    const st = j.data && j.data.state;
    if (st === 'done') {
      const mdUrl = j.data.markdown_url;
      if (!mdUrl) return '';
      const md = await fetch(mdUrl).then((x) => x.text());
      return md;
    }
    if (st === 'failed') throw new Error(`MinerU 解析失败: ${(j.data && j.data.err_msg) || 'unknown'}`);
    interval = Math.min(interval * 2, 15000);
  }
  throw new Error('MinerU 解析超时');
}

// ---------- 原生文本：编码回退 + 表格转 Markdown ----------
function readTextSmart(buffer) {
  const s = buffer.toString('utf8');
  const bad = (s.match(/\uFFFD/g) || []).length;
  if (bad > 0 && bad / Math.max(s.length, 1) > 0.05) {
    return '（非 UTF-8 编码，按 Latin1 读取，可能存在乱码）\n' + buffer.toString('latin1');
  }
  return s;
}

// 轻量 CSV/TSV 行切分：支持双引号包裹与 "" 转义（引号内换行按行边界截断，属已知简化）
function splitDelimLine(line, delim) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false;
      } else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === delim) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

function parseSheetNative(buffer, ext) {
  const raw = readTextSmart(buffer);
  const delim = ext === 'tsv' ? '\t' : ',';
  const lines = raw.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (!lines.length) return '';
  const esc = (s) => String(s).replace(/\|/g, '\\|').trim();
  const MAX_ROWS = 200;
  const rows = lines.slice(0, MAX_ROWS + 1).map((l) => splitDelimLine(l, delim).map(esc));
  const cols = Math.max.apply(null, rows.map((r) => r.length));
  const pad = (r) => { while (r.length < cols) r.push(''); return r; };
  const out = ['| ' + pad(rows[0].slice()).join(' | ') + ' |', '|' + Array(cols).fill(' --- ').join('|') + '|'];
  for (const r of rows.slice(1)) out.push('| ' + pad(r.slice()).join(' | ') + ' |');
  let text = out.join('\n');
  if (lines.length > MAX_ROWS) text += `\n（共 ${lines.length} 行，仅展示前 ${MAX_ROWS} 行）`;
  return `（表格 ${lines.length} 行 × ${cols} 列）\n` + text;
}

// ---------- LLM 预处理：面向 AI 助手的提炼压缩（复用 aux-llm 客户端） ----------
// 图片识别结果不压缩（视觉输出本身即摘要）；仅对超长文档/文本/表格生效。
// 失败一律回退头部截断，绝不阻塞主流程。
const COMPRESS_PROMPT = (maxOut) =>
  '你是文档预处理助手。将用户提供的附件原文提炼为 AI 助手可直接使用的信息，' +
  '严格保留：数字/日期/金额/表格关键行/结论/行动项/人名产品名。\n' +
  '输出三段：\n【概览】一句话\n【要点】不超过 8 条\n【关键原文】逐字保留最重要的片段（数据行/结论句），不超过 600 字\n' +
  `总长控制在 ${maxOut} 字符内。不要输出任何多余说明。\n\n附件原文：\n`;

async function compressWithLLM(text, opts) {
  const o = opts || {};
  const originalLength = text.length;
  const enabled = o.llmCompress !== false;
  const threshold = Number(o.compressThreshold) || 4000;
  const maxOut = Number(o.compressMax) || 2000;
  if (!enabled || originalLength <= threshold || !text.trim()) {
    return { text, compressed: false, originalLength };
  }
  const r = await auxChat(
    [{ role: 'user', content: COMPRESS_PROMPT(maxOut) + text.slice(0, 60000) }],
    {
      base: o.agnesBase, model: o.agnesModel, key: o.agnesKey,
      timeoutMs: Number(o.compressTimeoutMs) || 30000,
      maxTokens: 2500, temperature: 0.2
    }
  );
  if (r.ok && r.text && r.text.length < originalLength) {
    return { text: `【AI 提炼：原文 ${originalLength} 字 → 精华 ${r.text.length} 字】\n${r.text}`, compressed: true, originalLength };
  }
  const reason = r.ok ? '提炼结果不短于原文' : (r.error || '未知原因');
  return {
    text: text.slice(0, maxOut) + `\n…（AI 提炼失败：${reason}；已截断，原文共 ${originalLength} 字符）`,
    compressed: false, originalLength
  };
}

// ---------- 单文件解析 ----------
async function parseAttachment(item, opts) {
  const name = (item && item.name) || 'file';
  let buffer;
  try { buffer = bufFromData(item.data); } catch (e) { return { name, format: 'unknown', engine: null, text: '', compressed: false, originalLength: 0, error: e.message }; }
  const format = detectFormat(name, item.mime);
  try {
    if (format === 'image') {
      const text = await agnesVision(buffer, item.mime, opts);
      // 视觉输出本身即描述性摘要，不再走 LLM 压缩
      return { name, format, engine: 'agnes-vision', text, compressed: false, originalLength: text.length, error: null };
    }
    if (format === 'mineru') {
      const text = await mineruFlash(buffer, name, opts);
      const c = await compressWithLLM(text, opts);
      return { name, format, engine: 'mineru-flash', text: c.text, compressed: c.compressed, originalLength: c.originalLength, error: null };
    }
    if (format === 'sheet') {
      const text = parseSheetNative(buffer, extOf(name));
      if (!text.trim()) return { name, format, engine: 'native-sheet', text: '', compressed: false, originalLength: 0, error: '文件为空或未提取到表格内容' };
      const c = await compressWithLLM(text, opts);
      return { name, format, engine: 'native-sheet', text: c.text, compressed: c.compressed, originalLength: c.originalLength, error: null };
    }
    if (format === 'text') {
      const ext = extOf(name);
      let text = readTextSmart(buffer);
      if (ext === 'html' || ext === 'htm') text = stripHtml(text);
      if (!text.trim()) return { name, format, engine: 'native', text: '', compressed: false, originalLength: 0, error: '文件为空或未提取到文本内容' };
      const c = await compressWithLLM(text, opts);
      return { name, format, engine: 'native', text: c.text, compressed: c.compressed, originalLength: c.originalLength, error: null };
    }
    // unknown：尝试按文本读取，UTF-8 解码含替换符即视为二进制（保持历史行为）
    if (buffer.toString('utf8').includes('\uFFFD')) return { name, format: 'unknown', engine: null, text: '', compressed: false, originalLength: 0, error: '不支持的文件类型，且非可读文本' };
    const text = readTextSmart(buffer);
    // 去除 C0 控制字符后判空：拦截纯控制字节/无有效内容的伪文本（如损坏的音视频头）
    if (!text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').trim()) return { name, format: 'unknown', engine: null, text: '', compressed: false, originalLength: 0, error: '不支持的文件类型，且未能读取到文本内容' };
    const c = await compressWithLLM(text, opts);
    return { name, format: 'unknown', engine: 'native', text: c.text, compressed: c.compressed, originalLength: c.originalLength, error: null };
  } catch (e) {
    return { name, format, engine: null, text: '', compressed: false, originalLength: 0, error: e.message || String(e) };
  }
}

// ---------- 批量：返回聚合文本 + 明细（供注入聊天上下文） ----------
async function parseAttachments(items, opts) {
  const list = Array.isArray(items) ? items : [];
  const maxFiles = (opts && opts.maxFiles) || 5;
  const maxBytes = (opts && opts.maxBytes) || 10 * 1024 * 1024;
  const safe = list.slice(0, maxFiles).filter((it) => {
    try { return bufFromData(it.data).length <= maxBytes; } catch { return false; }
  });
  const parsed = await Promise.all(safe.map((it) => parseAttachment(it, opts)));
  const blocks = [];
  for (const p of parsed) {
    if (p.text && !p.error) blocks.push(`【附件：${p.name}】\n${p.text}`);
  }
  return {
    items: parsed,
    enabled: true,
    text: blocks.length ? `\n\n以下是用户上传的附件内容：\n\n${blocks.join('\n\n')}\n` : '',
    skipped: list.length - safe.length
  };
}

// 前端文件选择器 accept 同步用的支持类型清单（无扩展名惯例命名如 Dockerfile 无法用 accept 精确匹配，宽松忽略）
const ACCEPT_STR = Array.from(new Set([...IMAGE_EXT, ...MINERU_EXT, ...SHEET_EXT, ...TEXT_EXT])).map((e) => '.' + e).join(',');

module.exports = { parseAttachment, parseAttachments, detectFormat, parseSheetNative, readTextSmart, compressWithLLM, MINERU_FLASH_BASE, AGNES_BASE, AGNES_MODEL, ACCEPT_STR };
