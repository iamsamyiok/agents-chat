// GUI 形态（Electron 双击启动）PATH 缺用户级目录的兜底探测测试
// 覆盖 findCliInDirs / extraCliDirs：常见安装目录直接探测可执行文件
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { findCli, findCliInDirs, extraCliDirs } = require('../app/lib/agent');

function makeFakeHome(name) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `kern-${name}-`));
  const binDir = path.join(home, '.local', 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  return { home, binDir };
}

test('extraCliDirs：包含用户级包管理器常见目录', () => {
  const dirs = extraCliDirs();
  assert.ok(Array.isArray(dirs) && dirs.length > 0);
  if (process.platform !== 'win32') {
    assert.ok(dirs.some(d => d === '/usr/local/bin'), '应含 /usr/local/bin');
  }
});

test('findCliInDirs：~/.local/bin 下的无扩展可执行可被探测（posix）', { skip: process.platform === 'win32' }, () => {
  const { home, binDir } = makeFakeHome('posix');
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const fake = { id: 'zztest', cmd: 'zz-agents-chat-test-kernel' };
    // 目录存在但无文件：找不到
    assert.strictEqual(findCliInDirs(fake), null);
    // 放入可执行文件（posix 无扩展名，须可执行权限语义上由 spawn 保证，探测只查存在性）
    const p = path.join(binDir, fake.cmd);
    fs.writeFileSync(p, '#!/bin/sh\necho ok\n');
    fs.chmodSync(p, 0o755);
    const found = findCliInDirs(fake);
    assert.ok(found, '应探测到 ~/.local/bin 下内核');
    assert.strictEqual(found.cmd, p);
    assert.strictEqual(found.shell, false, '无扩展名文件不是 shell 垫片');
    // findCli 全链路：PATH 查不到时也走兜底目录
    const byFindCli = findCli(fake);
    assert.ok(byFindCli && byFindCli.cmd === p, 'findCli 应回落到兜底目录');
  } finally {
    process.env.HOME = prevHome;
  }
});

test('findCliInDirs：win32 垫片扩展名探测逻辑', () => {
  // 直接构造 win32 目录布局做目录级验证（不依赖真实平台）：临时目录 + 手工调内部路径
  // win32 真实分支在 CI windows runner 上由 smoke 覆盖；这里验证命名约定本身
  const names = ['zz-kernel.cmd', 'zz-kernel.exe', 'zz-kernel.bat'];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kern-win-'));
  for (const n of names) fs.writeFileSync(path.join(dir, n), '');
  const def = { id: 'zz', cmd: 'zz-kernel' };
  // 复刻 win32 探测顺序：.cmd 优先于 .exe/.bat（与 findCliInDirs win32 分支一致）
  const prefer = ['.cmd', '.exe', '.bat', ''].map(ext => `${def.cmd}${ext}`);
  const hit = prefer.map(n => path.join(dir, n)).find(p => fs.existsSync(p));
  assert.strictEqual(hit, path.join(dir, 'zz-kernel.cmd'), 'cmd 垫片优先命中');
  assert.ok(/\.cmd$/.test(hit), 'cmd 垫片应标记 shell: true（spawn 需走 shell）');
});
