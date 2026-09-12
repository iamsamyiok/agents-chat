// 执行等待时长（execTimeoutMs）优先级 + saveAgents 持久化测试
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-timeout-test-'));
process.env.AGENTS_CHAT_DATA = DATA;
delete process.env.AGENTS_CHAT_TIMEOUT_MS;
const store = require('../app/lib/store');

test('默认（未配置、无环境变量）不限时', () => {
  assert.strictEqual(store.execTimeoutMs(), 0);
});

test('旧环境变量 AGENTS_CHAT_TIMEOUT_MS 兼容', () => {
  process.env.AGENTS_CHAT_TIMEOUT_MS = '30000';
  assert.strictEqual(store.execTimeoutMs(), 30000);
  delete process.env.AGENTS_CHAT_TIMEOUT_MS;
  assert.strictEqual(store.execTimeoutMs(), 0);
});

test('配置显式设置优先于环境变量；0 = 显式不限时', () => {
  process.env.AGENTS_CHAT_TIMEOUT_MS = '30000';
  const cfg = store.getConfig();
  cfg.execTimeoutSec = 120;
  store.saveConfig(cfg);
  assert.strictEqual(store.execTimeoutMs(), 120000);
  cfg.execTimeoutSec = 0;
  store.saveConfig(cfg);
  assert.strictEqual(store.execTimeoutMs(), 0);
  delete process.env.AGENTS_CHAT_TIMEOUT_MS;
  assert.strictEqual(store.execTimeoutMs(), 0);
});

test('saveAgents 第五参持久化 execTimeoutSec；undefined 保持原值', () => {
  store.saveAgents([], '', 'auto', 'off', 600);
  assert.strictEqual(store.getConfig().execTimeoutSec, 600);
  assert.strictEqual(store.execTimeoutMs(), 600000);
  store.saveAgents([], '', 'auto', 'off');
  assert.strictEqual(store.getConfig().execTimeoutSec, 600);
  store.saveAgents([], '', 'auto', 'off', 0);
  assert.strictEqual(store.getConfig().execTimeoutSec, 0);
});

test('非法配置值回落默认不限时', () => {
  const cfg = store.getConfig();
  cfg.execTimeoutSec = 'abc';
  store.saveConfig(cfg);
  assert.strictEqual(store.execTimeoutMs(), 0);
  cfg.execTimeoutSec = -5;
  store.saveConfig(cfg);
  assert.strictEqual(store.execTimeoutMs(), 0);
});

test('超大值钳制到 7 天', () => {
  const cfg = store.getConfig();
  cfg.execTimeoutSec = 99999999;
  store.saveConfig(cfg);
  assert.strictEqual(store.execTimeoutMs(), 604800 * 1000);
});
