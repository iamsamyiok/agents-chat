// npm 最新版本检查：供启动横幅、/api/health、CLI update/status 共用
// Node 18+ 自带全局 fetch；3 秒超时 + 1 小时结果缓存，失败静默（离线/内网不影响启动）

const PKG = require('../../package.json');
const REGISTRY_URL = `https://registry.npmjs.org/${PKG.name}/latest`;

let cached = { at: 0, latest: null }; // 缓存上次查询结果（1 小时内复用）

// 简化 semver 比较：a > b 返回 true（仅支持 x.y.z 数字段， prerelease 忽略比较）
function semverGt(a, b) {
  const pa = String(a || '').split('-')[0].split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b || '').split('-')[0].split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

// 查询 npm registry 最新版本；force=true 跳过缓存（CLI update 用）
async function checkLatest({ force = false } = {}) {
  const now = Date.now();
  if (!force && cached.latest && now - cached.at < 3600 * 1000) {
    return { latest: cached.latest, updateAvailable: semverGt(cached.latest, PKG.version) };
  }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch(REGISTRY_URL, { signal: ctrl.signal, headers: { 'accept': 'application/json' } });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = await res.json();
    const latest = String(data.version || '');
    if (!latest) return null;
    cached = { at: now, latest };
    return { latest, updateAvailable: semverGt(latest, PKG.version) };
  } catch {
    return null; // 网络不可达/超时：静默，不阻塞调用方
  }
}

const UPDATE_COMMAND = `npm install -g ${PKG.name}@latest`;

module.exports = { semverGt, checkLatest, UPDATE_COMMAND, currentVersion: PKG.version };
