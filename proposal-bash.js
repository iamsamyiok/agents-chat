// @name bash
// @desc 执行 shell 命令并返回输出（默认在工作目录执行，限时 30 秒）
// @essential true
const { exec } = require('child_process');

module.exports = {
  params: {
    type: 'object',
    properties: {
      command: { 
        type: 'string', 
        description: '要执行的 shell 命令（支持 && 串联；避免路径穿越与危险操作）'
      },
      timeout: { 
        type: 'number', 
        description: '可选：覆盖默认 30 秒超时（毫秒）'
      }
    },
    required: ['command']
  },
  run: async (args, ctx) => {
    const cmd = String(args.command || '');
    // 安全预检：拒绝明确危险的操作
    const dangerPatterns = [
      /rm\s+-[a-zA-Z]*[rR][fF]\s+\//,  // rm -rf /
      /\bsudo\b/,                        // sudo 命令
      /\b(shutdown|reboot|poweroff)\b/  // 系统电源操作
    ];
    for (const p of dangerPatterns) {
      if (p.test(cmd)) {
        throw new Error(`命令被拒绝：包含危险操作 "${p.source}"`);
      }
    }
    
    let runCmd = cmd;
    // Windows 控制台默认 GBK 编码，中文输出会乱码：先切 UTF-8 代码页再执行
    if (process.platform === 'win32') runCmd = 'chcp 65001 >nul & ' + runCmd;
    
    const timeout = Number(args.timeout) || 30000;
    
    return await new Promise((resolve) => {
      exec(runCmd, {
        cwd: ctx.cwd,
        timeout: timeout,
        maxBuffer: 512 * 1024,
        killSignal: 'SIGKILL',
        windowsHide: true,
        encoding: 'utf8'
      }, (err, stdout, stderr) => {
        const out = String(stdout || '').trim();
        const errOut = String(stderr || '').trim();
        const tail = (out + (out && errOut ? '\n' : '') + errOut).slice(-6000);
        if (err && err.killed) resolve(`命令超时被终止（${timeout/1000} 秒）。部分输出：\n${tail}`);
        else if (err) resolve(`命令退出码 ${err.code ?? '?'}。输出：\n${tail || '（无输出）'}`);
        // 重定向无输出命令：返回确认提示
        else if (!tail && /(>>|>|tee)\s+\S+/.test(cmd)) {
          resolve(`命令执行成功（退出码 0），无终端输出（内容可能已重定向到文件）。如需确认追加/写入是否生效：wc -c <文件> 或 ls -l <文件>`);
        } else resolve(`命令执行成功（退出码 0）。输出：\n${tail || '（无输出）'}`);
      });
    });
  }
};
