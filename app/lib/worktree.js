// Git worktree 任务隔离：
// 创建任务时可选在独立 git worktree 中执行（每任务独立分支+目录，互不污染），
// 完成后可查看改动 diff、合并回主工作目录或整体丢弃。
// 工作目录（resolveCwd()）不是 git 仓库时功能自动降级（任务照常在共享目录执行）。
//
// cwd 传递：AsyncLocalStorage 按任务执行上下文注入（agent.js/oc.js 的 resolveCwd 优先读取），
// 与并发的聊天请求互不干扰（聊天不在该 async 上下文内）。
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { AsyncLocalStorage } = require('node:async_hooks');
const store = require('./store');

const WT_ROOT = path.join(store.DATA_DIR, 'worktrees');
const BRANCH_PREFIX = 'ac/';
const DIFF_MAX_FILES = 50;          // diff 视图最多展示文件数
const DIFF_MAX_PATCH = 20 * 1024;   // 单文件 patch 截断
const DIFF_MAX_TOTAL = 200 * 1024;  // 总 patch 截断

// ---------- 任务级 cwd 注入（AsyncLocalStorage） ----------
const taskCwdStorage = new AsyncLocalStorage();
function runWithTaskCwd(cwd, fn) {
  return cwd ? taskCwdStorage.run({ cwd }, fn) : fn();
}
function currentTaskCwd() {
  const s = taskCwdStorage.getStore();
  if (!s || !s.cwd) return '';
  try { if (fs.existsSync(s.cwd) && fs.statSync(s.cwd).isDirectory()) return s.cwd; } catch { /* ignore */ }
  return '';
}

// ---------- git 基础 ----------
function git(args, opts = {}) {
  return new Promise((resolve) => {
    execFile('git', args, {
      cwd: opts.cwd,
      timeout: opts.timeout || 30000,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true
    }, (err, so, se) => {
      resolve({ code: err ? (err.code === undefined ? 1 : err.code) : 0, so: String(so || ''), se: String(se || '') });
    });
  });
}

// 工作目录是否为可用 git 仓库（有至少一个提交）
async function isGitRepo(dir) {
  if (!dir) return false;
  const r = await git(['rev-parse', '--is-inside-work-tree'], { cwd: dir });
  if (String(r.so).trim() !== 'true') return false;
  const h = await git(['rev-parse', 'HEAD'], { cwd: dir });
  return h.code === 0 && h.so.trim() !== '';
}

function wtDirOf(taskId) { return path.join(WT_ROOT, String(taskId).replace(/[^\w-]/g, '')); }
function branchOf(taskId) { return BRANCH_PREFIX + String(taskId).replace(/[^\w-]/g, ''); }

// ---------- 创建 / 清理 ----------
// 为任务创建隔离 worktree；返回 { dir, branch, base } 或 null（非 git 仓库 / git 不可用 / 目录残留等）
async function createForTask(taskId) {
  try {
    const { resolveCwd } = require('./agent');
    const baseCwd = resolveCwd();
    if (!(await isGitRepo(baseCwd))) return null;
    const head = await git(['rev-parse', 'HEAD'], { cwd: baseCwd });
    const base = head.so.trim();
    if (!base) return null;
    const dir = wtDirOf(taskId);
    const branch = branchOf(taskId);
    // 残留清理（上次异常退出可能留下同名 worktree/分支）
    await git(['worktree', 'remove', '--force', dir], { cwd: baseCwd });
    await git(['branch', '-D', branch], { cwd: baseCwd });
    const r = await git(['worktree', 'add', '-b', branch, dir, 'HEAD'], { cwd: baseCwd });
    if (r.code !== 0) return null;
    return { dir, branch, base, createdAt: Date.now() };
  } catch {
    return null;
  }
}

// 从 worktree 目录反查主仓库根目录
async function findMainRepo(dir) {
  const g = await git(['rev-parse', '--git-common-dir'], { cwd: dir });
  if (g.code !== 0) return '';
  const common = g.so.trim();
  if (!common) return '';
  let main = path.resolve(dir, common.replace(/[/\\]\.git$/, ''));
  try { if (!fs.statSync(main).isDirectory()) return ''; } catch { return ''; }
  return main;
}

// 删除 worktree 与对应分支；返回 { ok, error }
async function removeForTask(worktree, { keepBranch = false } = {}) {
  if (!worktree || !worktree.dir) return { ok: false, error: '无隔离区信息' };
  let mainRepo = worktree.mainRepo || '';
  if (!mainRepo && fs.existsSync(worktree.dir)) mainRepo = await findMainRepo(worktree.dir);
  const r1 = await git(['worktree', 'remove', '--force', worktree.dir], { cwd: mainRepo || undefined });
  let r2 = { code: 0 };
  if (!keepBranch && worktree.branch) r2 = await git(['branch', '-D', worktree.branch], { cwd: mainRepo || undefined });
  const ok = r1.code === 0; // 分支删除失败不阻塞（可能已被合并删除）
  return { ok, error: ok ? '' : String((r1.se || r1.so || '').split('\n')[0] || '清理失败').slice(0, 200) };
}

