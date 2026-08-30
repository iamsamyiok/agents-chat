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

  // 兜底自动安装：postinstall 被跳过（yarn/pnpm/离线装包）时，首次 start 补装 opencode
  try {
    const { ensureDefaultKernel } = require('../app/lib/kernel-setup');
    ensureDefaultKernel();
  } catch { /* 任何失败不阻塞启动 */ }

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

// ---------- 开机自启（定时任务抗重启）----------
// Windows: HKCU Run 键 + VBS 静默启动（无黑窗闪烁）；exe 形态直接注册 exe 路径
// macOS:   ~/Library/LaunchAgents/com.agents-chat.plist（登录即拉起）
// Linux:   crontab @reboot 行
const AUTOSTART_KEY = 'AgentsChat';
function autostartTarget() {
  // 单文件 exe：直接跑 exe（已无窗口）；npm 形态：VBS 静默执行 agents-chat start
  if (process.env.AGENTS_CHAT_STANDALONE === '1' || process.versions.bun) {
    return { kind: 'exe', cmd: `"${process.execPath}"` };
  }
  return { kind: 'npm', cmd: null };
}
function autostartOn() {
  const t = autostartTarget();
  const home = os.homedir();
  if (process.platform === 'win32') {
    const run = t.kind === 'exe'
      ? t.cmd
      : `wscript.exe "${path.join(home, '.agents-chat', 'autostart.vbs')}"`;
    if (t.kind === 'npm') {
      fs.mkdirSync(path.join(home, '.agents-chat'), { recursive: true });
      // 0 = 隐藏窗口；npm bin 已在用户 PATH（npm 安装时配置）， explorer 启动的进程可继承
      fs.writeFileSync(path.join(home, '.agents-chat', 'autostart.vbs'),
        `CreateObject("Wscript.Shell").Run "cmd /c agents-chat start", 0, False\r\n`);
    }
    execSync(`reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v ${AUTOSTART_KEY} /t REG_SZ /d "${run}" /f`, { stdio: 'ignore' });
    console.log('✓ 开机自启已开启（当前用户级，无需管理员）');
  } else if (process.platform === 'darwin') {
    const plist = path.join(home, 'Library', 'LaunchAgents', 'com.agents-chat.plist');
    fs.mkdirSync(path.dirname(plist), { recursive: true });
    const exe = t.kind === 'exe' ? process.execPath : process.execPath;
    const arg = t.kind === 'exe' ? [] : [path.join(__dirname, '..', 'app', 'server.js'), '--port', String(PORT)];
    const envData = `  <key>EnvironmentVariables</key>\n  <dict><key>AGENTS_CHAT_DATA</key><string>${DATA_DIR}</string></dict>`;
    fs.writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.agents-chat</string>
  <key>ProgramArguments</key>
  <array><string>${exe}</string>${arg.map(a => `<string>${a}</string>`).join('')}</array>
  ${envData}
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${path.join(home, '.agents-chat', 'autostart.log')}</string>
  <key>StandardErrorPath</key><string>${path.join(home, '.agents-chat', 'autostart.log')}</string>
</dict></plist>`);
    try { execSync(`launchctl unload "${plist}" 2>/dev/null; launchctl load "${plist}"`); } catch { /* 下次登录生效 */ }
    console.log('✓ 开机自启已开启（LaunchAgent，登录即启动）');
  } else {
    // Linux: crontab @reboot
    let cron = '';
    try { cron = execSync('crontab -l', { stdio: ['pipe', 'pipe', 'ignore'] }).toString(); } catch { /* 无 crontab */ }
    const line = t.kind === 'exe'
      ? `@reboot ${process.execPath}`
      : `@reboot ${process.execPath} ${path.join(__dirname, '..', 'app', 'server.js')} --port ${PORT}`;
    if (cron.includes(AUTOSTART_KEY)) {
      cron = cron.split('\n').filter(l => l && !l.includes(AUTOSTART_KEY)).join('\n');
    }
    cron = (cron ? cron.trimEnd() + '\n' : '') + `${line} # ${AUTOSTART_KEY} env AGENTS_CHAT_DATA=${DATA_DIR}`;
    // @reboot 行无法带 env 前缀于部分 cron 实现，数据目录路径直接写进 server 启动参数不可行时靠默认 ~/.agents-chat
    execSync('crontab -', { input: cron.replace(/ # [^\n]*/, '') + '\n' });
    console.log('✓ 开机自启已开启（crontab @reboot，数据目录 ~/.agents-chat）');
  }
  console.log('关闭方式: agents-chat autostart off');
}
function autostartOff() {
  try {
    if (process.platform === 'win32') {
      execSync(`reg delete "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v ${AUTOSTART_KEY} /f`, { stdio: 'ignore' });
    } else if (process.platform === 'darwin') {
      const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.agents-chat.plist');
      try { execSync(`launchctl unload "${plist}"`); } catch { /* ignore */ }
      fs.unlinkSync(plist);
    } else {
      let cron = '';
      try { cron = execSync('crontab -l', { stdio: ['pipe', 'pipe', 'ignore'] }).toString(); } catch { }
      const kept = cron.split('\n').filter(l => l && !(l.includes('@reboot') && (l.includes('app/server.js') || l.includes('agents-chat'))));
      execSync('crontab -', { input: kept.join('\n') + (kept.length ? '\n' : '') });
    }
    console.log('✓ 开机自启已关闭');
  } catch (err) {
    console.error('关闭失败:', err.message);
  }
}
function autostartStatus() {
  try {
    if (process.platform === 'win32') {
      execSync(`reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v ${AUTOSTART_KEY}`, { stdio: 'pipe' });
    } else if (process.platform === 'darwin') {
      fs.accessSync(path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.agents-chat.plist'));
    } else {
      const cron = execSync('crontab -l', { stdio: ['pipe', 'pipe', 'ignore'] }).toString();
      if (!/@reboot.*agents-chat|@reboot.*app\/server\.js/.test(cron)) throw new Error('not set');
    }
    console.log('开机自启: 已开启');
  } catch {
    console.log('开机自启: 未开启（agents-chat autostart on 开启）');
  }
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
  case 'autostart':
    if (process.argv[3] === 'off') autostartOff();
    else if (process.argv[3] === 'status' || !process.argv[3]) autostartStatus();
    else if (process.argv[3] === 'on') autostartOn();
    else { console.error('用法: agents-chat autostart on|off|status'); process.exit(1); }
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
  agents-chat autostart on|off|status
                         开机自启管理（定时任务抗机器重启，Windows 用户级注册表/
                         macOS LaunchAgent/Linux crontab）

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
