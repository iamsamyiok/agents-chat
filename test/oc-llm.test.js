// LLM 默认模型配置：oc.json merge 读写 / 损坏保护 / auth list 解析
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

process.env.AGENTS_CHAT_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ocllm-data-'));
const XDG = fs.mkdtempSync(path.join(os.tmpdir(), 'ocllm-xdg-'));
process.env.XDG_CONFIG_HOME = XDG; // 必须在 require 前设置？ocConfigPath 运行时读取，require 顺序无影响，但保持先设更稳

const oc = require('../app/lib/oc');
const cfgPath = path.join(XDG, 'opencode', 'opencode.json');

test('默认模型：写入 / 读回 / merge 保留既有字段', () => {
  // 预置用户已有配置（provider 等），写入默认模型不得破坏
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  fs.writeFileSync(cfgPath, JSON.stringify({ $schema: 'https://opencode.ai/config.json', provider: { demo: { name: 'demo' } } }, null, 2));
  oc.writeDefaultModel('monkeycode-ai/glm-5.3');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  assert.strictEqual(cfg.model, 'monkeycode-ai/glm-5.3');
  assert.strictEqual(cfg.$schema, 'https://opencode.ai/config.json'); // 既有字段保留
  assert.ok(cfg.provider.demo);                                       // provider 配置未被冲掉
  assert.strictEqual(oc.readDefaultModel(), 'monkeycode-ai/glm-5.3');
  // 留空 = 清除，恢复内核默认
  oc.writeDefaultModel('');
  assert.strictEqual(oc.readDefaultModel(), '');
  assert.strictEqual(JSON.parse(fs.readFileSync(cfgPath, 'utf8')).model, undefined);
  assert.ok(JSON.parse(fs.readFileSync(cfgPath, 'utf8')).provider.demo); // 其余字段仍在
});

test('默认模型：无配置文件时直接创建', () => {
  fs.rmSync(cfgPath);
  oc.writeDefaultModel('openai/gpt-4o');
  assert.strictEqual(oc.readDefaultModel(), 'openai/gpt-4o');
});

test('默认模型：配置文件损坏拒绝覆盖（防丢配置）', () => {
  fs.writeFileSync(cfgPath, '{"model": "半截');
  assert.throws(() => oc.writeDefaultModel('a/b'), /损坏/);
  assert.strictEqual(fs.readFileSync(cfgPath, 'utf8'), '{"model": "半截'); // 现场保留
  assert.strictEqual(oc.readDefaultModel(), ''); // 读取降级
});

test('parseAuthList：ANSI 颜色码剥离 + 项目符号行解析', () => {
  const sample = '\x1b[0m\n  T  Credentials \x1b[90m~/.local/share/opencode/auth.json\n  |\n  •\x1b[0m \x1b[1mmonkeycode-ai\x1b[22m \x1b[90mapi\x1b[0m\n  |\n  —  1 credentials\n\n  T  Environment\n  |\n  —  No environment variables\n';
  const out = oc.parseAuthList(sample);
  assert.deepStrictEqual(out, [{ provider: 'monkeycode-ai', type: 'api' }]);
  assert.deepStrictEqual(oc.parseAuthList(''), []);
  assert.deepStrictEqual(oc.parseAuthList(null), []);
});

// ---------- 自定义 LLM 接入：provider.custom 读写 / Key 脱敏 / 联动默认模型 ----------

test('自定义接入：写入三项 → provider.custom + 默认模型联动，读回脱敏', () => {
  fs.rmSync(cfgPath, { force: true });
  const r = oc.writeCustomProvider({ baseURL: 'https://api.example.com/v1', apiKey: 'sk-test-1234', model: 'glm-4.6' });
  assert.strictEqual(r.model, 'custom/glm-4.6'); // 安全化后模型 id 即同名
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  assert.strictEqual(cfg.provider.custom.npm, '@ai-sdk/openai-compatible');
  assert.strictEqual(cfg.provider.custom.options.baseURL, 'https://api.example.com/v1');
  assert.strictEqual(cfg.provider.custom.options.apiKey, 'sk-test-1234');
  assert.strictEqual(cfg.provider.custom.models['glm-4.6'].name, 'glm-4.6');
  assert.strictEqual(cfg.model, 'custom/glm-4.6'); // 全局默认联动
  // 读回：明文 Key 不回传，只给 hasApiKey + 尾 4 位
  const back = oc.readCustomProvider();
  assert.strictEqual(back.baseURL, 'https://api.example.com/v1');
  assert.strictEqual(back.model, 'glm-4.6');
  assert.strictEqual(back.hasApiKey, true);
  assert.strictEqual(back.apiKeyTail, '1234');
  assert.ok(!('apiKey' in back)); // 无明文字段
});

