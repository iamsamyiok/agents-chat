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

const ROOT = path.join(__dirname, '..', '..');
const DATA_DIR = process.env.AGENTS_CHAT_DATA || path.join(ROOT, '.data');
const CARDS_PATH = path.join(DATA_DIR, 'cards.json');
const CARDS_CFG_PATH = path.join(DATA_DIR, 'cards_config.json');
const TRASH_PATH = path.join(DATA_DIR, 'cards_trash.json');
const TRASH_TTL = 30 * 24 * 3600 * 1000; // 垃圾桶默认保留 30 天

function ensureDir() { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); }
function readCards() {
  try { return JSON.parse(fs.readFileSync(CARDS_PATH, 'utf8')); } catch { return []; }
}
function writeCards(list) {
  ensureDir();
  const tmp = CARDS_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf8');
  fs.renameSync(tmp, CARDS_PATH);
}
function readConfig() {
  try { return JSON.parse(fs.readFileSync(CARDS_CFG_PATH, 'utf8')); } catch { return { workspace: '' }; }
}
function writeConfig(cfg) {
  ensureDir();
  fs.writeFileSync(CARDS_CFG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
}
function readTrash() {
  try { return JSON.parse(fs.readFileSync(TRASH_PATH, 'utf8')); } catch { return []; }
}
function writeTrash(list) {
  ensureDir();
  fs.writeFileSync(TRASH_PATH, JSON.stringify(list, null, 2), 'utf8');
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
  // 拖拽重排：按给定 id 顺序重编 order（ids 为看板当前顺序的全量 id）
  reorder(ids) {
    const list = readCards();
    const map = new Map(list.map(c => [c.id, c]));
    ids.forEach((id, i) => { const c = map.get(id); if (c) c.order = i + 1; });
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
  }
  isRunning() { return this.running; }

  // 终止单个任务对应的子进程
  killCard(cardId) {
    this.active.delete(cardId);
    const p = this.procs.get(cardId);
    if (p && p.child) { try { p.child.kill('SIGTERM'); } catch { /* ignore */ } }
    this.procs.delete(cardId);
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
    broadcast({ type: 'runner_started' });
    this.tick();
  }

  tick() {
    if (!this.running) return;
    const myToken = this.token;
    const all = CardStore.list();
    const eligible = pickEligible(all, this.active);
    if (!eligible.length) {
      if (this.active.size === 0) { this.running = false; broadcast({ type: 'all_done' }); }
      return;
    }
    while (this.active.size < MAX_PARALLEL && eligible.length > 0) {
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
    const runner = resolveRunner();
    if (runner.kind === 'missing') {
      const hint = require('./agent').missingHint(runner);
      CardStore.update(card.id, { status: 'failed', error: hint.slice(0, 2000), finishedAt: Date.now() });
      broadcast({ type: 'task_done', cardId: card.id, status: 'failed', title: card.title });
      return;
    }
    if (runner.kind === 'demo') {
      CardStore.update(card.id, { status: 'failed', error: '演示模式下任务执行不可用，请安装 opencode/claude/codex/pi 内核', finishedAt: Date.now() });
      broadcast({ type: 'task_done', cardId: card.id, status: 'failed', title: card.title });
      return;
    }

    let ocSessionId = '';
    if (card.mode === 'continue' && card.chainId) {
      const prev = CardStore.get(card.chainId);
      ocSessionId = prev && prev.ocSessionId ? prev.ocSessionId : '';
    }

    CardStore.update(card.id, { status: 'running', startedAt: Date.now(), error: '', result: '' });
    broadcast({ type: 'task_start', cardId: card.id, title: card.title, mode: card.mode, ocSessionId });

    const kind = runner.kind === 'opencode' ? 'opencode' : 'fallback';
    const cfg = CardStore.getConfig();
    const workspace = (cfg.workspace || '').trim();
    const prompt = buildCardPrompt(card, workspace && isValidDir(workspace) ? workspace : '');
    const texts = new Map();
    const order = [];
    let doneError = '';
    let sesId = ocSessionId;

    let child = null;
    try {
      await new Promise((resolve) => {
        child = oc.chatSolo(kind, runner, {
          prompt,
          model: card.model || '',
          ocSessionId: sesId,
          behavior: 'card',
          cwd: workspace && isValidDir(workspace) ? workspace : undefined
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
      });
    } catch (err) {
      doneError = String((err && err.message) || err).slice(0, 2000);
    }

    // 登记进程信息（PID + 是否工作中），并广播给前端
    this.procs.set(card.id, { pid: child ? child.pid : null, child, lastActive: Date.now() });
    broadcast({ type: 'proc', cardId: card.id, pid: child ? child.pid : null });

    const finalText = order.map(id => texts.get(id)).join('\n\n').trim();
    const stopped = myToken !== this.token;
    if (finalText) {
      store.addMessage({ role: 'assistant', agentId: 'solo', agentName: 'Agent', actor: 'assistant', phase: 'work', taskId: card.id, content: finalText.slice(0, 20000) });
    }
    const status = stopped ? 'pending' : (doneError ? 'failed' : 'done');
    CardStore.update(card.id, {
      status,
      ocSessionId: sesId,
      result: (doneError ? `执行出错：${doneError}` : finalText).slice(0, 20000),
      error: doneError || '',
      finishedAt: Date.now()
    });
    broadcast({ type: 'task_done', cardId: card.id, status, title: card.title });
    // 任务结束，移除进程登记
    this.procs.delete(card.id);
  }

  async runOne(cardId) {
    const card = CardStore.get(cardId);
    if (!card || card.status === 'running') return false;
    this.active.add(cardId);
    const myToken = this.token;
    await this.runCard(card, myToken).catch(() => {});
    this.active.delete(cardId);
    return true;
  }
}

function isValidDir(p) {
  try { return fs.existsSync(p) && fs.statSync(p).isDirectory(); } catch { return false; }
}

const runner = new CardRunner();

module.exports = { CardStore, CardRunner, runner, sseSubscribe, buildCardPrompt, isEligible, pickEligible, MAX_PARALLEL, CARDS_PATH, CARDS_CFG_PATH };
