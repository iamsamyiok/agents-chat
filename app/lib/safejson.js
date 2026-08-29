// 数据文件损坏保护 + 原子写公共层（零依赖）
// 策略：解析失败（文件存在但 JSON 损坏）→ 备份现场为 .corrupt-<ts> 并登记；
// 之后该文件的写请求一律抛错，防止「读到空数据 → 全量覆盖写」冲掉用户数据。
// 正常写入走 tmp + rename 原子替换，进程中断不会留下半截文件。
const fs = require('fs');
const path = require('path');

const corrupted = new Set(); // 已损坏的文件绝对路径

function isCorrupted(file) { return corrupted.has(file); }
function corruptedFiles() { return [...corrupted]; }

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err && err.code === 'ENOENT') return fallback; // 文件不存在：正常初始状态
    try { fs.copyFileSync(file, `${file}.corrupt-${Date.now()}`); } catch { /* 备份失败也要继续登记 */ }
    corrupted.add(file);
    console.error(`[safejson] 数据文件损坏，已备份并进入只读保护：${file}`);
    return fallback;
  }
}

function writeJson(file, data) {
  if (corrupted.has(file)) {
    throw new Error(`数据文件 ${path.basename(file)} 已损坏（原文件已备份为 .corrupt-*），为防数据丢失已停止写入，请人工检查 ${path.dirname(file)} 后处理备份文件`);
  }
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

module.exports = { readJson, writeJson, isCorrupted, corruptedFiles };
