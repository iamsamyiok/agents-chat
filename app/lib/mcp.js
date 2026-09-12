// MCP 工具服务器配置管理：读写内核配置（opencode.json）的 mcp 字段
// - 内核每任务 spawn 新进程读取配置，保存后下次执行自动生效（无需重启）
// - secret 字段（environment/headers 的值）读取时打码；保存时空值沿用旧值防误清空
const { ocConfigPath, loadOcConfig, saveOcConfig } = require('./oc');

const NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const URL_RE = /^https?:\/\/[^\s]+$/;
const MAX_SERVERS = 20;
const SECRET_VALUE_MAX = 4096;
const KEY_RE = /^[A-Za-z0-9_.-]{1,128}$/;

// 命令字符串 → 参数数组：空格切分，支持双引号包裹含空格片段（纯函数）
function parseCommandStr(cmd) {
  const s = String(cmd || '').trim();
  if (!s) return [];
  const out = [];
  let cur = '';
  let inQuote = false;
  for (const ch of s) {
    if (ch === '"') { inQuote = !inQuote; continue; }
    if (ch === ' ' && !inQuote) {
      if (cur !== '') { out.push(cur); cur = ''; }
      continue;
    }
    cur += ch;
  }
  if (cur !== '') out.push(cur);
  return out.filter(x => x.length > 0);
}

// k=v 多行文本（前端 textarea）→ 对象；非法键丢弃，值超长截断
function parseKvText(text) {
  const out = {};
  for (const line of String(text || '').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim();
    if (!KEY_RE.test(k)) continue;
    out[k] = v.slice(0, SECRET_VALUE_MAX);
  }
  return out;
}

// 单条服务器校验与规范化；失败返回 {ok:false, error}
function validateMcpServer(input, existingNames) {
  const name = String(input && input.name || '').trim();
  if (!NAME_RE.test(name)) return { ok: false, error: `名称需为 1~64 位字母/数字/_.-（当前：「${name.slice(0, 24)}」）` };
  if (existingNames && existingNames.has(name)) return { ok: false, error: `名称重复：${name}` };
  const type = input && input.type === 'remote' ? 'remote' : 'local';
  if (type === 'local') {
    const command = parseCommandStr(input.command);
    if (!command.length) return { ok: false, error: `「${name}」启动命令为空` };
    if (command.some(c => c.length > 2048)) return { ok: false, error: `「${name}」命令片段过长` };
    const env = sanitizeKv(input.environment);
    if (env === null) return { ok: false, error: `「${name}」环境变量格式非法` };
    return { ok: true, normalized: { type, command, environment: env, enabled: input.enabled !== false } };
  }
  const url = String(input.url || '').trim();
  if (!URL_RE.test(url)) return { ok: false, error: `「${name}」URL 需以 http(s):// 开头且不含空白` };
  const headers = sanitizeKv(input.headers);
  if (headers === null) return { ok: false, error: `「${name}」headers 格式非法` };
  return { ok: true, normalized: { type, url, headers, enabled: input.enabled !== false } };
}

// secret 对象净化：键合法 + 值为字符串；非法返回 null（整条拒绝），空对象合法
function sanitizeKv(obj) {
  if (obj === undefined || obj === null) return {};
  if (typeof obj !== 'object' || Array.isArray(obj)) return null;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!KEY_RE.test(String(k))) return null;
    if (typeof v !== 'string') return null;
    out[k] = v.slice(0, SECRET_VALUE_MAX);
  }
  return out;
}

// 打码：值 → {has, tail4}；不回传明文
function maskKv(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    out[k] = { has: String(v).length > 0, tail4: String(v).slice(-4) };
  }
  return out;
}

// 列表（打码视图）：供 GET /api/mcp；配置文件损坏时返回 {error}
function listMcpServers() {
  let cfg;
  try {
    cfg = loadOcConfig();
  } catch (e) {
    return { servers: [], error: `配置文件损坏，请人工检查 ${ocConfigPath()}` };
  }
  const mcp = cfg.mcp && typeof cfg.mcp === 'object' && !Array.isArray(cfg.mcp) ? cfg.mcp : {};
  const servers = [];
  for (const [name, raw] of Object.entries(mcp)) {
    if (!raw || typeof raw !== 'object') continue;
    const type = raw.type === 'remote' ? 'remote' : 'local';
    const base = {
      name,
      type,
      enabled: raw.enabled !== false,
      commandStr: Array.isArray(raw.command) ? raw.command.map(c => (String(c).includes(' ') ? `"${c}"` : String(c))).join(' ') : '',
      url: type === 'remote' ? String(raw.url || '') : '',
      environment: maskKv(raw.environment),
      headers: maskKv(raw.headers)
    };
    servers.push(base);
  }
  return { servers };
}

// 保存（全量替换 mcp 字段）：incoming 前端整表提交，secret 值为 '' 表示沿用旧值
// 配置文件损坏时抛错（路由转 409），原文件不被触碰
function saveMcpServers(incoming) {
  if (!Array.isArray(incoming)) throw new Error('servers 需为数组');
  if (incoming.length > MAX_SERVERS) throw new Error(`最多配置 ${MAX_SERVERS} 个服务器`);
  const cfg = loadOcConfig(); // 损坏直接抛错（拒绝覆盖）
  const prev = cfg.mcp && typeof cfg.mcp === 'object' && !Array.isArray(cfg.mcp) ? cfg.mcp : {};
  const names = new Set();
  const next = {};
  for (const item of incoming) {
    const v = validateMcpServer(item, names);
    if (!v.ok) throw new Error(v.error);
    const name = String(item.name).trim();
    names.add(name);
    const norm = v.normalized;
    // secret 空值沿用旧值（打码回显导致前端无法回传明文）
    const oldRaw = prev[name] || {};
    const oldEnv = oldRaw.environment && typeof oldRaw.environment === 'object' ? oldRaw.environment : {};
    const oldHeaders = oldRaw.headers && typeof oldRaw.headers === 'object' ? oldRaw.headers : {};
    if (norm.type === 'local') {
      for (const [k, val] of Object.entries(norm.environment)) {
        if (val === '') norm.environment[k] = String(oldEnv[k] !== undefined ? oldEnv[k] : '');
      }
      if (!Object.keys(norm.environment).length) delete norm.environment;
      next[name] = norm;
    } else {
      for (const [k, val] of Object.entries(norm.headers)) {
        if (val === '') norm.headers[k] = String(oldHeaders[k] !== undefined ? oldHeaders[k] : '');
      }
      if (!Object.keys(norm.headers).length) delete norm.headers;
      next[name] = norm;
    }
  }
  if (Object.keys(next).length) cfg.mcp = next; else delete cfg.mcp;
  saveOcConfig(cfg);
  return { ok: true, count: Object.keys(next).length };
}

module.exports = { parseCommandStr, parseKvText, validateMcpServer, listMcpServers, saveMcpServers, maskKv, NAME_RE, MAX_SERVERS };
