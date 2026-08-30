// .env 加载位置：数据目录 .env（npm/exe 用户配置处）应生效
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

test('数据目录 .env 的 AGENTS_CHAT_MOCK=1 生效（health.runner=demo）', async () => {
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'envfile-'));
  fs.writeFileSync(path.join(DATA, '.env'), 'AGENTS_CHAT_MOCK=1\n');
  const port = 3850 + Math.floor(Math.random() * 40);
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'app', 'server.js'), '--port', String(port)], {
    env: { ...process.env, AGENTS_CHAT_AUTOSTOP: '0', AGENTS_CHAT_DATA: DATA, PORT: String(port) }, // 注意：不注入 AGENTS_CHAT_MOCK
    stdio: ['ignore', 'ignore', 'ignore']
  });
  try {
    let health = null;
    for (let i = 0; i < 40 && !health; i++) {
      await new Promise(r => setTimeout(r, 250));
      try { health = await (await fetch(`http://localhost:${port}/api/health`)).json(); } catch { /* not up */ }
    }
    assert.ok(health, '服务应就绪');
    assert.strictEqual(health.runner, 'demo', '数据目录 .env 中的 AGENTS_CHAT_MOCK=1 应被加载');
  } finally {
    child.kill('SIGKILL');
    child.unref();
  }
});
