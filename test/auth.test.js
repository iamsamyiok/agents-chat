const test = require('node:test');
const assert = require('node:assert');
const auth = require('../app/lib/auth');

// ---------- isAuthEnabled / expectedToken ----------
test('未配置密码时不启用鉴权', () => {
  assert.equal(auth.isAuthEnabled({}), false);
  assert.equal(auth.isAuthEnabled({ AGENTS_CHAT_PASSWORD: '' }), false);
  assert.equal(auth.isAuthEnabled({ AGENTS_CHAT_PASSWORD: '  ' }), false);
});
test('配置密码后启用且 token 稳定可复现', () => {
  const env = { AGENTS_CHAT_PASSWORD: 'abc123' };
  assert.equal(auth.isAuthEnabled(env), true);
  const t1 = auth.expectedToken(env);
  assert.equal(t1, auth.expectedToken({ AGENTS_CHAT_PASSWORD: 'abc123' }));
  assert.equal(t1.length, 64); // sha256 hex
  assert.notEqual(t1, auth.expectedToken({ AGENTS_CHAT_PASSWORD: 'other' }));
});

// ---------- parseCookies / hasAccess ----------
test('cookie 解析与访问判断', () => {
  const env = { AGENTS_CHAT_PASSWORD: 'abc123' };
  const token = auth.expectedToken(env);
  assert.equal(auth.hasAccess({ headers: { cookie: `ac_auth=${token}` } }, env), true);
  assert.equal(auth.hasAccess({ headers: { cookie: 'ac_auth=bad' } }, env), false);
  assert.equal(auth.hasAccess({ headers: {} }, env), false);
});
test('正确密码的 token 与错误密码不同（timingSafeEqual 长度校验前拦截）', () => {
  const env = { AGENTS_CHAT_PASSWORD: 'abc123' };
  const wrong = auth.expectedToken({ AGENTS_CHAT_PASSWORD: 'x' });
  assert.equal(auth.hasAccess({ headers: { cookie: `ac_auth=${wrong}` } }, env), false);
  // 长度不足的伪造 token 不应抛错
  assert.equal(auth.hasAccess({ headers: { cookie: 'ac_auth=short' } }, env), false);
});
test('未启用鉴权时一切放行', () => {
  assert.equal(auth.hasAccess({ headers: {} }, {}), true);
});

// ---------- isPublicPath ----------
test('放行清单', () => {
  for (const p of ['/login', '/login.html', '/api/auth/login', '/api/auth/check']) {
    assert.equal(auth.isPublicPath(p), true, p);
  }
  for (const p of ['/', '/index.html', '/api/health', '/api/tasks', '/cards']) {
    assert.equal(auth.isPublicPath(p), false, p);
  }
});

// ---------- resolveListenHost ----------
test('监听地址决策：桌面恒回环', () => {
  assert.equal(auth.resolveListenHost({ isDesktop: true, hasPassword: false, lan: undefined }), '127.0.0.1');
  assert.equal(auth.resolveListenHost({ isDesktop: true, hasPassword: true, lan: '1' }), '127.0.0.1');
});
test('监听地址决策：无密码默认回环，防局域网裸奔', () => {
  assert.equal(auth.resolveListenHost({ isDesktop: false, hasPassword: false, lan: undefined }), '127.0.0.1');
  assert.equal(auth.resolveListenHost({ isDesktop: false, hasPassword: false, lan: '0' }), '127.0.0.1');
});
test('监听地址决策：配密码或显式 LAN=1 才绑全接口', () => {
  assert.equal(auth.resolveListenHost({ isDesktop: false, hasPassword: true, lan: undefined }), undefined);
  assert.equal(auth.resolveListenHost({ isDesktop: false, hasPassword: false, lan: '1' }), undefined);
});
