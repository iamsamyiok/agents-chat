'use strict';
// 飞书 IM 桥接：WS 长连接（官方 SDK，自动重连）收消息 → 复用本地群聊编排 → 结果回发飞书
// 设计参考 openclaw extensions/feishu：内容去重键、reply→直发 fallback、HTTP 超时注入、
// 卡片路由（代码块/表格→interactive 卡片，其余→post md 标签）、Typing 表情指示、外层重连守护
const Lark = require('@larksuiteoapi/node-sdk');
const crypto = require('crypto');
const axios = require('axios');

let state = null; // { cfg, hooks, client, ws, botOpenId, botName }
const seenKeys = new Set(); // 去重键（文本=内容摘要，重连重投也能识别）
const guideSent = new Set(); // chatId 引导去重（白名单为空时每个会话只发一次配置引导）
const typingActive = new Set(); // 已加过 Typing 表情的 message_id（防重复添加刷推送）

const HTTP_TIMEOUT_MS = 30000; // SDK 默认 axios 无超时会永久挂起，注入 30s
const REPLY_FALLBACK_CODES = new Set([230011, 231003]); // 回复目标已撤回/不存在 → 降级直发
const TYPING_MAX_AGE_MS = 2 * 60 * 1000; // 旧消息（重放事件）不加 Typing，防刷屏

function log(...a) { console.log('[feishu]', ...a); }

// ---------- HTTP 实例：注入默认超时（openclaw client.ts 模式） ----------
function createHttpInstance(timeoutMs) {
  return axios.create({ timeout: timeoutMs || HTTP_TIMEOUT_MS });
}

// ---------- 去重（openclaw dedupe-key 模式） ----------
// 飞书 WS 断线重连会把同一条文本以全新 message_id/event_id 重投，因此文本消息用
// sha256(sender + chat_id + create_time + content) 做键：create_time 重投不变，真实重发会变
function dedupeKeyOf(data) {
  const msg = (data && data.message) || {};
  const sender = ((data && data.sender || {}).sender_id || {}).open_id || '';
  if (msg.message_type === 'text') {
    const h = crypto.createHash('sha256');
    h.update(`${sender}|${msg.chat_id}|${msg.create_time}|${msg.content || ''}`);
    return 'txt-' + h.digest('hex').slice(0, 24);
  }
  return 'mid-' + (msg.message_id || (data && data.event_id) || '');
}

function rememberKey(key) {
  if (!key) return false;
  if (seenKeys.has(key)) return false;
  seenKeys.add(key);
  if (seenKeys.size > 800) {
    for (const d of [...seenKeys].slice(0, 400)) seenKeys.delete(d);
  }
  return true;
}

// 兼容保留：event_id 去重（供测试与外部使用）
function rememberEvent(id) { return id ? rememberKey('evt-' + id) : false; }

// ---------- 消息解析 ----------
// 解析飞书消息 content 为纯文本：text 直取（@ 占位符还原为名字）；post 富文本递归渲染；卡片浅提取
function extractText(msg) {
  try {
    const type = msg.message_type || 'text';
    const raw = msg.content || '{}';
    if (type === 'text') {
      let text = String(JSON.parse(raw).text || '');
      for (const m of msg.mentions || []) {
        if (m && m.key) text = text.split(m.key).join('@' + (m.name || '成员'));
      }
      return text.trim();
    }
    if (type === 'post') {
      const obj = JSON.parse(raw);
      const post = obj.post || obj; // 兼容新旧结构
      const lang = post.zh_cn || post.en_us || Object.values(post).find((v) => v && v.content) || {};
      return postToText(lang).trim();
    }
    if (type === 'interactive') return cardToText(safeJson(raw)).trim();
    return '';
  } catch { return ''; }
}

function safeJson(s) { try { return JSON.parse(s); } catch { return {}; } }

function postToText(post) {
  const lines = [];
  for (const block of post.content || []) {
    let line = '';
    for (const el of block || []) {
      if (el.tag === 'text' || el.tag === 'a') line += el.text || '';
      else if (el.tag === 'at') line += '@' + (el.user_name || el.user_id || '成员');
      else if (el.tag === 'img') line += '[图片]';
      else if (el.tag === 'media') line += '[视频]';
      else if (el.tag === 'emotion') line += el.emoji_type || '';
      else if (el.tag === 'code_block') line += '\n```\n' + (el.content || (el.elements || []).map((e) => e.text || '').join('')) + '\n```\n';
      else if (el.tag === 'md') line += el.text || '';
    }
    lines.push(line);
  }
  return (post.title ? `${post.title}\n` : '') + lines.join('\n');
}

