// 内核自动安装：npm 包安装（postinstall）与 CLI 启动共用
// 策略：一个内核都没有时自动安装 opencode（默认推荐内核）；任一内核已存在则跳过；
//       单文件 exe 形态无 npm，跳过；AGENTS_CHAT_AUTO_INSTALL=0 可关闭。
// 原则：任何失败只提示，绝不抛错（postinstall 失败会连带 npm install 整体失败）。
const { execSync } = require('child_process');

// 纯决策函数（单测覆盖）：给定 detectKernels() 的 map，判断是否需要自动安装
function shouldAutoInstall(kernelMap, { standalone = false, disabled = false } = {}) {
  if (standalone) return { need: false, reason: 'standalone' };      // exe 无 npm
  if (disabled) return { need: false, reason: 'disabled' };          // 用户显式关闭
  if (!kernelMap || typeof kernelMap !== 'object' || !Object.keys(kernelMap).length) return { need: false, reason: 'badmap' };
  const anyOk = Object.values(kernelMap).some(k => k && k.ok);
  if (anyOk) return { need: false, reason: 'has-kernel' };
  return { need: true, reason: 'none' };
}

// 执行安装并返回结果；log/inject 可注入（postinstall 用 console，单测用收集器）
function ensureDefaultKernel({ log = console.log, standalone = !!process.versions.bun || process.env.AGENTS_CHAT_STANDALONE === '1' } = {}) {
  const { detectKernels } = require('./agent');
  const decision = shouldAutoInstall(detectKernels(), {
    standalone,
    disabled: process.env.AGENTS_CHAT_AUTO_INSTALL === '0'
  });
  if (!decision.need) {
    if (decision.reason === 'standalone') log('ℹ 单文件版内置 npm 不可用：未检测到内核时请手动安装 opencode（npm install -g opencode-ai）');
    return { installed: false, reason: decision.reason };
  }
  log('未检测到任何 AI 执行内核，正在自动安装 opencode（约 1-2 分钟，仅此一次）...');
  try {
    execSync('npm install -g opencode-ai', { stdio: 'inherit', timeout: 300000 });
    // 刷新检测缓存，让随后的启动横幅直接看到新内核
    try { require('./agent').resetDetectCache(); } catch { /* 旧版无此函数则忽略 */ }
    log('✓ opencode 安装完成（PATH 由 npm 自动配置，重开终端生效）');
    return { installed: true };
  } catch (err) {
    log('✗ 自动安装失败（通常是全局目录权限不足），请手动执行其中一条：');
    log('    Windows:        npm install -g opencode-ai');
    log('    Linux/macOS:    sudo npm install -g opencode-ai');
    return { installed: false, reason: 'install-failed', error: err && err.message };
  }
}

module.exports = { shouldAutoInstall, ensureDefaultKernel };
