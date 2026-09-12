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
  assert.strictEqual(detectFormat('a.csv'), 'sheet');
  assert.strictEqual(detectFormat('a.xyz'), 'unknown');
  assert.strictEqual(detectFormat('x', 'image/jpeg'), 'image');
});

test('detectFormat 类型扩容（代码/配置/表格）', () => {
  assert.strictEqual(detectFormat('a.tsv'), 'sheet');
  assert.strictEqual(detectFormat('main.py'), 'text');
  assert.strictEqual(detectFormat('app.tsx'), 'text');
  assert.strictEqual(detectFormat('Dockerfile'), 'text');
  assert.strictEqual(detectFormat('.gitignore'), 'text');
  assert.strictEqual(detectFormat('settings.toml'), 'text');
});

test('CSV 表格转 Markdown（引擎 native-sheet，含引号与竖线转义）', async () => {
  const csv = 'name,note\n"张三","他说: ""ok"""\n"a|b",2';
  const r = await parseAttachment({ name: 't.csv', mime: 'text/csv', data: b64(csv) });
  assert.strictEqual(r.engine, 'native-sheet');
  assert.strictEqual(r.error, null);
  assert.ok(r.text.includes('（表格 3 行 × 2 列）'));
  assert.ok(r.text.includes('| name | note |'));
  assert.ok(r.text.includes('他说: "ok"'));
  assert.ok(r.text.includes('a\\|b'));
});

test('CSV 超 200 行截断并标注', async () => {
  const rows = ['i,v'];
  for (let i = 0; i < 260; i++) rows.push(`${i},x`);
  const r = await parseAttachment({ name: 'big.csv', mime: 'text/csv', data: b64(rows.join('\n')) });
  assert.ok(r.text.includes('（共 261 行，仅展示前 200 行）'));
  assert.ok(r.text.includes('| 199 | x |'));
  assert.ok(!r.text.includes('| 200 | x |'));
});

test('readTextSmart：非 UTF-8 回退 Latin1 并标注', async () => {
  const buf = Buffer.concat([Buffer.from('caf', 'latin1'), Buffer.from([0xe9])]);
  const r = await parseAttachment({ name: 'legacy.txt', mime: 'text/plain', data: buf.toString('base64') });
  assert.strictEqual(r.error, null);
  assert.ok(r.text.includes('非 UTF-8 编码'));
});

test('compressWithLLM：阈值内不压缩', async () => {
  const { compressWithLLM } = require('../app/lib/attachment');
  const r = await compressWithLLM('短文本', { compressThreshold: 4000 });
  assert.strictEqual(r.compressed, false);
  assert.strictEqual(r.text, '短文本');
  assert.strictEqual(r.originalLength, 3);
});

test('compressWithLLM：llmCompress=false 跳过', async () => {
  const { compressWithLLM } = require('../app/lib/attachment');
  const long = '字'.repeat(5000);
  const r = await compressWithLLM(long, { llmCompress: false });
  assert.strictEqual(r.compressed, false);
  assert.strictEqual(r.text, long);
});

test('compressWithLLM：压缩成功加标注', async () => {
  const { compressWithLLM } = require('../app/lib/attachment');
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '【概览】测试文档概要' } }] }) });
  const long = ('关键数据 42 分。').repeat(500);
  const r = await compressWithLLM(long, { compressThreshold: 4000, agnesKey: 'k', agnesBase: 'https://x/v1', agnesModel: 'm' });
  assert.strictEqual(r.compressed, true);
  assert.ok(r.text.startsWith('【AI 提炼：原文'));
  assert.ok(r.text.includes('精华'));
  assert.ok(r.text.includes('【概览】测试文档概要'));
});

test('compressWithLLM：LLM 失败回退头部截断', async () => {
  const { compressWithLLM } = require('../app/lib/attachment');
  global.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) });
  const long = ('ABCDEFGH').repeat(600);
  const r = await compressWithLLM(long, { compressThreshold: 4000, compressMax: 100, agnesKey: 'k', agnesBase: 'https://x/v1', agnesModel: 'm' });
  assert.strictEqual(r.compressed, false);
  assert.strictEqual(r.originalLength, 4800);
  assert.ok(r.text.includes('AI 提炼失败'));
  assert.ok(r.text.includes('已截断'));
  assert.ok(r.text.length < 300);
});

test('长文本附件全链路：解析后经 AI 提炼', async () => {
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '【要点】提炼内容' } }] }) });
  const long = ('重要结论：营收增长 20%。').repeat(300);
  const r = await parseAttachment({ name: 'report.txt', mime: 'text/plain', data: b64(long) }, { agnesKey: 'k', agnesBase: 'https://x/v1', agnesModel: 'm' });
  assert.strictEqual(r.compressed, true);
  assert.ok(r.text.startsWith('【AI 提炼：原文'));
  assert.strictEqual(r.originalLength, long.length);
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
  const saved = process.env.AGNES_API_KEY;
  delete process.env.AGNES_API_KEY;
  try {
    const r = await parseAttachment({ name: 'pic.png', mime: 'image/png', data: b64('x') });
    assert.ok(r.error && r.error.includes('AGNES_API_KEY'));
  } finally {
    if (saved !== undefined) process.env.AGNES_API_KEY = saved;
  }
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
  assert.ok(att.text.includes('| x | y |'));
  assert.ok(att.text.includes('PDF内容'));
  assert.ok(att.text.includes('【附件：a.csv】'));
});
