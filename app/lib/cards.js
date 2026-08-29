// 事项管控（卡牌）核心：数据模型 + 自动注入执行器 + 过程/结果归档
// 复用 oc.chatSolo（opencode run --format json，支持 -s 续聊）作为单 Agent 执行内核
// 核心能力：
//   1) 卡牌增删改查（cards.json，零依赖），order 字段决定看板内顺序（可拖拽调整）
//   2) 依赖解析：dependsOn 全部完成后才可被调度
//   3) 双轨注入：mode='continue' 复用上一卡牌的 opencode 会话（同进程续聊）；
//                mode='new'/'parallel' 新开进程（各自独立会话）
//   4) 完成自动感知：oc.chatSolo 的 done 事件触发下一张卡牌注入（无需人工干预）
//   5) 过程与结果归档：过程事件落入 messages.json（taskId=cardId）+ 流转日志 flow.jsonl
//   6) 工作区（workspace）：可选，指定后 Agent 在该目录读写文件，相关产出集中存放
const fs = require('fs');
const path = require('path');
const { resolveRunner, detectKernels, KERNEL_DEFS, stopScope } = require('./agent');
const oc = require('./oc');
const store = require('./store');
const safejson = require('./safejson');

const ROOT = path.join(__dirname, '..', '..');
const DATA_DIR = process.env.AGENTS_CHAT_DATA || path.join(ROOT, '.data');
const CARDS_PATH = path.join(DATA_DIR, 'cards.json');
const CARDS_CFG_PATH = path.join(DATA_DIR, 'cards_config.json');
const TRASH_PATH = path.join(DATA_DIR, 'cards_trash.json');
const TRASH_TTL = 30 * 24 * 3600 * 1000; // 垃圾桶默认保留 30 天

function ensureDir() { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); }
// 数据损坏保护（safejson 公共层）：解析失败 → 备份 .corrupt-* 并只读；写入一律原子替换
const corrupted = new Set(); // 已损坏的文件路径（本模块文件）
function cachedReader(file, cacheBox) {
  return function read() {
    if (safejson.isCorrupted(file)) return [];
    try {
      const st = fs.statSync(file);
      if (cacheBox.list && st.mtimeMs === cacheBox.mtime) return cacheBox.list;
      const list = JSON.parse(fs.readFileSync(file, 'utf8'));
      cacheBox.mtime = st.mtimeMs; cacheBox.list = list;
      return list;
    } catch (err) {
      if (err && err.code === 'ENOENT') { // 文件不存在：正常的初始状态
        cacheBox.mtime = 0; cacheBox.list = null;
        return [];
      }
      // 文件存在但解析失败：经 safejson 备份损坏现场并登记，进入只读保护
      safejson.readJson(file, []);
      corrupted.add(file);
      cacheBox.mtime = 0; cacheBox.list = null;
      return [];
    }
  };
}
const _cardsCache = { mtime: 0, list: null };
const _cfgCache = { mtime: 0, list: null };
const _trashCache = { mtime: 0, list: null };
const readCardsRaw = cachedReader(CARDS_PATH, _cardsCache);
const readConfigRaw = cachedReader(CARDS_CFG_PATH, _cfgCache);
const readTrashRaw = cachedReader(TRASH_PATH, _trashCache);
function readCards() {
  // 返回浅拷贝：调用方（list 的 sort 等）对数组的操作不影响缓存
  const v = readCardsRaw();
  return Array.isArray(v) ? v.slice() : [];
}
function invalidate(file) {
  if (file === CARDS_PATH) { _cardsCache.mtime = 0; _cardsCache.list = null; }
  else if (file === CARDS_CFG_PATH) { _cfgCache.mtime = 0; _cfgCache.list = null; }
  else if (file === TRASH_PATH) { _trashCache.mtime = 0; _trashCache.list = null; }
}
// 损坏保护下的写入守卫：拒绝覆盖写（保留备份供人工恢复）
function guardWrite(file) {
  if (corrupted.has(file) || safejson.isCorrupted(file)) {
    corrupted.add(file);
    throw new Error(`数据文件 ${path.basename(file)} 已损坏（原文件已备份为 .corrupt-*），为防数据丢失已停止写入，请人工检查 ${DATA_DIR} 后删除损坏标记文件`);
  }
}
function writeCards(list) {
  ensureDir();
  guardWrite(CARDS_PATH);
  invalidate(CARDS_PATH);
  safejson.writeJson(CARDS_PATH, list);
}
function readConfig() {
  const v = readConfigRaw();
  return (v && typeof v === 'object' && !Array.isArray(v)) ? v : { workspace: '' };
}
function writeConfig(cfg) {
  ensureDir();
  guardWrite(CARDS_CFG_PATH);
  invalidate(CARDS_CFG_PATH);
  safejson.writeJson(CARDS_CFG_PATH, cfg);
}
function readTrash() {
  const v = readTrashRaw();
  return Array.isArray(v) ? v.slice() : [];
}
function writeTrash(list) {
  ensureDir();
  guardWrite(TRASH_PATH);
  invalidate(TRASH_PATH);
  safejson.writeJson(TRASH_PATH, list);
}
// 启动时清理超过 30 天的垃圾桶快照，并连带清除其日志，避免占用磁盘
(function purgeTrash() {
  const list = readTrash();
  if (!list.length) return;
  const now = Date.now();
  const keep = [];
  let purged = 0;
  for (const t of list) {
    if (now - (t.deletedAt || 0) > TRASH_TTL) { try { store.deleteTask(t.card && t.card.id); } catch { /* ignore */ } purged++; }
    else keep.push(t);
  }
  if (purged) writeTrash(keep);
})();

