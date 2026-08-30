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
