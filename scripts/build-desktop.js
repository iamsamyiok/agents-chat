#!/usr/bin/env node
// 桌面版（Electron）构建：Windows 安装版 + 便携版
// 用法：npm run desktop:build            # 当前平台默认目标（win 下为 nsis + portable）
//       npm run desktop:build -- --win   # 显式指定平台（electron-builder 透传）
// 前置：npm install 已装 devDependencies（electron / electron-builder）
// 产物：dist-desktop/（NSIS 安装器 + 便携版 exe + blockmap）
const { execSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// 1. 图标：确保存在（源码仓库不含生成物，CI/本地一键可复现）
try { execSync('node scripts/gen-icon.js', { cwd: ROOT, stdio: 'inherit' }); } catch (e) {
  console.error('图标生成失败:', e.message);
  process.exit(1);
}

// 2. 页面资源内嵌（asar 内不再携带 app/public，运行时读 embedded-assets）
require('./embed-assets').ensureEmbedded();

// 3. electron-builder（参数透传：--win / --dir 调试等；显式 --config 避免 package.json build 字段优先导致遗漏）
const args = process.argv.slice(2).join(' ');
try {
  execSync(`npx electron-builder --config electron-builder.yml ${args}`.trim(), { cwd: ROOT, stdio: 'inherit' });
} finally {
  // 构建后清理中间产物，避免误提交与干扰 npm test（源码运行不需要）
  try { require('fs').unlinkSync(path.join(ROOT, 'app', 'lib', 'embedded-assets.js')); } catch { /* ignore */ }
}
