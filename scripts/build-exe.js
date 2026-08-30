#!/usr/bin/env node
/**
 * 单文件 exe 构建（bun compile）
 *
 * 用法:
 *   node scripts/build-exe.js                # 全部平台（windows-x64 / linux-x64 / darwin-x64 / darwin-arm64）
 *   node scripts/build-exe.js windows-x64    # 只构建指定平台
 *
 * 产物: dist/agents-chat-<platform>[.exe]（Windows 为 .exe）
 * 原理: 先把 app/public/*.html 生成内嵌资源模块（app/lib/embedded-assets.js），
 *       再由 bun build --compile 把 server.js + 内嵌资源打包成单可执行文件；
 *       运行时 serveStatic 优先读内嵌资源，磁盘 public 目录仅开发模式使用。
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PUB = path.join(ROOT, 'app', 'public');
const EMBED = path.join(ROOT, 'app', 'lib', 'embedded-assets.js');
const DIST = path.join(ROOT, 'dist');
const PKG = require(path.join(ROOT, 'package.json'));

const ALL_TARGETS = ['windows-x64', 'linux-x64', 'darwin-x64', 'darwin-arm64'];
const targets = process.argv[2] ? [process.argv[2]] : ALL_TARGETS;
for (const t of targets) {
  if (!ALL_TARGETS.includes(t)) {
    console.error(`未知平台: ${t}（可选: ${ALL_TARGETS.join(' / ')}）`);
    process.exit(1);
  }
}

// 1. 生成内嵌资源模块（HTML → JSON 字符串常量，杜绝转义问题）
const assets = {};
for (const f of fs.readdirSync(PUB)) {
  if (f.endsWith('.html')) assets[f] = fs.readFileSync(path.join(PUB, f), 'utf8');
}
fs.writeFileSync(EMBED, [
  '// 本文件由 scripts/build-exe.js 构建时自动生成，勿手工编辑、勿提交仓库',
  `// 内嵌页面资源（构建于 ${new Date().toISOString()}，v${PKG.version}）`,
  'module.exports = ' + JSON.stringify(assets, null, 2) + ';',
  ''
].join('\n'));
console.log(`已生成内嵌资源: ${Object.keys(assets).join('、')}`);

// 2. bun compile 各平台
fs.mkdirSync(DIST, { recursive: true });
let failed = [];
for (const t of targets) {
  const out = path.join(DIST, t === 'windows-x64' ? `agents-chat-${t}.exe` : `agents-chat-${t}`);
  console.log(`构建 ${t} -> ${path.relative(ROOT, out)} ...`);
  // windows: 双击运行不弹命令行窗口（日志自动落到 exe 旁 .data/agents-chat.log）
  const extra = t === 'windows-x64' ? ' --windows-hide-console --windows-title "Agents Chat"' : '';
  try {
    execSync(`bun build --compile --minify --define "process.env.AGENTS_CHAT_STANDALONE=\\"1\\"" --target=bun-${t}${extra} app/server.js --outfile "${path.relative(ROOT, out)}"`, {
      cwd: ROOT, stdio: 'inherit'
    });
    const mb = (fs.statSync(out).size / 1024 / 1024).toFixed(1);
    console.log(`  完成: ${path.relative(ROOT, out)} (${mb} MB)`);
  } catch (e) {
    console.error(`  ${t} 构建失败: ${e.message}`);
    failed.push(t);
  }
}

// 3. 清理中间产物（下次构建重新生成；源码运行不需要它）
try { fs.unlinkSync(EMBED); } catch { /* ignore */ }

if (failed.length) {
  console.error(`失败平台: ${failed.join(', ')}`);
  process.exit(1);
}
console.log('全部构建完成');
