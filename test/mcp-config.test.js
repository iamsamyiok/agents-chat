// MCP 配置管理测试：命令解析/校验/打码列表/保存回填与损坏保护
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CFG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-cfg-'));
process.env.XDG_CONFIG_HOME = CFG_DIR; // ocConfigPath 每次调用时读取，require 前设置即可
const mcp = require('../app/lib/mcp');
const { ocConfigPath } = require('../app/lib/oc');

function writeCfg(obj) {
  fs.mkdirSync(path.dirname(ocConfigPath()), { recursive: true });
  fs.writeFileSync(ocConfigPath(), JSON.stringify(obj), 'utf8');
}
function readCfg() {
  return JSON.parse(fs.readFileSync(ocConfigPath(), 'utf8'));
}

test('parseCommandStr：空格切分与引号包裹', () => {
  assert.deepStrictEqual(mcp.parseCommandStr(''), []);
  assert.deepStrictEqual(mcp.parseCommandStr('npx -y @playwright/mcp'), ['npx', '-y', '@playwright/mcp']);
  assert.deepStrictEqual(mcp.parseCommandStr('"C:/Program Files/x.exe" --port 8080'), ['C:/Program Files/x.exe', '--port', '8080']);
  assert.deepStrictEqual(mcp.parseCommandStr('  a   b  '), ['a', 'b']);
});

test('validateMcpServer：local 合法与各类非法', () => {
  const v1 = mcp.validateMcpServer({ name: 'playwright', type: 'local', command: 'npx -y @playwright/mcp', environment: { K: 'v' }, enabled: true });
  assert.ok(v1.ok);
  assert.deepStrictEqual(v1.normalized.command, ['npx', '-y', '@playwright/mcp']);
  assert.strictEqual(v1.normalized.enabled, true);

  assert.ok(!mcp.validateMcpServer({ name: '', type: 'local', command: 'x' }).ok);
  assert.ok(!mcp.validateMcpServer({ name: 'a b', type: 'local', command: 'x' }).ok);
  assert.ok(!mcp.validateMcpServer({ name: 'x', type: 'local', command: '   ' }).ok);
  assert.ok(!mcp.validateMcpServer({ name: 'x', type: 'local', command: 'x' }, new Set(['x'])).ok); // 重名
  assert.ok(!mcp.validateMcpServer({ name: 'r', type: 'remote', url: 'ftp://x' }).ok);
  assert.ok(!mcp.validateMcpServer({ name: 'r', type: 'remote', url: 'http://a b' }).ok);
  // environment 非法（键坏/非对象/值非字符串）
  assert.ok(!mcp.validateMcpServer({ name: 'x', type: 'local', command: 'x', environment: { 'bad key': 'v' } }).ok);
  assert.ok(!mcp.validateMcpServer({ name: 'x', type: 'local', command: 'x', environment: 'str' }).ok);
});

test('listMcpServers：commandStr 还原与 secret 打码', () => {
  writeCfg({
    model: 'x/y',
    mcp: {
      pw: { type: 'local', command: ['npx', '-y', '@playwright/mcp'], environment: { TOKEN: 'secret-abcd' }, enabled: false },
      docs: { type: 'remote', url: 'https://d.example/mcp', headers: { Authorization: 'Bearer key-9999' } }
    }
  });
  const { servers, error } = mcp.listMcpServers();
  assert.strictEqual(error, undefined);
  assert.strictEqual(servers.length, 2);
  const pw = servers.find(s => s.name === 'pw');
  assert.strictEqual(pw.commandStr, 'npx -y @playwright/mcp');
  assert.strictEqual(pw.enabled, false);
  assert.deepStrictEqual(pw.environment.TOKEN, { has: true, tail4: 'abcd' });
  assert.strictEqual(JSON.stringify(servers).includes('secret-abcd'), false); // 明文不回传
  const docs = servers.find(s => s.name === 'docs');
  assert.strictEqual(docs.url, 'https://d.example/mcp');
  assert.deepStrictEqual(docs.headers.Authorization, { has: true, tail4: '9999' });
});

test('saveMcpServers：空 secret 沿用旧值、整表替换、损坏保护', () => {
  writeCfg({
    provider: { custom: { npm: '@ai-sdk/openai-compatible' } },
    mcp: { pw: { type: 'local', command: ['old'], environment: { TOKEN: 'old-secret' } } }
  });
  // 新表：pw 环境变量传空（沿用），并新增 docs；provider.custom 必须保留
  mcp.saveMcpServers([
    { name: 'pw', type: 'local', command: 'new-cmd', environment: { TOKEN: '' }, enabled: true },
    { name: 'docs', type: 'remote', url: 'https://d.example/mcp', headers: { Authorization: 'new-key' } }
  ]);
  const cfg = readCfg();
  assert.ok(cfg.provider && cfg.provider.custom); // 其他字段保留
  assert.deepStrictEqual(cfg.mcp.pw.command, ['new-cmd']);
  assert.strictEqual(cfg.mcp.pw.environment.TOKEN, 'old-secret'); // 空值沿用
  assert.strictEqual(cfg.mcp.docs.headers.Authorization, 'new-key');

  // 校验失败抛错且不落盘
  assert.throws(() => mcp.saveMcpServers([{ name: 'bad name', type: 'local', command: 'x' }]), /名称/);
  assert.strictEqual(readCfg().mcp.pw.command[0], 'new-cmd');

  // 空数组 → 删除 mcp 字段
  mcp.saveMcpServers([]);
  assert.strictEqual(readCfg().mcp, undefined);

  // 配置文件损坏 → 拒绝覆盖（原文件不变）且错误可识别
  const corrupt = '{ broken json';
  fs.writeFileSync(ocConfigPath(), corrupt, 'utf8');
  assert.throws(() => mcp.saveMcpServers([{ name: 'x', type: 'local', command: 'x' }]));
  assert.strictEqual(fs.readFileSync(ocConfigPath(), 'utf8'), corrupt);
  const listed = mcp.listMcpServers();
  assert.ok(listed.error && listed.error.includes('损坏'));
});

test('saveMcpServers：数量上限', () => {
  writeCfg({});
  const many = Array.from({ length: mcp.MAX_SERVERS + 1 }, (_, i) => ({ name: `s${i}`, type: 'local', command: 'x' }));
  assert.throws(() => mcp.saveMcpServers(many), /最多/);
});
