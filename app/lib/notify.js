// 完成通知出口：webhook 转发（钉钉/飞书/Telegram bot 的中转地址均可）
// .env AGENTS_CHAT_WEBHOOK_URL 配置后生效；POST {event,title,status,snippet,text}，text 字段可直接被
// 简单集成消费。2 秒超时失败静默——通知是锦上添花，绝不影响任务流程。
let warned = false;

function notifyDone({ kind = 'task', title = '', status = 'done', snippet = '' } = {}) {
  const hook = process.env.AGENTS_CHAT_WEBHOOK_URL;
  if (!hook) return;
  const icon = status === 'done' ? '✅' : status === 'failed' ? '❌' : '⏹';
  const text = `${icon} Agents Chat ${kind === 'card' ? '卡牌' : '任务'}${status === 'done' ? '完成' : status === 'failed' ? '失败' : '已停止'}：${title}${snippet ? '\n' + snippet.slice(0, 200) : ''}`;
  const body = { event: 'done', kind, title, status, snippet: snippet.slice(0, 500), text };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2000);
  fetch(hook, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: ctrl.signal
  }).then(() => { warned = false; })
    .catch(() => {
      if (!warned) { warned = true; console.warn('[notify] webhook 发送失败（后续失败静默）：' + hook); }
    })
    .finally(() => clearTimeout(timer));
}

module.exports = { notifyDone };
