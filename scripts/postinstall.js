#!/usr/bin/env node
// npm 安装钩子：全无 AI 内核时自动安装 opencode，小白开箱即用
// 铁律：任何失败只提示不抛错——postinstall 非零退出会连带 npm install 整体报错
try {
  const { ensureDefaultKernel } = require('../app/lib/kernel-setup');
  const r = ensureDefaultKernel();
  if (r.reason === 'has-kernel') console.log('✓ 已检测到 AI 执行内核，跳过自动安装');
} catch (err) {
  console.warn('内核自动安装检查跳过:', err && err.message);
}
