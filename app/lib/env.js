// 零依赖 .env 加载器：解析 KEY=VALUE，注入 process.env（不覆盖已有值）
const fs = require('fs');
const path = require('path');

const PLACEHOLDER_PATTERNS = [/sk-在这里填入你的密钥/, /^your-api-key/i, /^changeme$/i, /^$/];

function parseEnv(text) {
  const out = {};
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    // 剥离成对引号
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    // 行内注释（仅对未加引号的值）
    out[key] = val;
  }
  return out;
}

function loadEnv(envPath) {
  let raw = '';
  try { raw = fs.readFileSync(envPath, 'utf8'); } catch { return {}; }
  const parsed = parseEnv(raw);
  for (const [k, v] of Object.entries(parsed)) {
    if (process.env[k] === undefined && v !== '') process.env[k] = v;
  }
  return parsed;
}

// API 配置是否有效（旧版 pi 内核遗留：OpenCode 内核下认证由 opencode 自身管理，
// 此函数仅供兼容，内核判定不再依赖它）
function isApiConfigured(env) {
  const e = env || {};
  const base = e.AGENTS_CHAT_BASE_URL || process.env.AGENTS_CHAT_BASE_URL || '';
  const model = e.AGENTS_CHAT_MODEL || process.env.AGENTS_CHAT_MODEL || '';
  const key = e.AGENTS_CHAT_API_KEY || process.env.AGENTS_CHAT_API_KEY || '';
  if (!base || !model || !key) return false;
  return !PLACEHOLDER_PATTERNS.some(re => re.test(key));
}

module.exports = { loadEnv, parseEnv, isApiConfigured };