function cardToText(card) {
  const parts = [];
  const walk = (el) => {
    if (!el || typeof el !== 'object') return;
    if (el.tag === 'markdown' && el.content) parts.push(el.content);
    else if (el.tag === 'plain_text' && el.content) parts.push(el.content);
    else if (el.tag === 'div' && el.text) walk(el.text);
    else if (Array.isArray(el.elements)) el.elements.forEach(walk);
    else if (Array.isArray(el.fields)) el.fields.forEach((f) => { walk(f.text); walk(f.content); });
  };
  if (card.elements) card.elements.forEach(walk);
  if (card.body && card.body.elements) card.body.elements.forEach(walk);
  return parts.join('\n');
}

// 给用户的媒体占位提示（媒体下载暂不支持）
function mediaHint(msg) {
  const map = { image: '🖼 图片', file: '📎 文件', audio: '🎤 语音', video: '🎬 视频', media: '🎬 视频', sticker: '😊 表情' };
  const name = map[msg.message_type] || '该类型消息';
  return `${name}暂不支持远程处理，请在网页端发送，或直接用文字描述需求。`;
}

// ---------- 发送 ----------
// 卡片路由（openclaw renderMode=auto 模式）：含代码块/表格 → interactive 卡片；否则 post md 标签
function wantsCard(text) { return /```|^\s*\|.+\|/m.test(text); }

function buildCardContent(text, note) {
  const elements = [{ tag: 'markdown', content: text }];
  if (note) elements.push({ tag: 'hr' }, { tag: 'markdown', content: `<font color='grey'>${note}</font>` });
  return JSON.stringify({ schema: '2.0', config: { width_mode: 'fill' }, body: { elements } });
}

function buildPostContent(text) {
  return JSON.stringify({ zh_cn: { content: [[{ tag: 'md', text }]] } });
}

// 按段落边界分段（优先 \n\n，其次 \n，最后硬切）；保证 ``` 围栏不跨段截断
function splitSegments(text, limit) {
  const MAX = limit || 3800;
  const t = String(text || '').trim();
  if (t.length <= MAX) return t ? [t] : [];
  const parts = [];
  let rest = t;
  while (rest.length > MAX) {
    let window = rest.slice(0, MAX);
    const fence = (window.match(/```/g) || []).length;
    if (fence % 2 === 1) {
      // 围栏不完整：回退到围栏收口处，保住代码块完整性
      const close = window.lastIndexOf('```');
      if (close > MAX * 0.3) window = window.slice(0, close + 3);
    }
    let cut = window.lastIndexOf('\n\n');
    if (cut < window.length * 0.3) cut = window.lastIndexOf('\n');
    if (cut < window.length * 0.3) cut = window.length;
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).replace(/^\n+/, ''); // 跳过切分处换行（join 时补回）
  }
  if (rest.trim()) parts.push(rest);
  return parts;
}

async function sendRaw(chatId, msgType, content) {
  if (!state || !state.client || !chatId) return null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const resp = await state.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, msg_type: msgType, content }
      });
      return resp && resp.data;
    } catch (e) {
      if (attempt >= 2) { log('发送失败 chat=' + String(chatId).slice(0, 12) + '…:', e && (e.message || e)); return null; }
      await new Promise((r) => setTimeout(r, 1200));
    }
  }
  return null;
}

// reply 优先（串话题），回复目标已撤回时降级直发（openclaw sendReplyOrFallbackDirect 模式）
async function sendReplyOrDirect(chatId, replyToMessageId, msgType, content) {
  if (replyToMessageId && state && state.client) {
    try {
      const resp = await state.client.im.message.reply({
        path: { message_id: replyToMessageId },
        data: { msg_type: msgType, content }
      });
      const code = resp && resp.code;
      if (!(code && REPLY_FALLBACK_CODES.has(code))) return resp && resp.data;
      log('回复目标已撤回（' + code + '），降级直发');
    } catch (e) {
      const code = e && (e.response && e.response.data && e.response.data.code);
      if (!code || !REPLY_FALLBACK_CODES.has(code)) log('reply 失败改直发:', e && (e.message || e));
    }
  }
  return sendRaw(chatId, msgType, content);
}

