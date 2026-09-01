// 零依赖文件解析：MinerU(Flash 云端) + Agnes(视觉) + 原生文本
// 供 /api/chat（服务端注入上下文）与 /api/attachment（独立端点）复用。
// 仅使用 Node 内置 fetch（Node 18+ / Bun），不引入任何 npm 依赖，
// 因此可随 agents-chat 的 npm 包 / 单文件 exe 直接运行，无需 Python。
'use strict';

const MINERU_FLASH_BASE = process.env.MINERU_FLASH_BASE_URL || 'https://mineru.net/api/v1/agent';
const AGNES_BASE = process.env.AGNES_BASE_URL || 'https://apihub.agnes-ai.com/v1';
const AGNES_MODEL = process.env.AGNES_MODEL || 'agnes-2.0-flash';

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp']);
// 注意：MinerU Flash（免登录轻量接口）不支持 html/htm，故 html 走原生文本读取
const MINERU_EXT = new Set(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx']);
const TEXT_EXT = new Set(['csv', 'txt', 'md', 'markdown', 'json', 'xml', 'log', 'tsv', 'yaml', 'yml', 'html', 'htm']);

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

function detectFormat(name, mime) {
  const e = extOf(name) || MIME_EXT[String(mime || '').toLowerCase()] || '';
  if (IMAGE_EXT.has(e)) return 'image';
  if (MINERU_EXT.has(e)) return 'mineru';
  if (TEXT_EXT.has(e)) return 'text';
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

// ---------- 单文件解析 ----------
async function parseAttachment(item, opts) {
  const name = (item && item.name) || 'file';
  let buffer;
  try { buffer = bufFromData(item.data); } catch (e) { return { name, format: 'unknown', engine: null, text: '', error: e.message }; }
  const format = detectFormat(name, item.mime);
  try {
    if (format === 'image') {
      const text = await agnesVision(buffer, item.mime, opts);
      return { name, format, engine: 'agnes-vision', text, error: null };
    }
    if (format === 'mineru') {
      const text = await mineruFlash(buffer, name, opts);
      return { name, format, engine: 'mineru-flash', text, error: null };
    }
    if (format === 'text') {
      const ext = extOf(name);
      let text = buffer.toString('utf8');
      if (ext === 'html' || ext === 'htm') text = stripHtml(text);
      return { name, format, engine: 'native', text, error: null };
    }
    // unknown：尝试按文本读取，若含替换字符视为二进制
    const text = buffer.toString('utf8');
    if (text.includes('�')) return { name, format: 'unknown', engine: null, text: '', error: '不支持的文件类型，且非可读文本' };
    return { name, format: 'unknown', engine: 'native', text, error: null };
  } catch (e) {
    return { name, format, engine: null, text: '', error: e.message || String(e) };
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

module.exports = { parseAttachment, parseAttachments, detectFormat, MINERU_FLASH_BASE, AGNES_BASE, AGNES_MODEL };
