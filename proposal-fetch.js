// @name fetch
// @desc 抓取网页内容并转为纯文本（自动跟随重定向，15 秒超时，超 64KB 截断；JSON 内容自动结构化）
// @essential false
const UA = 'Mozilla/5.0 (compatible; dual-agent-inner/0.3; +https://github.com/iamsamyiok/dual-agent)';

module.exports = {
  params: {
    type: 'object',
    properties: {
      url: { type: 'string', description: '要抓取的 http(s) 网址' },
      raw: { type: 'boolean', description: 'true = 保留原始 HTML（默认自动去除标签提取正文文本）' },
      parseJson: { type: 'boolean', description: 'true = 尝试解析 JSON 并格式化输出（默认 false）' }
    },
    required: ['url']
  },
  run: async (args) => {
    const raw = String(args.url || '').trim();
    if (!/^https?:\/\//i.test(raw)) return 'URL 必须以 http:// 或 https:// 开头';
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 15000);
    try {
      const resp = await fetch(raw, {
        signal: ac.signal, redirect: 'follow',
        headers: { 'User-Agent': UA, Accept: 'text/html,application/json;text/plain,*/*' }
      });
      const ct = resp.headers.get('content-type') || '';
      let body = await resp.text();
      if (body.length > 64 * 1024) body = body.slice(0, 64 * 1024) + '\n…（内容超 64KB 已截断）';
      
      // JSON 自动解析
      if (args.parseJson && /json/i.test(ct)) {
        try {
          const parsed = JSON.parse(body);
          body = JSON.stringify(parsed, null, 2);
          if (body.length > 64 * 1024) body = body.slice(0, 64 * 1024) + '\n…（JSON 超长已截断）';
        } catch { /* 不是合法 JSON，继续用原文 */ }
      }
      
      if (!args.raw && /html/i.test(ct)) {
        // HTML → 粗粒度纯文本：去 script/style/noscript 与标签，压缩空白
        body = body
          .replace(/<script[\s\S]*?<\/script>/gi, ' ')
          .replace(/<style[\s\S]*?<\/style>/gi, ' ')
          .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
          .replace(/<!--[\s\S]*?-->/g, ' ')
          .replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6])\b[^>]*>/gi, '\n')
          .replace(/<[^>]+>/g, ' ')
          .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
          .replace(/[ \t]+/g, ' ')
          .replace(/\n\s*\n+/g, '\n')
          .trim();
      }
      const text = body.length > 6000 ? body.slice(0, 6000) + '\n…（正文超长已截断）' : body;
      return `HTTP ${resp.status} ${ct}\n${text || '（无内容）'}`;
    } catch (e) {
      const msg = e && e.name === 'AbortError' ? '请求超时（15 秒）' : String((e && e.message) || e);
      throw new Error(msg);
    } finally {
      clearTimeout(timer);
    }
  }
};