// 对外发送入口：自动路由卡片/post、分段、首段 reply 原消息
async function sendText(chatId, text, replyToMessageId) {
  const segs = splitSegments(text);
  if (!segs.length) return;
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const useCard = wantsCard(seg);
    const content = useCard ? buildCardContent(seg) : buildPostContent(seg);
    const msgType = useCard ? 'interactive' : 'post';
    if (i === 0) await sendReplyOrDirect(chatId, replyToMessageId, msgType, content);
    else await sendRaw(chatId, msgType, content);
    if (segs.length > 1) await new Promise((r) => setTimeout(r, 300));
  }
}

// ---------- Typing 表情指示（openclaw typing.ts 模式） ----------
// 收到消息加 Typing，开始回复时删除；防坑：旧消息跳过、已存在跳过、失败静默
async function addTyping(msg) {
  try {
    if (!state || !state.client || !msg.message_id) return;
    const age = Date.now() - Number(msg.create_time || 0) * 1000;
    if (msg.create_time && age > TYPING_MAX_AGE_MS) return;
    if (typingActive.has(msg.message_id)) return;
    const resp = await state.client.im.messageReaction.create({
      path: { message_id: msg.message_id },
      data: { reaction_type: { emoji_type: 'Typing' } }
    });
    if (resp && resp.data && resp.data.reaction_id) typingActive.add(msg.message_id);
  } catch { /* 权限不足/限流均静默 */ }
}

async function removeTyping(msg) {
  try {
    if (!state || !state.client || !msg.message_id || !typingActive.has(msg.message_id)) return;
    typingActive.delete(msg.message_id);
    await state.client.im.messageReaction.delete({
      path: { message_id: msg.message_id, reaction_id: 'Typing' }
    });
  } catch { /* 静默 */ }
}

// ---------- 白名单广播（任务完成/审批请求推送） ----------
async function notify(text) {
  if (!state || !state.cfg.pushEnabled || !Array.isArray(state.cfg.allowedChats)) return;
  for (const chatId of state.cfg.allowedChats) {
    try { await sendText(chatId, text); } catch { /* 单群失败不影响其余 */ }
  }
}

// ---------- 交互卡片（WS 长连接回调：EventDispatcher 注册 card.action.trigger） ----------
// 卡片按钮 value 携带 { act, ... }，回调时按 act 分发到 hooks.cardAction
function buildCard(header) {
  return { header, elements: [] };
}
// 通用元素快捷方式
function mdEl(content) { return { tag: 'div', text: { tag: 'lark_md', content } }; }
function btnEl(text, value, type) {
  return { tag: 'button', text: { tag: 'plain_text', content: text }, type: type || 'default', value };
}

// 审批请求卡片：橙头 + 编号/类型/内容 + 批准/驳回按钮（value={act,n}）
function buildApprovalCard({ seq, kind, label, timeoutMin }) {
  const md = [
    `**类型**：${kind === 'plan' ? '方案确认' : kind === 'delivery' ? '交付验收' : (kind || '审批')}`,
    `**内容**：${String(label || '').slice(0, 300) || '（无描述）'}`,
    `**超时**：${timeoutMin || 10} 分钟未处理视为驳回`
  ].join('\n');
  return {
    config: { update_multi: true },
    header: { title: { tag: 'plain_text', content: `⏸ 审批请求 #${seq}` }, template: 'orange' },
    elements: [
      mdEl(md),
      { tag: 'hr' },
      { tag: 'action', actions: [
        btnEl('✅ 批准', { act: 'approve', n: seq }, 'primary'),
        btnEl('✖ 驳回', { act: 'reject', n: seq }, 'danger')
      ] },
      { tag: 'note', elements: [{ tag: 'plain_text', content: `也可回复文本指令：/approve ${seq} 或 /reject ${seq}` }] }
    ]
  };
}

