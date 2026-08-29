#!/usr/bin/env node
/**
 * agents-chat CLI 入口
 *
 * 用法:
 *   agents-chat            # 启动服务（后台运行）
 *   agents-chat start      # 同上
 *   agents-chat stop       # 停止服务
 *   agents-chat status     # 查看服务状态（含版本与更新检查）
 *   agents-chat open       # 仅打开浏览器
 *   agents-chat update     # 检查并一键升级到 npm 最新版
 *   agents-chat version    # 查看当前版本
 */

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PKG = require('../package.json');
const { checkLatest, UPDATE_COMMAND } = require('../app/lib/updatecheck');

const PORT = parseInt(process.env.AGENTS_CHAT_PORT || '3456', 10);
const PID_FILE = path.join(os.homedir(), '.agents-chat.pid');
const LOG_FILE = path.join(os.homedir(), '.agents-chat.log');
const DATA_DIR = process.env.AGENTS_CHAT_DATA || path.join(os.homedir(), '.agents-chat');
const SERVER_PATH = path.join(__dirname, '..', 'app', 'server.js');

// 确保数据目录存在
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function isRunning() {
  try {
    const pid = fs.readFileSync(PID_FILE, 'utf8').trim();
    if (pid) {
      // 检查进程是否还在运行
      try {
        process.kill(parseInt(pid, 10), 0);
        // 同时检查端口是否响应
        try {
          execSync(`curl -s -m 2 http://localhost:${PORT}/api/health`, { stdio: 'pipe' });
          return { running: true, pid: parseInt(pid, 10) };
        } catch {
          // 端口无响应，进程可能已死
          return { running: false, pid: parseInt(pid, 10), dead: true };
        }
      } catch {
        return { running: false, pid: null, dead: true };
      }
    }
  } catch {
    // PID 文件不存在
  }
  return { running: false, pid: null };
}

function startServer() {
  const check = isRunning();
  if (check.running) {
    console.log(`服务已在运行 (PID: ${check.pid})`);
    console.log(`访问 http://localhost:${PORT}`);
    openBrowser();
    return;
  }

  if (check.dead) {
    console.log('清理残留进程...');
    cleanupDeadProcess(check.pid);
  }

  console.log(`启动 Agents Chat 服务 (端口 ${PORT})...`);
  
  const env = {
    ...process.env,
    AGENTS_CHAT_DATA: DATA_DIR
  };

  const options = {
    cwd: path.join(__dirname, '..'),
    env: env,
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore'],
    windowsHide: true
  };

  // Windows 特殊处理
  if (process.platform === 'win32') {
    options.shell = true;
    options.windowsHide = true;
  }

  const child = spawn(process.execPath, [SERVER_PATH, '--port', PORT], options);
  
  child.on('error', (err) => {
    console.error('启动失败:', err.message);
    process.exit(1);
  });

  // 写入 PID 文件
  if (child.pid) {
    fs.writeFileSync(PID_FILE, String(child.pid));
  }

  // 分离进程
  child.unref();

  // 等待服务就绪
  console.log('等待服务就绪...');
  let retries = 30;
  const poll = setInterval(() => {
    retries--;
    try {
      execSync(`curl -s -m 2 http://localhost:${PORT}/api/health`, { stdio: 'pipe' });
      clearInterval(poll);
      console.log('服务已就绪!');
      console.log(`访问 http://localhost:${PORT}`);
      openBrowser();
    } catch {
      if (retries <= 0) {
        clearInterval(poll);
        console.error('服务启动超时，请查看日志:');
        console.log(`  ${LOG_FILE}`);
        process.exit(1);
      }
    }
  }, 500);
}

function stopServer() {
  const check = isRunning();
  if (!check.running) {
    console.log('服务未运行');
    if (check.dead) {
      cleanupDeadProcess(check.pid);
    }
    return;
  }

  console.log(`停止服务 (PID: ${check.pid})...`);
  
  try {
    // Windows 使用 taskkill 确保清理子进程
    if (process.platform === 'win32') {
      execSync(`taskkill /pid ${check.pid} /T /F`, { stdio: 'ignore' });
    } else {
      process.kill(check.pid, 'SIGTERM');
    }
    
    // 等待进程退出
    let retries = 10;
    const wait = setInterval(() => {
      retries--;
      try {
        process.kill(check.pid, 0);
        if (retries <= 0) {
          clearInterval(wait);
          // 强制终止
          try { process.kill(check.pid, 'SIGKILL'); } catch {}
        }
      } catch {
        clearInterval(wait);
        console.log('服务已停止');
      }
    }, 100);
  } catch (err) {
    console.error('停止失败:', err.message);
  }

  // 清理 PID 文件
  try { fs.unlinkSync(PID_FILE); } catch {}
}

