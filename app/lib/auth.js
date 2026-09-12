// 可选访问鉴权：AGENTS_CHAT_PASSWORD 配置后全站生效（局域网/远程部署防裸奔）
// 设计：无状态 token = sha256(PASSWORD)，cookie 携带；密码改则所有旧会话立即失效
// 放行清单：/login 登录页、/api/auth/*；其余页面 302 到 /login，API 返回 401
const crypto = require('crypto');

function isAuthEnabled(env) {
  const pw = String((env && env.AGENTS_CHAT_PASSWORD) || '').trim();
  return pw.length > 0;
}

function expectedToken(env) {
  const pw = String((env && env.AGENTS_CHAT_PASSWORD) || '').trim();
  if (!pw) return '';
  return crypto.createHash('sha256').update(`agents-chat:${pw}`).digest('hex');
}

// 解析请求 Cookie 头 → 对象（取自 Node 官方 parse 简化版，零依赖）
function parseCookies(header) {
  const out = {};
  for (const pair of String(header || '').split(';')) {
    const idx = pair.indexOf('=');
    if (idx > 0) out[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  }
  return out;
}

function hasAccess(req, env) {
  if (!isAuthEnabled(env)) return true; // 未配置密码 = 不启用鉴权
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies.ac_auth || '';
  const want = expectedToken(env);
  if (!token || !want || token.length !== want.length) return false;
  return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(want));
}

// 是否放行：登录页/登录接口/健康检查(仅返回版本,供登录页展示)不含敏感内核信息
const PUBLIC_PATHS = ['/login', '/login.html', '/api/auth/login', '/api/auth/check'];
function isPublicPath(p) {
  return PUBLIC_PATHS.includes(String(p || ''));
}

// 监听地址决策（纯函数，单测覆盖）：
// 桌面形态恒回环；配置密码或显式 AGENTS_CHAT_LAN=1 才绑全接口，其余默认回环（防局域网裸奔）
function resolveListenHost({ isDesktop, hasPassword, lan }) {
  if (isDesktop) return '127.0.0.1';
  if (hasPassword || lan === '1') return undefined; // undefined = 全接口
  return '127.0.0.1';
}

module.exports = { isAuthEnabled, expectedToken, parseCookies, hasAccess, isPublicPath, resolveListenHost };
