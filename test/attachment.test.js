// 附件解析模块测试：以 mock 的全局 fetch 验证路由与解析逻辑（不依赖真实 MinerU/Agnes）
const test = require('node:test');
const assert = require('node:assert');
const { parseAttachment, parseAttachments, detectFormat } = require('../app/lib/attachment');

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

let realFetch;
test.beforeEach(() => { realFetch = global.fetch; });
test.afterEach(() => { global.fetch = realFetch; });

test('detectFormat 正确分类', () => {
  assert.strictEqual(detectFormat('a.pdf'), 'mineru');
  assert.strictEqual(detectFormat('a.docx'), 'mineru');
  assert.strictEqual(detectFormat('a.png'), 'image');
  assert.strictEqual(detectFormat('a.csv'), 'text');
  assert.strictEqual(detectFormat('a.xyz'), 'unknown');
  assert.strictEqual(detectFormat('x', 'image/jpeg'), 'image');
});

test('原生文本（CSV）直接转文本', async () => {
  const r = await parseAttachment({ name: 't.csv', mime: 'text/csv', data: b64('a,b\n1,2') });
  assert.strictEqual(r.engine, 'native');
  assert.strictEqual(r.error, null);
  assert.ok(r.text.includes('a,b'));
});

test('未知二进制返回错误而非误解析', async () => {
  const bin = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]).toString('base64');
  const r = await parseAttachment({ name: 'x.bin', mime: 'application/octet-stream', data: bin });
  assert.ok(r.error, '应标记不支持');
});

test('图片走 Agnes 视觉（mock）', async () => {
  global.fetch = async (url, opts) => {
    if (String(url).includes('/chat/completions')) {
      const body = JSON.parse(opts.body);
      assert.ok(body.messages[0].content.some((c) => c.type === 'image_url'));
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '看图结果' } }] }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const r = await parseAttachment({ name: 'pic.png', mime: 'image/png', data: b64('imgbytes') }, { agnesKey: 'k' });
  assert.strictEqual(r.engine, 'agnes-vision');
  assert.strictEqual(r.text, '看图结果');
});

test('图片无密钥时报错', async () => {
  const r = await parseAttachment({ name: 'pic.png', mime: 'image/png', data: b64('x') });
  assert.ok(r.error && r.error.includes('AGNES_API_KEY'));
});

test('PDF 走 MinerU Flash（mock 完整流程）', async () => {
  global.fetch = async (url, opts) => {
    const u = String(url);
    if (opts && opts.method === 'POST' && u.endsWith('/parse/file')) {
      return { ok: true, status: 200, json: async () => ({ code: 0, data: { task_id: 't1', file_url: 'https://up/x' } }) };
    }
    if (opts && opts.method === 'PUT') return { ok: true, status: 200 };
    if (u.endsWith('/parse/t1')) return { ok: true, status: 200, json: async () => ({ code: 0, data: { state: 'done', markdown_url: 'https://md/x' } }) };
    if (u === 'https://md/x') return { ok: true, status: 200, text: async () => '# 标题\n正文' };
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const r = await parseAttachment({ name: 'doc.pdf', mime: 'application/pdf', data: b64('%PDF-1.4') });
  assert.strictEqual(r.engine, 'mineru-flash');
  assert.ok(r.text.includes('标题'));
});

test('parseAttachments 聚合多附件文本', async () => {
  global.fetch = async (url, opts) => {
    const u = String(url);
    if (opts && opts.method === 'POST' && u.endsWith('/parse/file')) return { ok: true, status: 200, json: async () => ({ code: 0, data: { task_id: 't1', file_url: 'https://up/x' } }) };
    if (opts && opts.method === 'PUT') return { ok: true, status: 200 };
    if (u.endsWith('/parse/t1')) return { ok: true, status: 200, json: async () => ({ code: 0, data: { state: 'done', markdown_url: 'https://md/x' } }) };
    if (u === 'https://md/x') return { ok: true, status: 200, text: async () => 'PDF内容' };
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const att = await parseAttachments([
    { name: 'a.csv', mime: 'text/csv', data: b64('x,y') },
    { name: 'b.pdf', mime: 'application/pdf', data: b64('%PDF') }
  ], { agnesKey: 'k' });
  assert.ok(att.text.includes('x,y'));
  assert.ok(att.text.includes('PDF内容'));
  assert.ok(att.text.includes('【附件：a.csv】'));
});