function newId() { return 'c-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6); }

// ---------- 卡牌仓储 ----------
const CardStore = {
  // 看板顺序：order 升序（拖拽调整）；无 order 的旧数据兜底按 createdAt
  list() {
    return readCards().sort((a, b) => ((a.order === undefined ? 1e9 : a.order) - (b.order === undefined ? 1e9 : b.order)) || (a.createdAt - b.createdAt));
  },
  get(id) { return readCards().find(c => c.id === id) || null; },
  add(card) {
    const list = readCards();
    const order = list.length ? Math.max(...list.map(c => (c.order === undefined ? 0 : c.order))) + 1 : 1;
    const rec = {
      id: card.id || newId(),
      title: String(card.title || '').slice(0, 500),
      content: String(card.content || '').slice(0, 20000),
      priority: Number(card.priority) || 999,
      status: 'pending',
      mode: ['new', 'continue', 'parallel'].includes(card.mode) ? card.mode : 'new',
      chainId: card.mode === 'continue' ? String(card.chainId || '') : '',
      dependsOn: Array.isArray(card.dependsOn) ? card.dependsOn.map(String) : [],
      model: String(card.model || '').slice(0, 80),
      ocSessionId: '',
      result: '',
      error: '',
      order,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      startedAt: 0,
      finishedAt: 0
    };
    // continue 卡牌隐式依赖其链首卡牌：必须等链首产出会话后再续聊
    if (rec.mode === 'continue' && rec.chainId && !rec.dependsOn.includes(rec.chainId)) {
      rec.dependsOn.push(rec.chainId);
    }
    list.push(rec);
    writeCards(list);
    return rec;
  },
  update(id, patch) {
    const list = readCards();
    const c = list.find(x => x.id === id);
    if (!c) return null;
    Object.assign(c, patch, { updatedAt: Date.now() });
    writeCards(list);
    return c;
  },
  // 拖拽重排：order 重编 + priority 按新顺序重映射（保值域、变归属），
  // 使调度顺序恒等于看板顺序（priority 仍是排序主键，但层内次序由拖拽决定）
  reorder(ids) {
    // 全量重编：传入 ids 按新顺序排前，未涉及的卡保持原相对顺序排后，
    // 保证全表 order/priority 唯一且连续（部分重排不再产生并列 order）
    const list = readCards();
    const idSet = new Set(ids);
    const ordered = ids.map(id => list.find(c => c.id === id)).filter(Boolean);
    const rest = list.filter(c => !idSet.has(c.id));
    const seq = [...ordered, ...rest];
    const prios = seq.map(c => (c.priority === undefined ? 999 : c.priority)).sort((a, b) => a - b);
    seq.forEach((c, i) => { c.order = i + 1; c.priority = prios[i]; });
    writeCards(list);
    return true;
  },
  remove(id) {
    const list = readCards();
    const card = list.find(c => c.id === id);
    if (!card) return false;
    // 软删除：移入垃圾桶（保留过程日志快照），并从看板移除
    const msgs = [];
    try { for (const m of store.getMessages(id)) msgs.push(m); } catch { /* ignore */ }
    const trash = readTrash();
    trash.push({ card: { ...card }, deletedAt: Date.now(), messages: msgs });
    writeTrash(trash);
    const newList = list.filter(c => c.id !== id);
    writeCards(newList);
    // 其余任务若有引用该任务，清理其链/依赖引用
    const others = newList.map(c => {
      let changed = false;
      if (c.chainId === id) { c.chainId = ''; c.mode = 'new'; changed = true; }
      if (Array.isArray(c.dependsOn)) {
        const before = c.dependsOn.length;
        c.dependsOn = c.dependsOn.filter(d => d !== id);
        if (c.dependsOn.length !== before) changed = true;
      }
      return changed ? c : null;
    }).filter(Boolean);
    if (others.length) { for (const o of others) { const t = newList.find(x => x.id === o.id); if (t) Object.assign(t, o); } writeCards(newList); }
    return true;
  },
  getTrash() {
    return readTrash().sort((a, b) => b.deletedAt - a.deletedAt);
  },
  emptyTrash() {
    const trash = readTrash();
    for (const t of trash) { try { store.deleteTask(t.card && t.card.id); } catch { /* ignore */ } }
    writeTrash([]);
    return trash.length;
  },
  restoreFromTrash(id) {
    const trash = readTrash();
    const idx = trash.findIndex(t => t.card && t.card.id === id);
    if (idx < 0) return null;
    const snap = trash[idx];
    const card = { ...snap.card, status: 'pending', ocSessionId: '', result: '', error: '', startedAt: 0, finishedAt: 0 };
    // 还原过程日志
    if (Array.isArray(snap.messages)) for (const m of snap.messages) { try { store.addMessage({ ...m }); } catch { /* ignore */ } }
    const list = readCards();
    const maxOrder = list.length ? Math.max(...list.map(c => (c.order === undefined ? 0 : c.order))) : 0;
    card.order = maxOrder + 1;
    list.push(card);
    writeCards(list);
    trash.splice(idx, 1);
    writeTrash(trash);
    return card;
  },
  resetRunning() {
    const list = readCards();
    let n = 0;
    for (const c of list) if (c.status === 'running') { c.status = 'pending'; c.error = '服务重启，已复位为待执行'; n++; }
    if (n) writeCards(list);
    return n;
  },
  getConfig() { return readConfig(); },
  setConfig(patch) {
    const c = readConfig();
    Object.assign(c, patch);
    writeConfig(c);
    return c;
  }
};

// ---------- 执行器（事件广播 + 自动注入） ----------
const MAX_PARALLEL = Number(process.env.AGENTS_CHAT_CARD_PARALLEL) > 0 ? Number(process.env.AGENTS_CHAT_CARD_PARALLEL) : 2;
const subscribers = new Set();

function broadcast(ev) {
  for (const send of subscribers) { try { send(ev); } catch { /* closed */ } }
}
function sseSubscribe(send) { subscribers.add(send); return () => subscribers.delete(send); }

function buildCardPrompt(card, workspace) {
  let p = `【多任务编排 · 任务 ${card.id}】\n标题：${card.title}\n\n任务内容：\n${card.content}\n\n请完成上述任务，并给出明确的结果与（如有）产出文件的完整路径。`;
  if (workspace) p += `\n\n工作目录（请在以下目录读写相关文件）：${workspace}`;
  return p;
}

function isEligible(card, all) {
  if (card.status !== 'pending') return false;
  for (const dep of (card.dependsOn || [])) {
    const d = all.find(c => c.id === dep);
    if (!d || d.status !== 'done') return false;
  }
  return true;
}

// 环检测：把 cardId 的依赖改为 newDeps 后，沿依赖边 DFS 是否能回到 cardId 自身
// 用于 PUT 写入拦截（间接环也拦截，如 A→B→C→A）
function wouldCycle(cardId, newDeps) {
  const all = CardStore.list();
  const byId = new Map(all.filter(c => c.id !== cardId).map(c => [c.id, c]));
  const seen = new Set();
  const stack = [...(newDeps || [])];
  while (stack.length) {
    const cur = stack.pop();
    if (cur === cardId) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const c = byId.get(cur);
    if (c) stack.push(...(c.dependsOn || []));
  }
  return false;
}

function pickEligible(all, activeIds) {
  const eligible = all.filter(c => isEligible(c, all) && !activeIds.has(c.id));
  eligible.sort((a, b) => {
    const pa = a.priority === undefined ? 999 : a.priority;
    const pb = b.priority === undefined ? 999 : b.priority;
    if (pa !== pb) return pa - pb;
    return (a.order || 0) - (b.order || 0);
  });
  return eligible;
}

class CardRunner {
  constructor() {
    this.active = new Set();
    this.token = 0;
    this.running = false;
    this.timer = null;
    this.procs = new Map(); // cardId -> { pid, child, lastActive, status }
    this.followups = new Set(); // 追加聊天中的卡牌（并发防护）
    this.killedCards = new Set(); // 本轮编排中被单卡停止的卡：跳过调度直到本轮结束
    this.baseline = null; // 本轮编排开始时的 done/failed 基线（all_done 报增量）
  }
  isRunning() { return this.running; }

  // 并行度热更新：调大后立即补齐在跑任务（无需等下一个任务完成触发 tick）
  onConfigChanged() {
    if (this.running) this.tick();
  }

  // 并行度：cards_config.maxParallel 可热更新（1-8），未配置时用 env 默认
  maxP() {
    try {
      const n = Number(readConfig().maxParallel);
      if (n >= 1 && n <= 8) return Math.floor(n);
    } catch { /* ignore */ }
    return MAX_PARALLEL;
  }

  // 终止单个任务对应的子进程（删除卡等场景：不改变调度语义）
  killCard(cardId) {
    this.active.delete(cardId);
    const p = this.procs.get(cardId);
    if (p && p.child) { try { p.child.kill('SIGTERM'); } catch { /* ignore */ } }
    this.procs.delete(cardId);
  }

  // 单卡停止：杀进程 + 标记本轮不再自动调度（状态回待执行，与全局停止的复位语义一致）
  stopOne(cardId) {
    const card = CardStore.get(cardId);
    if (!card || card.status !== 'running') return false;
    if (this.followups.has(cardId)) return false; // 追加聊天进行中：走 chatFollowup 自己的错误路径
    this.killedCards.add(cardId);
    this.killCard(cardId);
    // 主动复位状态：以这里为准（子进程 close 回调到达时 runCard 会再写一次 pending，幂等），
    // 避免回调异常丢失时卡片永远停留在 running
    CardStore.update(cardId, { status: 'pending', result: '', error: '', finishedAt: Date.now() });
    broadcast({ type: 'notice', content: `⏹ 已停止任务「${card.title}」，该任务回到待执行（本轮编排不再自动调度它）` });
    broadcast({ type: 'task_done', cardId, status: 'stopped', title: card.title });
    return true;
  }

  // 供前端展示：当前存活进程 + opencode 是否在工作中（近 5s 有活动即视为工作中）
  getProcesses() {
    const out = [];
    const now = Date.now();
    for (const [cardId, p] of this.procs) {
      out.push({ cardId, pid: p.pid || null, working: (now - (p.lastActive || 0)) < 5000 });
    }
    return out;
  }

  stop() {
    this.token++;
    this.running = false;
    this.killedCards.clear();
    if (this.timer) { try { this.timer.unref(); } catch { /* ignore */ } }
    try { stopScope('solo'); } catch { /* ignore */ }
    this.procs.clear();
    broadcast({ type: 'notice', content: '⏹ 多任务编排执行已停止，未开始的任务保留待执行' });
    broadcast({ type: 'runner_stopped' });
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.token++;
    this.killedCards.clear();
    // 记录基线：all_done 时报告本轮增量（成功/失败数），避免混入历史任务
    const all0 = CardStore.list();
    this.baseline = { done: all0.filter(c => c.status === 'done').length, failed: all0.filter(c => c.status === 'failed').length };
    broadcast({ type: 'runner_started' });
    this.tick();
  }

  tick() {
    if (!this.running) return;
    const myToken = this.token;
    const all = CardStore.list();
    // 单卡停止的任务本轮跳过（用户已明确表示停它，不让调度器立刻拉起）
    const eligible = pickEligible(all, this.active).filter(c => !this.killedCards.has(c.id));
    if (!eligible.length) {
      if (this.active.size === 0) {
        this.running = false;
        // 完成通知附本轮增量统计（成功/失败数），前端据此提醒
        const all = CardStore.list();
        const done = Math.max(0, all.filter(c => c.status === 'done').length - (this.baseline ? this.baseline.done : 0));
        const failed = Math.max(0, all.filter(c => c.status === 'failed').length - (this.baseline ? this.baseline.failed : 0));
        this.baseline = null;
        broadcast({ type: 'all_done', done, failed });
      }
      return;
    }
    const limit = this.maxP();
    while (this.active.size < limit && eligible.length > 0) {
      const card = eligible.shift();
      this.active.add(card.id);
      const p = this.runCard(card, myToken);
      p.finally(() => {
        this.active.delete(card.id);
        if (myToken === this.token) this.tick();
      });
    }
  }

  async runCard(card, myToken) {
    // 重跑保护（最先执行）：上次结果先归档进过程日志，可追溯，再清空
    if (card.result) {
      store.addMessage({ role: 'assistant', agentId: 'solo', agentName: 'Agent', actor: 'assistant', phase: 'archive', taskId: card.id, content: `[上次结果归档]\n${String(card.result).slice(0, 20000)}` });
    }
    const runner = resolveRunner();
    if (runner.kind === 'missing') {
      const hint = require('./agent').missingHint(runner);
      CardStore.update(card.id, { status: 'failed', error: hint.slice(0, 2000), result: '', finishedAt: Date.now() });
      broadcast({ type: 'task_done', cardId: card.id, status: 'failed', title: card.title });
      return;
    }
    if (runner.kind === 'demo') {
      CardStore.update(card.id, { status: 'failed', error: '演示模式下任务执行不可用，请安装 opencode/claude/codex/pi 内核', result: '', finishedAt: Date.now() });
      broadcast({ type: 'task_done', cardId: card.id, status: 'failed', title: card.title });
      return;
    }

    let ocSessionId = '';
    if (card.mode === 'continue' && card.chainId) {
      const prev = CardStore.get(card.chainId);
      ocSessionId = prev && prev.ocSessionId ? prev.ocSessionId : '';
      // 语义降级显式提示：避免「名义续聊、实际新会话」静默发生
      if (!ocSessionId) {
        const warn = '续聊链首无可用会话（可能已被重置，或由不支持会话续聊的内核执行），本任务将以全新会话执行';
        store.addMessage({ role: 'assistant', agentId: 'solo', agentName: 'Agent', actor: 'assistant', phase: 'system', taskId: card.id, content: `[系统提示] ${warn}` });
        broadcast({ type: 'notice', content: `⚠ ${card.title}：${warn}` });
      }
    }

    CardStore.update(card.id, { status: 'running', startedAt: Date.now(), error: '', result: '' });
    broadcast({ type: 'task_start', cardId: card.id, title: card.title, mode: card.mode, ocSessionId });

    const kind = runner.kind === 'opencode' ? 'opencode' : 'fallback';
    const cfg = CardStore.getConfig();
    const workspace = (cfg.workspace || '').trim();
    // 工作区校验：路径无效时显式警告（禁止静默降级到默认目录）
    let ws = '';
    if (workspace) {
      if (isValidDir(workspace)) ws = workspace;
      else {
        const warn = `[系统提示] 工作区路径无效：${workspace}，本任务将在默认目录执行`;
        store.addMessage({ role: 'assistant', agentId: 'solo', agentName: 'Agent', actor: 'assistant', phase: 'system', taskId: card.id, content: warn });
        broadcast({ type: 'ws_warning', cardId: card.id, path: workspace });
      }
    }
    const prompt = buildCardPrompt(card, ws);
    const texts = new Map();
    const order = [];
    let doneError = '';
    let sesId = ocSessionId;

    let child = null;
    // 进程登记：spawn 前占位（执行中即可见于进程条），spawn 后回填真实 PID
    this.procs.set(card.id, { pid: null, child: null, lastActive: Date.now() });
    broadcast({ type: 'proc', cardId: card.id, pid: null });
    try {
      await new Promise((resolve) => {
        child = oc.chatSolo(kind, runner, {
          prompt,
          model: card.model || '',
          ocSessionId: sesId,
          behavior: 'card',
          cwd: ws || undefined
        }, (ev) => {
          const proc = this.procs.get(card.id);
          if (proc) { proc.lastActive = Date.now(); }
          if (ev.type === 'session') {
            sesId = ev.ocSessionId;
            CardStore.update(card.id, { ocSessionId: sesId });
            broadcast({ type: 'session', cardId: card.id, ocSessionId: sesId });
          } else if (ev.type === 'text') {
            if (!texts.has(ev.partId)) order.push(ev.partId);
            texts.set(ev.partId, ev.text);
            broadcast({ type: 'text', cardId: card.id, partId: ev.partId, text: ev.text, agentName: 'Agent', phase: 'work' });
          } else if (ev.type === 'reasoning') {
            broadcast({ type: 'reasoning', cardId: card.id, partId: ev.partId, text: ev.text });
          } else if (ev.type === 'tool') {
            broadcast({ type: 'tool', cardId: card.id, name: ev.name, summary: ev.summary });
            store.addMessage({ role: 'assistant', agentId: 'solo', agentName: 'Agent', actor: 'assistant', phase: 'work', taskId: card.id, content: `[工具] ${ev.name}${ev.summary ? '（' + ev.summary + '）' : ''} 执行完成` });
          } else if (ev.type === 'done') {
            doneError = ev.error || '';
            resolve();
          }
        });
        // chatSolo 同步返回 child（spawn 已完成）：立即回填真实 PID，执行中即可见于进程条
        const proc0 = this.procs.get(card.id);
        if (proc0 && child) { proc0.pid = child.pid; proc0.child = child; }
        broadcast({ type: 'proc', cardId: card.id, pid: child ? child.pid : null });
      });
    } catch (err) {
      doneError = String((err && err.message) || err).slice(0, 2000);
    }

    const finalText = order.map(id => texts.get(id)).join('\n\n').trim();
    const stopped = myToken !== this.token;
    const cardStopped = this.killedCards.has(card.id); // 单卡停止：与全局停止同样复位为待执行
    if (finalText) {
      store.addMessage({ role: 'assistant', agentId: 'solo', agentName: 'Agent', actor: 'assistant', phase: 'work', taskId: card.id, content: finalText.slice(0, 20000) });
    }
    const stoppedAny = stopped || cardStopped;
    const status = stoppedAny ? 'pending' : (doneError ? 'failed' : 'done');
    CardStore.update(card.id, {
      status,
      ocSessionId: sesId,
      // 手动停止回到待执行：清掉残留，避免 pending 卡带着脏结果/错误
      result: stoppedAny ? '' : (doneError ? `执行出错：${doneError}` : finalText).slice(0, 20000),
      error: stoppedAny ? '' : (doneError || ''),
      finishedAt: Date.now()
    });
    broadcast({ type: 'task_done', cardId: card.id, status, title: card.title });
    // 任务结束，移除进程登记
    this.procs.delete(card.id);
  }

  async runOne(cardId) {
    const card = CardStore.get(cardId);
    if (!card || card.status === 'running') return false;
    // 并发防护：追加聊天进行中的卡不可同时执行（避免同一会话被两条链路并发续写）
    if (this.followups.has(cardId)) return false;
    this.active.add(cardId);
    const myToken = this.token;
    await this.runCard(card, myToken).catch(() => {});
    this.active.delete(cardId);
    return true;
  }

  // ---------- 任务完成后追加聊天：复用该卡牌的 opencode 会话（-s 续聊，等效同一进程第二轮输入） ----------
  // 过程事件经 broadcast 推送（followup_start / text / tool / followup_done），回复归档进消息与 result
  async chatFollowup(cardId, prompt) {
    const card = CardStore.get(cardId);
    if (!card) return { ok: false, error: '任务不存在' };
    if (card.status === 'running' || card.status === 'pending') return { ok: false, error: '任务尚未执行完成，先运行任务再追加聊天' };
    if (this.active.has(cardId)) return { ok: false, error: '任务正在执行中，稍后再追加聊天' };
    if (this.followups.has(cardId)) return { ok: false, error: '该任务已有追加聊天进行中' };
    this.followups.add(cardId);

    const runner = resolveRunner();
    try {
      if (runner.kind === 'missing') {
        const hint = require('./agent').missingHint(runner);
        return { ok: false, error: hint.slice(0, 500) };
      }
      const kind = runner.kind === 'opencode' ? 'opencode' : 'fallback';
      if (!card.ocSessionId && kind === 'opencode') {
        return { ok: false, error: '该任务没有可续的会话（可能未通过 opencode 内核执行），无法追加聊天' };
      }
      const cfg = CardStore.getConfig();
      const workspace = (cfg.workspace || '').trim();
      const cwd = workspace && isValidDir(workspace) ? workspace : undefined;

      const userText = String(prompt || '').trim();
      if (!userText) return { ok: false, error: '请输入追加内容' };
      store.addMessage({ role: 'user', agentId: 'solo', agentName: '我', actor: 'user', phase: 'followup', taskId: cardId, content: userText.slice(0, 20000) });
      broadcast({ type: 'followup_start', cardId: cardId });
      // 进程登记：spawn 前占位，spawn 后回填 PID（追加聊天执行中亦可见于进程条）
      this.procs.set(cardId, { pid: null, child: null, lastActive: Date.now() });

      const texts = new Map();
      const order = [];
      let doneError = '';
      let sesId = card.ocSessionId || '';
      let child = null;
      try {
        await new Promise((resolve) => {
          child = oc.chatSolo(kind, runner, {
            prompt: userText,
            model: card.model || '',
            ocSessionId: sesId,
            behavior: 'card',
            cwd,
            scope: 'card-fu' // 独立进程域：停止编排不牵连追加聊天
          }, (ev) => {
            const proc = this.procs.get(cardId);
            if (proc) proc.lastActive = Date.now();
            if (ev.type === 'session') {
              sesId = ev.ocSessionId;
              CardStore.update(cardId, { ocSessionId: sesId });
            } else if (ev.type === 'text') {
              if (!texts.has(ev.partId)) order.push(ev.partId);
              texts.set(ev.partId, ev.text);
              broadcast({ type: 'text', cardId, partId: ev.partId, text: ev.text, agentName: 'Agent', phase: 'followup' });
            } else if (ev.type === 'tool') {
              broadcast({ type: 'tool', cardId, name: ev.name, summary: ev.summary, phase: 'followup' });
              store.addMessage({ role: 'assistant', agentId: 'solo', agentName: 'Agent', actor: 'assistant', phase: 'followup', taskId: cardId, content: `[工具] ${ev.name}${ev.summary ? '（' + ev.summary + '）' : ''} 执行完成` });
            } else if (ev.type === 'done') {
              doneError = ev.error || '';
              resolve();
            }
          });
          const proc0 = this.procs.get(cardId);
          if (proc0 && child) { proc0.pid = child.pid; proc0.child = child; }
          broadcast({ type: 'proc', cardId, pid: child ? child.pid : null });
        });
      } catch (err) {
        doneError = String((err && err.message) || err).slice(0, 2000);
      } finally {
        this.procs.delete(cardId);
      }

      const finalText = order.map(id => texts.get(id)).join('\n\n').trim();
      if (finalText) {
        store.addMessage({ role: 'assistant', agentId: 'solo', agentName: 'Agent', actor: 'assistant', phase: 'followup', taskId: cardId, content: finalText.slice(0, 20000) });
      }
      // 追加聊天完成后：结果滚动归档（保留此前结果，追加本轮回复），失败原因单独记录
      const cur = CardStore.get(cardId) || {};
      const merged = [cur.result, finalText].filter(Boolean).join('\n\n');
      CardStore.update(cardId, {
        ocSessionId: sesId,
        result: merged.slice(-20000),
        followupError: doneError || '',
        finishedAt: Date.now()
      });
      broadcast({ type: 'followup_done', cardId, error: doneError || '' });
      return { ok: !doneError, error: doneError || '' };
    } finally {
      this.followups.delete(cardId);
    }
  }

  isFollowupRunning(cardId) { return !!this.followups && this.followups.has(cardId); }
  getFollowupIds() { return [...this.followups]; }
}

// 数据文件损坏状态（供 API 告警展示）
function getCorruptedFiles() { return [...new Set([...corrupted, ...safejson.corruptedFiles()])]; }

function isValidDir(p) {
  try { return fs.existsSync(p) && fs.statSync(p).isDirectory(); } catch { return false; }
}

const runner = new CardRunner();

module.exports = { CardStore, CardRunner, runner, sseSubscribe, buildCardPrompt, isEligible, pickEligible, wouldCycle, MAX_PARALLEL, CARDS_PATH, CARDS_CFG_PATH, getCorruptedFiles };
