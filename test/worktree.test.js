// Git worktree 任务隔离：创建/改动查看/合并回主目录/清理/降级
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-data-'));
const REPO = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-repo-'));
process.env.AGENTS_CHAT_DATA = DATA;
process.env.AGENTS_CHAT_CWD = REPO;

const git = (args) => new Promise((r, j) => execFile('git', args, { cwd: REPO }, (e, so, se) => e ? j(new Error(se || e.message)) : r(so)));

test('准备 git 仓库基线', async () => {
  await git(['init', '-q']);
  await git(['config', 'user.email', 't@t']);
  await git(['config', 'user.name', 't']);
  fs.writeFileSync(path.join(REPO, 'base.txt'), 'hello\n');
  fs.mkdirSync(path.join(REPO, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(REPO, 'sub', 'a.txt'), 'aaa\n');
  await git(['add', '-A']);
  await git(['commit', '-qm', 'init']);
});

let wt;
test('createForTask：建 worktree 与分支', async (t) => {
  const w = require('../app/lib/worktree');
  wt = await w.createForTask('t-test-1');
  assert.ok(wt, '应创建成功');
  assert.ok(fs.existsSync(path.join(wt.dir, 'base.txt')));
  assert.match(wt.branch, /^ac\//);
  assert.match(wt.base, /^[0-9a-f]{40}$/);
});

test('createForTask：非 git 目录返回 null', async () => {
  const w = require('../app/lib/worktree');
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-plain-'));
  const old = process.env.AGENTS_CHAT_CWD;
  process.env.AGENTS_CHAT_CWD = plain;
  assert.strictEqual(await w.createForTask('t-plain'), null);
  process.env.AGENTS_CHAT_CWD = old;
});

test('diff：新增/修改/删除文件全部可见', async () => {
  const w = require('../app/lib/worktree');
  fs.writeFileSync(path.join(wt.dir, 'new.txt'), 'new content\n');       // 未跟踪新增
  fs.appendFileSync(path.join(wt.dir, 'base.txt'), 'more\n');            // 修改
  fs.unlinkSync(path.join(wt.dir, 'sub', 'a.txt'));                     // 删除
  const d = await w.diff(wt, { withPatch: true });
  const files = d.stat.map(s => s.file).sort();
  assert.deepStrictEqual(files, ['base.txt', 'new.txt', 'sub/a.txt']);
  const byFile = Object.fromEntries(d.files.map(f => [f.path, f.patch]));
  assert.ok(byFile['new.txt'].includes('+new content'));
  assert.ok(byFile['base.txt'].includes('+more'));
  assert.ok(d.stat.find(s => s.file === 'new.txt').add > 0);
});

test('mergeToMain：改动合并回主仓库', async () => {
  const w = require('../app/lib/worktree');
  const r = await w.mergeToMain(wt, '测试任务');
  assert.ok(r.ok, r.error || '应合并成功');
  assert.ok(fs.existsSync(path.join(REPO, 'new.txt')), '主仓库应出现新文件');
  const txt = fs.readFileSync(path.join(REPO, 'base.txt'), 'utf8');
  assert.ok(txt.includes('more'), '主仓库文件应含修改');
  // 再次合并 → Already up to date
  const r2 = await w.mergeToMain(wt, '测试任务');
  assert.ok(r2.ok && r2.already);
});

test('removeForTask：清理 worktree 与分支', async () => {
  const w = require('../app/lib/worktree');
  const r = await w.removeForTask(wt);
  assert.ok(r.ok, r.error || '应清理成功');
  assert.ok(!fs.existsSync(wt.dir), 'worktree 目录应删除');
  const branches = await git(['branch', '--list', 'ac/t-test-1']);
  assert.strictEqual(branches.trim(), '', '分支应删除');
});

test('pruneStale：完结超期任务被清理，活跃任务保留', async () => {
  const w = require('../app/lib/worktree');
  const wtOld = await w.createForTask('t-old');
  const wtLive = await w.createForTask('t-live');
  assert.ok(wtOld && wtLive);
  const tasks = [
    { id: 't-old', status: 'done', createdAt: Date.now() - 40 * 24 * 3600 * 1000, updatedAt: Date.now() - 40 * 24 * 3600 * 1000, worktree: wtOld },
    { id: 't-live', status: 'pending', createdAt: Date.now(), worktree: wtLive }
  ];
  const stat = await w.pruneStale(15, tasks);
  assert.strictEqual(stat.worktrees, 1);
  assert.ok(!fs.existsSync(wtOld.dir), '超期 worktree 应删除');
  assert.ok(fs.existsSync(wtLive.dir), '活跃任务 worktree 应保留');
  await w.removeForTask(wtLive);
});

test('runWithTaskCwd：异步上下文注入与恢复', async () => {
  const w = require('../app/lib/worktree');
  const { resolveCwd } = require('../app/lib/agent');
  const isoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-iso-'));
  const outer = resolveCwd();
  await w.runWithTaskCwd(isoDir, async () => {
    assert.strictEqual(resolveCwd(), isoDir);
    await new Promise(r => setTimeout(r, 5));
    assert.strictEqual(resolveCwd(), isoDir, 'await 之后仍应保持');
  });
  assert.strictEqual(resolveCwd(), outer, '上下文外应恢复');
  // 目录被删后注入自动失效（回退共享/环境目录）
  fs.rmdirSync(isoDir);
  await w.runWithTaskCwd(isoDir, async () => {
    assert.strictEqual(resolveCwd(), outer, '失效目录应回退');
  });
  // 并发互不干扰：内层隔离目录，外层保持
  let inner = '';
  const iso2 = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-iso2-'));
  const p = w.runWithTaskCwd(iso2, async () => {
    await new Promise(r => setTimeout(r, 10));
    inner = resolveCwd();
  });
  assert.strictEqual(resolveCwd(), outer, '并发外层不受内层注入影响');
  await p;
  assert.strictEqual(inner, iso2);
});
