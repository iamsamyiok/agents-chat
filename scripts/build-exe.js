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
const DIST = path.join(ROOT, 'dist');

const ALL_TARGETS = ['windows-x64', 'linux-x64', 'darwin-x64', 'darwin-arm64'];
const targets = process.argv[2] ? [process.argv[2]] : ALL_TARGETS;
for (const t of targets) {
  if (!ALL_TARGETS.includes(t)) {
    console.error(`未知平台: ${t}（可选: ${ALL_TARGETS.join(' / ')}）`);
    process.exit(1);
  }
}

// 1. 生成内嵌资源模块（公共逻辑，桌面版构建共用）
require('./embed-assets').ensureEmbedded();

// 2. bun compile 各平台
fs.mkdirSync(DIST, { recursive: true });
let failed = [];
for (const t of targets) {
  const out = path.join(DIST, t === 'windows-x64' ? `agents-chat-${t}.exe` : `agents-chat-${t}`);
  console.log(`构建 ${t} -> ${path.relative(ROOT, out)} ...`);
  // windows: 双击运行不弹命令行窗口（日志自动落到 exe 旁 .data/agents-chat.log）
  // 注：--windows-title/icon 需在 Windows 本机构建，交叉编译只加 hide-console
  const extra = t === 'windows-x64' ? ' --windows-hide-console' : '';
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
try { fs.unlinkSync(path.join(ROOT, 'app', 'lib', 'embedded-assets.js')); } catch { /* ignore */ }

if (failed.length) {
  console.error(`失败平台: ${failed.join(', ')}`);
  process.exit(1);
}

// 4. 生成校验清单（Release 附上，供核对下载完整性；exe 未签名场景尤为重要）
const { createHash } = require('crypto');
const lines = [];
for (const f of fs.readdirSync(DIST).sort()) {
  if (!/^agents-chat-/.test(f)) continue; // 只计算产物文件（跳过 .data 等目录与旧清单）
  const fp = path.join(DIST, f);
  try { if (!fs.statSync(fp).isFile()) continue; } catch { continue; }
  const h = createHash('sha256').update(fs.readFileSync(fp)).digest('hex');
  lines.push(`${h}  ${f}`);
}
fs.writeFileSync(path.join(DIST, 'checksums.txt'), lines.join('\n') + '\n');
console.log('校验清单: dist/checksums.txt');
console.log('全部构建完成');