// 批次完成卡片：全成功绿头 / 有失败·阻塞橙头；统计 + 清单 + 查状态按钮
function buildBatchDoneCard({ scope, total, done, failed, blocked, titles }) {
  const bad = (failed || 0) + (blocked || 0) > 0;
  const lines = [
    `**结果**：✅ 完成 ${done || 0}` +
      (failed ? ` · ❌ 失败 ${failed}` : '') +
      (blocked ? ` · ⛔ 阻塞 ${blocked}` : '') +
      ` / 共 ${total || 0} 个`
  ];
  const list = (titles || []).slice(0, 10).map(t => '· ' + String(t).slice(0, 40)).join('\n');
  if (list) lines.push(list);
  if ((titles || []).length > 10) lines.push(`…等共 ${titles.length} 个任务`);
  return {
    config: { update_multi: true },
    header: { title: { tag: 'plain_text', content: `${bad ? '⚠️' : '✅'} ${scope || ''}任务批次完成`.trim() }, template: bad ? 'orange' : 'green' },
    elements: [
      mdEl(lines.join('\n')),
      { tag: 'hr' },
      { tag: 'action', actions: [btnEl('📋 任务状态', { act: 'status' }, 'default')] },
      { tag: 'note', elements: [{ tag: 'plain_text', content: '失败任务可在网页端重跑；发送 /status 可随时查看运行状态' }] }
    ]
  };
}

// 卡片动作分发（独立导出便于单测）：白名单校验 → 去重 → hooks.cardAction 分发 → toast 响应
// 返回 { ok, toast }；toast 结构可直接作为回调响应
async function dispatchCardAction(data, hooks, opts) {
  const o = opts || {};
  const allowedChats = o.allowedChats || [];
  const event = data || {};
  const ctx = event.context || {};
  const chatId = ctx.open_chat_id || event.open_chat_id || '';
  const messageId = ctx.open_message_id || event.open_message_id || '';
  const operator = ((event.operator || {}).open_id) || '';
  const val = (event.action || {}).value || {};
  if (!chatId || !allowedChats.includes(chatId)) {
    return { ok: false, toast: { type: 'error', content: '当前会话不在白名单内' } };
  }
  const dedupeKey = 'act-' + crypto.createHash('sha256')
    .update(`${messageId}|${operator}|${JSON.stringify(val)}`).digest('hex').slice(0, 24);
  if (!rememberKey(dedupeKey)) return { ok: false, toast: null }; // 重投/重复点击：静默
  let reply = '';
  let toastType = 'success';
  try {
    reply = String((await hooks.cardAction(val)) || '');
  } catch (e) {
    log('卡片动作处理失败:', e && (e.message || e));
    reply = '处理失败：' + (e && e.message || e);
    toastType = 'error';
  }
  if (/失败|未找到|不存在|错误/.test(reply)) toastType = 'error';
  else if (val.act === 'status') toastType = 'info';
  // 结果留痕（详细文本）；toast 仅即时反馈
  try { await sendText(chatId, reply); } catch { /* 留痕失败不影响响应 */ }
  return { ok: true, toast: { type: toastType, content: reply.slice(0, 60) } };
}

async function sendCard(chatId, card, replyToMessageId) {
  if (!state || !chatId || !card) return false;
  const content = JSON.stringify(card);
  const resp = await sendReplyOrDirect(chatId, replyToMessageId, 'interactive', content);
  return !!resp;
}

// 卡片广播：返回成功送达的会话数（0 = 未启用/全失败，调用方可文本兜底）
async function notifyCard(card) {
  if (!state || !state.cfg.pushEnabled || !Array.isArray(state.cfg.allowedChats)) return 0;
  let sent = 0;
  for (const chatId of state.cfg.allowedChats) {
    try { if (await sendCard(chatId, card)) sent++; } catch { /* 单群失败不影响其余 */ }
  }
  return sent;
}

// ---------- 命令与派活 ----------
function helpText() {
  return [
    '🤖 AgentsChat 飞书桥接可用指令：',
    '/tasks — 查看任务列表',
    '/status — 查看运行状态',
    '/stop — 停止当前编排',
    '/approvals — 查看待审批',
    '/approve <编号> — 通过审批',
    '/reject <编号> — 驳回审批',
    '审批与批次完成会推送交互卡片，可直接点按钮处理',
    '其他任意文字 = 直接派活给团队（群聊里请 @ 机器人）'
  ].join('\n');
}

