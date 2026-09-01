// 附件模块配置：本地持久化到 .data/attachment-config.json（与 store 同目录）
// 前端配置面板写入；重启不丢。仅使用 Node 内置模块，零依赖。
'use strict';

const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./store');

const CFG_PATH = path.join(DATA_DIR, 'attachment-config.json');

const DEFAULTS = {
  // MinerU Flash（文档解析，免登录轻量接口）
  mineruBase: 'https://mineru.net/api/v1/agent',
  mineruLang: 'ch',
  // 图片理解 LLM（Agnes 等，OpenAI 兼容 chat/completions）
  llmBase: 'https://apihub.agnes-ai.com/v1',
  llmModel: 'agnes-2.0-flash',
  llmApiKey: ''
};

function loadConfig() {
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
  } catch { /* 无配置文件则用默认 */ }
  // 合并默认，避免缺字段
  return Object.assign({}, DEFAULTS, cfg);
}

function saveConfig(patch) {
  const next = Object.assign({}, loadConfig(), patch || {});
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CFG_PATH, JSON.stringify(next, null, 2), 'utf8');
  } catch (e) {
    // 写入失败不应中断主流程
    console.error('[attachment-config] 保存失败:', e.message);
  }
  return next;
}

// 转为 attachment.js 的 opts 参数
function toOpts(cfg) {
  return {
    agnesKey: cfg.llmApiKey,
    agnesBase: cfg.llmBase,
    agnesModel: cfg.llmModel,
    mineruBase: cfg.mineruBase,
    language: cfg.mineruLang
  };
}

module.exports = { loadConfig, saveConfig, toOpts, DEFAULTS, CFG_PATH };
