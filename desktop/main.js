// Agents Chat 桌面版主进程（Electron）
// 职责：单实例锁 → 就绪后内嵌启动 HTTP 服务（随机端口回环）→ 窗口加载页面 → 退出树杀清理
// 开发运行：npm run desktop:dev（直接 require 源码 app/server.js）
// 打包形态：electron-builder asar 内 desktop/ 与 app/ 同级，require 路径一致
const { app, BrowserWindow } = require('electron');
const path = require('path');

// 单实例锁：双击二次时聚焦已有窗口，避免随机端口双服务与数据目录并发写
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const wins = BrowserWindow.getAllWindows();
    const win = wins[0];
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
  main().catch(err => {
    console.error('[desktop] 启动失败:', err && (err.stack || err));
    app.exit(1);
  });
}

async function main() {
  // 环境注入必须在 require server.js 之前（server.js 启动时即读取这些环境变量）
  // AGENTS_CHAT_DESKTOP：门控回环绑定/AUTOSTOP 等桌面特有行为
  // AGENTS_CHAT_DATA： userData/data 与 CLI 的 ~/.agents-chat 天然隔离，必须在 server 初始化前设置
  process.env.AGENTS_CHAT_DESKTOP = '1';
  process.env.PORT = '0';
  process.env.AGENTS_CHAT_DATA = path.join(app.getPath('userData'), 'data');

  await app.whenReady();

  // 内嵌启动服务（同进程 require：零跨进程管理，退出清理走同进程钩子）
  const serverExport = require('../app/server.js');

  // 等待 listen 完成（PORT=0 异步分配）
  const port = await waitForPort(serverExport.getPort, 15000);
  console.log(`[desktop] 服务就绪: http://127.0.0.1:${port}`);

  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    title: 'Agents Chat',
    backgroundColor: '#0f1519',
    autoHideMenuBar: true, // 顶部菜单默认隐藏（Alt 唤出，保留 F12/Ctrl+R 调试能力）
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false, // 页面全部能力走 HTTP/SSE，与浏览器形态一致
    },
  });
  win.loadURL(`http://127.0.0.1:${port}/`);
  // 渲染进程异常崩溃（显卡/内存）自动重载；连续 3 次崩溃则退出并记录错误，防止死循环
  let crashCount = 0;
  const MAX_CRASH_RELOAD = 3;
  win.webContents.on('render-process-gone', (_e, details) => {
    crashCount++;
    console.error(`[desktop] 渲染进程异常 (${crashCount}/${MAX_CRASH_RELOAD}):`, details && details.reason);
    if (crashCount >= MAX_CRASH_RELOAD || win.isDestroyed()) {
      console.error('[desktop] 渲染进程连续崩溃，应用退出');
      app.exit(1);
    } else {
      win.loadURL(`http://127.0.0.1:${port}/`);
    }
  });

  // 退出清理：同步树杀全部 AI 子进程并复位执行中任务（server 进程 exit 钩子兜底重复调用）
  // macOS Dock 关闭 / Windows Alt+F4 / kill 主进程 均触发 SIGTERM
  app.on('before-quit', () => {
    try { serverExport.cleanupOnce(); } catch (err) { console.error('[desktop] 退出清理失败:', err && err.message); }
  });
  process.on('SIGTERM', () => {
    try { serverExport.cleanupOnce(); } catch { /* ignore */ }
    app.exit(0);
  });
  app.on('window-all-closed', () => app.quit());
}

function waitForPort(getPort, timeoutMs) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const p = getPort();
      if (p) { clearInterval(timer); resolve(p); }
      else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`服务 ${timeoutMs}ms 内未完成监听，请查看数据目录 server.log`));
      }
    }, 100);
  });
}