function cleanupDeadProcess(pid) {
  try {
    if (pid) {
      if (process.platform === 'win32') {
        execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore' });
      } else {
        try { process.kill(pid, 'SIGKILL'); } catch {}
      }
    }
  } catch {}
  
  // 也通过命令行特征清理
  try {
    if (process.platform === 'win32') {
      execSync('powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -match \'node\' -and $_.CommandLine -like \'*app\\\\server.js*\' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"', { stdio: 'ignore' });
    }
  } catch {}
  
  try { fs.unlinkSync(PID_FILE); } catch {}
}

function openBrowser() {
  const url = `http://localhost:${PORT}`;
  try {
    if (process.platform === 'win32') {
      execSync(`start "" "${url}"`, { shell: true });
    } else if (process.platform === 'darwin') {
      execSync(`open "${url}"`);
    } else {
      execSync(`xdg-open "${url}"`);
    }
  } catch {
    console.log(`请手动访问: ${url}`);
  }
}

function showStatus() {
  const check = isRunning();
  if (check.running) {
    console.log(`状态: 运行中 (PID: ${check.pid})`);
    console.log(`端口: ${PORT}`);
    console.log(`数据目录: ${DATA_DIR}`);
    console.log(`日志文件: ${LOG_FILE}`);
  } else {
    console.log('状态: 未运行');
    if (check.dead) {
      console.log('发现残留进程，已清理');
    }
  }
  console.log(`当前版本: v${PKG.version}`);
  checkLatest().then((upd) => {
    if (!upd) { console.log('更新检查: 网络不可用，跳过'); return; }
    if (upd.updateAvailable) {
      console.log(`可用更新: v${upd.latest}（运行 agents-chat update 一键升级）`);
    } else {
      console.log(`版本状态: 已是最新（npm 最新 v${upd.latest}）`);
    }
  });
}

// 一键升级：检测新版 → 停服务（避免文件占用/旧进程残留）→ npm 全局安装最新版
async function updateSelf() {
  console.log(`当前版本: v${PKG.version}`);
  console.log('正在检查 npm 最新版本...');
  const upd = await checkLatest({ force: true });
  if (!upd) {
    console.error('无法访问 npm registry（网络超时或离线），请稍后重试或手动执行:');
    console.log(`  ${UPDATE_COMMAND}`);
    process.exit(1);
  }
  if (!upd.updateAvailable) {
    console.log(`已是最新版本 v${upd.latest}，无需升级`);
    return;
  }
  console.log(`发现新版本 v${upd.latest}，开始升级...`);
  const check = isRunning();
  if (check.running) {
    console.log('先停止运行中的服务（升级完成后需手动重新启动）...');
    stopServer();
  }
  try {
    execSync(UPDATE_COMMAND, { stdio: 'inherit' });
    console.log('');
    console.log(`升级完成: v${PKG.version} -> v${upd.latest}`);
    console.log('运行 agents-chat 重新启动服务');
  } catch (err) {
    console.error('升级失败:', err.message);
    console.log('可手动执行:');
    console.log(`  ${UPDATE_COMMAND}`);
    process.exit(1);
  }
}

function showVersion() {
  console.log(`agents-chat v${PKG.version}`);
}

// 主逻辑
const command = process.argv[2] || 'start';

switch (command) {
  case 'start':
  case '':
    startServer();
    break;
  case 'stop':
    stopServer();
    break;
  case 'status':
    showStatus();
    break;
  case 'open':
    openBrowser();
    break;
  case 'update':
  case 'upgrade':
    updateSelf();
    break;
  case 'version':
  case '-v':
  case '--version':
    showVersion();
    break;
  case 'help':
  case '--help':
  case '-h':
    console.log(`
Agents Chat CLI v${PKG.version}

用法:
  agents-chat            启动服务（后台运行，自动打开浏览器）
  agents-chat start      同上
  agents-chat stop       停止服务
  agents-chat status     查看服务状态（含版本与更新检查）
  agents-chat open       仅打开浏览器
  agents-chat update     检查并一键升级到 npm 最新版
  agents-chat version    查看当前版本

环境变量:
  AGENTS_CHAT_PORT     端口号 (默认: 3456)
  AGENTS_CHAT_DATA     数据目录 (默认: ~/.agents-chat)

配置:
  编辑 ~/.agents-chat/.env 文件进行配置
`);
    break;
  default:
    console.error(`未知命令: ${command}`);
    console.log('运行 agents-chat help 查看帮助');
    process.exit(1);
}