test('自定义接入：模型名安全化（非法字符折叠、空占位）', () => {
  fs.rmSync(cfgPath, { force: true });
  const r = oc.writeCustomProvider({ baseURL: 'https://api.example.com/v1', apiKey: '', model: 'Qwen2.5 72B Instruct!' });
  assert.strictEqual(r.modelId, 'Qwen2.5-72B-Instruct');
  assert.strictEqual(r.model, 'custom/Qwen2.5-72B-Instruct');
  assert.strictEqual(oc.sanitizeCustomModelId('///'), 'custom-model'); // 全非法字符 → 占位名
  assert.strictEqual(oc.sanitizeCustomModelId('a'.repeat(100)).length, 64); // 截断
});

test('自定义接入：空 Key 沿用已存 Key；有 Key 时覆盖', () => {
  fs.rmSync(cfgPath, { force: true });
  oc.writeCustomProvider({ baseURL: 'https://a.com/v1', apiKey: 'sk-old-key9999', model: 'm1' });
  // 换 URL/模型但 Key 留空：沿用旧 Key
  oc.writeCustomProvider({ baseURL: 'https://b.com/v1', apiKey: '', model: 'm2' });
  let cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  assert.strictEqual(cfg.provider.custom.options.apiKey, 'sk-old-key9999');
  assert.strictEqual(cfg.model, 'custom/m2');
  // 显式传新 Key：覆盖
  oc.writeCustomProvider({ baseURL: 'https://b.com/v1', apiKey: 'sk-new-key8888', model: 'm2' });
  cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  assert.strictEqual(cfg.provider.custom.options.apiKey, 'sk-new-key8888');
});

test('自定义接入：校验（URL 协议 / 模型名必填 / 损坏保护）', () => {
  fs.rmSync(cfgPath, { force: true });
  assert.throws(() => oc.writeCustomProvider({ baseURL: 'ftp://x', apiKey: 'k', model: 'm' }), /Base URL/);
  assert.throws(() => oc.writeCustomProvider({ baseURL: 'https://a.com/v1 extra', apiKey: 'k', model: 'm' }), /Base URL/);
  assert.throws(() => oc.writeCustomProvider({ baseURL: 'https://a.com/v1', apiKey: 'k', model: '' }), /模型名/);
  assert.throws(() => oc.writeCustomProvider({ baseURL: '', apiKey: 'k', model: 'm' }), /Base URL/);
  // 损坏文件：拒绝覆盖；读取按未配置处理
  fs.writeFileSync(cfgPath, '{broken');
  assert.throws(() => oc.writeCustomProvider({ baseURL: 'https://a.com/v1', apiKey: 'k', model: 'm' }), /损坏/);
  assert.strictEqual(oc.readCustomProvider(), null);
});

test('自定义接入：清除（provider 移除 + 联动默认恢复，其余保留）', () => {
  fs.rmSync(cfgPath, { force: true });
  oc.writeDefaultModel('custom/glm-4.6'); // 模拟联动后的默认
  oc.writeCustomProvider({ baseURL: 'https://a.com/v1', apiKey: 'sk-x', model: 'glm-4.6' });
  oc.writeDefaultModel('custom/glm-4.6');
  // 追加用户其他 provider 与字段
  let cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.provider.other = { name: '其他' };
  cfg.theme = 'dark';
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  assert.strictEqual(oc.clearCustomProvider(), true);
  cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  assert.strictEqual(cfg.provider.custom, undefined); // custom 已移除
  assert.strictEqual(cfg.model, undefined);          // 联动默认一并清除
  assert.ok(cfg.provider.other);                     // 其他 provider 保留
  assert.strictEqual(cfg.theme, 'dark');             // 无关字段保留
  assert.strictEqual(oc.clearCustomProvider(), false); // 再清：无可删
  assert.strictEqual(oc.readCustomProvider(), null);
});

test('自定义接入：未配置 / 非 custom 结构时读取返回 null', () => {
  fs.rmSync(cfgPath, { force: true });
  assert.strictEqual(oc.readCustomProvider(), null); // 无文件
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  fs.writeFileSync(cfgPath, JSON.stringify({ model: 'a/b' }));
  assert.strictEqual(oc.readCustomProvider(), null); // 无 provider.custom
  fs.writeFileSync(cfgPath, JSON.stringify({ provider: { custom: { options: {} } } }));
  assert.strictEqual(oc.readCustomProvider(), null); // custom 无 baseURL 视为无效
});
