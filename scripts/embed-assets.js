#!/usr/bin/env node
// 资源内嵌模块生成（app/lib/embedded-assets.js）：HTML/JSON/SVG → JSON 字符串常量模块
// 单文件 exe（scripts/build-exe.js）与桌面版（scripts/build-desktop.js）共用；
// 运行时 serveStatic 优先读内嵌资源，磁盘 public 目录仅开发模式使用。
// 该产物在 .gitignore 中，构建时生成、勿提交。
const fs = require('fs');
const path = require('path');

function ensureEmbedded({ log = console.log } = {}) {
  const ROOT = path.join(__dirname, '..');
  const PUB = path.join(ROOT, 'app', 'public');
  const EMBED = path.join(ROOT, 'app', 'lib', 'embedded-assets.js');
  const PKG = require(path.join(ROOT, 'package.json'));
  const assets = {};
  for (const f of fs.readdirSync(PUB)) {
    if (/\.(html|json|svg)$/.test(f)) assets[f] = fs.readFileSync(path.join(PUB, f), 'utf8');
  }
  fs.writeFileSync(EMBED, [
    '// 本文件由 scripts/embed-assets.js 构建时自动生成，勿手工编辑、勿提交仓库',
    `// 内嵌页面资源（构建于 ${new Date().toISOString()}，v${PKG.version}）`,
    'module.exports = ' + JSON.stringify(assets, null, 2) + ';',
    ''
  ].join('\n'));
  log(`已生成内嵌资源: ${Object.keys(assets).join('、')}`);
  return EMBED;
}

module.exports = { ensureEmbedded };

if (require.main === module) ensureEmbedded();