async function handleMessage(data) {
  const { hooks } = state;
  const msg = data.message || {};
  const chatId = msg.chat_id;
  const raw = extractText(msg);
  if (!raw) { await sendText(chatId, mediaHint(msg)); return; }
  // 按 mentions 精确剥离 @机器人（其余 @ 已还原为名字保留可读形态）
  let cleaned = raw;
  for (const m of msg.mentions || []) {
    if (m && m.key && state.botOpenId && m.id && m.id.open_id === state.botOpenId) {
      cleaned = cleaned.split(m.key).join('');
    }
  }
  cleaned = cleaned.trim() || raw;
  log('收到消息 chat=' + String(chatId).slice(0, 12) + '… len=' + cleaned.length);
  await addTyping(msg);
  try {
    const m = cleaned.match(/^\/(help|tasks|status|stop|approvals|approve|reject)(?:@\S+)?\s*(\S+)?\s*$/i);
    let replyText;
    if (m) {
      const cmd = m[1].toLowerCase();
      const arg = (m[2] || '').trim();
      if (cmd === 'help') replyText = helpText();
      else if (cmd === 'tasks') replyText = await hooks.listTasks();
      else if (cmd === 'status') replyText = await hooks.status();
      else if (cmd === 'stop') replyText = await hooks.stop();
      else if (cmd === 'approvals') replyText = await hooks.approvals();
      else if (cmd === 'approve' || cmd === 'reject') {
        const num = parseInt(arg, 10);
        if (!num) replyText = '用法：/' + cmd + ' <编号>，先用 /approvals 查看列表';
        else replyText = await hooks.resolveApproval(num, cmd === 'approve');
      }
    } else if (cleaned.startsWith('/')) {
      replyText = '未知指令，发送 /help 查看可用命令';
    } else {
      await hooks.runGroupChat(cleaned, (reply) => sendText(chatId, reply, msg.message_id));
      await removeTyping(msg);
      return;
    }
    await removeTyping(msg);
    await sendText(chatId, replyText, msg.message_id);
  } catch (e) {
    await removeTyping(msg);
    log('处理失败:', e && (e.message || e));
    try { await sendText(chatId, '任务执行异常：' + (e && e.message || e), msg.message_id); } catch { /* ignore */ }
  }
}

