// safejson 损坏保护与原子写测试
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

process.env.AGENTS_CHAT_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'safejson-test-'));
const safejson = require('../app/lib/safejson');

const dir = process.env.AGENTS_CHAT_DATA;
const file = path.join(dir, 'demo.json');

test('正常读写与原子替换', () => {
  safejson.writeJson(file, { a: 1 });
  assert.deepStrictEqual(safejson.readJson(file, null), { a: 1 });
  assert.strictEqual(fs.existsSync(file + '.tmp'), false); // 无残留临时文件
});

test('文件不存在返回 fallback', () => {
  assert.deepStrictEqual(safejson.readJson(path.join(dir, 'nope.json'), { d: [] }), { d: [] });
});

test('损坏文件：返回 fallback、备份现场、登记、拒绝后续写入', () => {
  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(bad, '{oops', 'utf8');
  const fb = { saved: true };
  const out = safejson.readJson(bad, fb);
  assert.deepStrictEqual(out, fb);
  assert.strictEqual(safejson.isCorrupted(bad), true);
  const backups = fs.readdirSync(dir).filter(n => n.startsWith('bad.json.corrupt-'));
  assert.strictEqual(backups.length, 1);
  assert.throws(() => safejson.writeJson(bad, { x: 1 }), /已损坏/);
  // 原文件保留（未被覆盖）
  assert.strictEqual(fs.readFileSync(bad, 'utf8'), '{oops');
});

test('corruptedFiles 汇总登记清单', () => {
  const list = safejson.corruptedFiles();
  assert.ok(Array.isArray(list) && list.some(f => f.endsWith('bad.json')));
});