// ---------- 改动查看 ----------
// 统计与明细：base（创建时 HEAD）→ 当前工作区（含未提交与未跟踪）
async function diff(worktree, { withPatch = true } = {}) {
  if (!worktree || !worktree.dir) throw new Error('无隔离区信息');
  const dir = worktree.dir;
  const base = worktree.base || 'HEAD';
  // add -A 仅为了让未跟踪文件进入 diff（不动分支指针）
  await git(['add', '-A'], { cwd: dir });
  const st = await git(['diff', '--numstat', base, '--'], { cwd: dir });
  const stat = [];
  for (const line of st.so.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    stat.push({ file: parts[2], add: parts[0] === '-' ? null : Number(parts[0]), del: parts[1] === '-' ? null : Number(parts[1]) });
    if (stat.length >= DIFF_MAX_FILES) break;
  }
  const out = { base, branch: worktree.branch, dir, stat, files: [] };
  if (!withPatch || !stat.length) return out;
  let total = 0;
  for (const s of stat) {
    if (total >= DIFF_MAX_TOTAL) { out.truncated = true; break; }
    const p = await git(['diff', base, '--', s.file], { cwd: dir });
    let patch = p.so;
    if (patch.length > DIFF_MAX_PATCH) { patch = patch.slice(0, DIFF_MAX_PATCH) + '\n…（已截断）'; out.truncated = true; }
    total += patch.length;
    out.files.push({ path: s.file, patch });
  }
  return out;
}

// ---------- 合并回主工作目录 ----------
// worktree 内未提交改动先提交，再在主仓库 merge 该分支
async function mergeToMain(worktree, title) {
  if (!worktree || !worktree.dir) throw new Error('无隔离区信息');
  const dir = worktree.dir;
  // 找主仓库：worktree 里 git rev-parse --git-common-dir 指向主 .git
  const mainRepo = await findMainRepo(dir);
  // 1. worktree 内提交全部改动
  const hasChange = await git(['status', '--porcelain'], { cwd: dir });
  if (hasChange.code === 0 && hasChange.so.trim()) {
    await git(['add', '-A'], { cwd: dir });
    const cm = await git(['commit', '-m', `agents-chat: ${String(title || '任务').slice(0, 60)}`], { cwd: dir });
    if (cm.code !== 0) return { ok: false, error: `隔离区提交失败：${String((cm.se || cm.so).split('\n')[0]).slice(0, 200)}` };
  }
  // 2. 主仓库合并（--no-edit 保留默认合并信息；无改动则 nothing to commit）
  const mr = await git(['merge', '--no-edit', worktree.branch], { cwd: mainRepo || undefined });
  const mOut = String((mr.so || '') + (mr.se || '')).trim();
  if (/Already up to date|已是最新|Nothing to merge/i.test(mOut)) return { ok: true, already: true };
  if (mr.code !== 0) {
    // 合并冲突：回滚合并状态，让用户在隔离区自行处理后再试
    await git(['merge', '--abort'], { cwd: mainRepo || undefined });
    return { ok: false, error: `合并冲突（已还原主目录）：${mOut.split('\n')[0].slice(0, 200)}` };
  }
  return { ok: true };
}

// ---------- 数据治理 ----------
// 清理无主（任务已删）或完结超期的 worktree；liveTasks: 当前任务数组
async function pruneStale(days, liveTasks) {
  const stat = { worktrees: 0 };
  const cutoff = Date.now() - Math.max(1, Number(days) || 15) * 24 * 3600 * 1000;
  const live = new Map((liveTasks || []).filter(t => t.worktree).map(t => [wtDirOf(t.id), t]));
  let names = [];
  try { names = fs.readdirSync(WT_ROOT); } catch { return stat; }
  for (const name of names) {
    const dir = path.join(WT_ROOT, name);
    try {
      if (!fs.statSync(dir).isDirectory()) continue;
      const task = live.get(dir);
      const w = task ? task.worktree : { dir, branch: branchOf(name), mainRepo: '' };
      let stale = !task;
      if (task) {
        const end = Number(task.updatedAt || task.createdAt) || 0;
        stale = (task.status === 'done' || task.status === 'failed') && end && end < cutoff;
      }
      if (!stale) continue;
      const r = await removeForTask(w);
      if (r.ok) stat.worktrees++;
    } catch { /* 单项失败跳过 */ }
  }
  return stat;
}

module.exports = {
  WT_ROOT, DIFF_MAX_FILES,
  runWithTaskCwd, currentTaskCwd,
  isGitRepo, createForTask, removeForTask, diff, mergeToMain, pruneStale
};