// ---------- 连接 ----------
// SDK 未封装 /bot/v4/info：自取 tenant_access_token 后直调（openclaw media/tenant token 自管模式）
function feishuBase() { return state && state.cfg.domain === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn'; }

async function probeBot() {
  try {
    const base = feishuBase();
    const tok = await axios.post(base + '/open-apis/auth/v3/tenant_access_token/internal',
      { app_id: state.cfg.appId, app_secret: state.cfg.appSecret }, { timeout: 15000 });
    const token = tok.data && tok.data.tenant_access_token;
    if (!token) throw new Error(tok.data && tok.data.msg || '未取得 tenant_access_token');
    const resp = await axios.get(base + '/open-apis/bot/v3/info', {
      headers: { Authorization: 'Bearer ' + token }, timeout: 15000
    });
    const bot = (resp.data && (resp.data.bot || (resp.data.data && resp.data.data.bot))) || {};
    state.botOpenId = bot.open_id || '';
    state.botName = bot.app_name || '';
    if (state.botOpenId) log('机器人身份就绪：' + state.botName + '（防回环已启用）');
    else log('bot.info 返回异常：code=' + (resp.data && resp.data.code));
  } catch (e) { log('bot.info 探测失败（不影响收发，仅少了防回环）:', e && (e.message || e)); }
}

function start(cfg, hooks) {
  stop();
  if (!cfg || !cfg.enabled || !cfg.appId || !cfg.appSecret) return false;
  if (!Array.isArray(cfg.allowedChats)) cfg.allowedChats = [];
  // 白名单允许为空启动：首条消息会回复该会话的 chatId，引导用户回填白名单（防止鸡生蛋问题）
  try {
    const domain = cfg.domain === 'lark' ? Lark.Domain.Lark : Lark.Domain.Feishu;
    const client = new Lark.Client({ appId: cfg.appId, appSecret: cfg.appSecret, domain, httpInstance: createHttpInstance(HTTP_TIMEOUT_MS) });
    const dispatcher = new Lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data) => {
        try {
          if (!state) return;
          const msg = data && data.message;
          if (!msg || !msg.message_id || !msg.chat_id) return;
          // 防回环：机器人自己的消息直接丢弃
          if (state.botOpenId && ((data.sender || {}).sender_id || {}).open_id === state.botOpenId) return;
          // 内容级去重（重连重投同文不同 id 也能识别）
          if (!rememberKey(dedupeKeyOf(data))) return;
          const allowed = state.cfg.allowedChats.includes(msg.chat_id);
          if (!allowed && state.cfg.allowedChats.length > 0) return; // 已配白名单：非白名单会话静默忽略
          if (!allowed) {
            if (guideSent.has(msg.chat_id)) return;
            guideSent.add(msg.chat_id);
            await sendText(msg.chat_id, [
              '👋 我是 AgentsChat 桥接机器人，连接还没完成最后一步：',
              `本会话 chatId：${msg.chat_id}`,
              '请把它填入 网页端配置页 → IM 桥接（飞书）→ 白名单 chatId，保存后即可在这里派活。'
            ].join('\n'), msg.message_id);
            log('白名单为空，已向新会话发送 chatId 引导：' + String(msg.chat_id).slice(0, 14) + '…');
            return;
          }
          await handleMessage(data);
        } catch (e) { log('事件处理异常:', e && (e.message || e)); }
      },
      // 卡片按钮点击回调（WS 长连接直收，无需公网 HTTP）：toast 即时反馈 + 文本留痕
      'card.action.trigger': async (data) => {
        try {
          if (!state || !state.hooks || !state.hooks.cardAction) {
            return { toast: { type: 'error', content: '卡片回调未配置' } };
          }
          const r = await dispatchCardAction(data, state.hooks, {
            allowedChats: state.cfg.allowedChats || []
          });
          return r.toast || {};
        } catch (e) {
          log('卡片回调异常:', e && (e.message || e));
          return { toast: { type: 'error', content: '处理失败，请稍后重试' } };
        }
      }
    });
    const ws = new Lark.WSClient({
      appId: cfg.appId,
      appSecret: cfg.appSecret,
      domain,
      loggerLevel: 'warn',
      autoReconnect: true,
      onReady: () => { log('长连接已建立，等待消息（白名单 ' + cfg.allowedChats.length + ' 个会话）'); probeBot(); },
      onReconnecting: () => log('连接断开，重连中…'),
      onReconnected: () => log('已重新连接'),
      onError: (e) => {
        log('连接错误:', e && (e.message || e));
        // 外层重连守护：SDK 内层自动重连耗尽（终端错误）时整客户端重建，指数退避
        if (/reconnect exhausted|autoReconnect is disabled/i.test(String(e && e.message))) {
          const delay = 30000;
          log(`重连耗尽，${delay / 1000}s 后重建客户端`);
          setTimeout(() => { if (state && state.cfg === cfg) start(cfg, hooks); }, delay);
        }
      }
    });
    ws.start({ eventDispatcher: dispatcher });
    state = { cfg, hooks, client, ws, botOpenId: '', botName: '' };
    log('桥接已启动');
    return true;
  } catch (e) {
    log('启动失败:', e && (e.message || e));
    state = null;
    return false;
  }
}

function stop() {
  if (!state) return;
  const cfgRef = state.cfg;
  try { if (state.ws && typeof state.ws.close === 'function') state.ws.close(); } catch { /* ignore */ }
  state = null;
  typingActive.clear();
  log('桥接已停止');
}

function reloadConfig(cfg) {
  if (!state) return false;
  const hooks = state.hooks;
  return start({ ...state.cfg, ...cfg }, hooks);
}

function isRunning() { return !!state; }
function getConfig() { return state ? { ...state.cfg, appSecret: '' } : null; }

module.exports = {
  start, stop, notify, reloadConfig, isRunning, getConfig,
  sendCard, notifyCard, dispatchCardAction, buildApprovalCard, buildBatchDoneCard,
  splitSegments, extractText, rememberEvent,
  dedupeKeyOf, wantsCard, buildCardContent, buildPostContent, postToText, cardToText
};
