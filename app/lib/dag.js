// 任务依赖 DAG 调度器：事件驱动，任一任务到达终态立即扫描解锁后继
// 纯调度逻辑，不依赖 store/server：状态落库与 SSE 事件通过回调注入
// - runOneTask(task) => Promise<'done'|'failed'|'stopped'>：单任务执行（内部负责启动/收尾事件与落库 running→终态）
// - onTerminal(taskId, status)：终态回调（blocked 由调度器产生并回调；其余由 runOneTask 返回值产生）
// - send(event)：SSE 事件（调度器仅发 notice 与 all_done 统计）
// 终止条件：无执行中且无可解锁（全部终态）→ resolve 统计；isStopped() 为真后不再启动新任务，
// 等执行中任务自然收尾（runOneTask 内部感知 stop 返回 'stopped'），waiting 任务保持原状（不落库）。

function dagMaxParallel(envName, fallback) {
  const n = Number(process.env[envName]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function runDagBatch(tasks, runOneTask, opts) {
  const send = opts.send || (() => {});
  const isStopped = opts.isStopped || (() => false);
  const onTerminal = opts.onTerminal || (() => {});
  const maxParallel = Math.max(1, Number(opts.maxParallel) || 1);

  const state = new Map(); // id -> waiting|running|done|failed|blocked|stopped
  for (const t of tasks) state.set(t.id, 'waiting');
  const inflight = new Set();
  const stat = { done: 0, failed: 0, blocked: 0, stopped: 0 };

  return new Promise((resolve) => {
    let settled = false;

    const finish = (stopped) => {
      if (settled) return;
      settled = true;
      send({
        type: 'all_done',
        dag: { total: tasks.length, done: stat.done, failed: stat.failed, blocked: stat.blocked, stopped: stat.stopped }
      });
      resolve({ stopped: !!stopped, ...stat });
    };

    const markBlocked = (t) => {
      state.set(t.id, 'blocked');
      stat.blocked++;
      onTerminal(t.id, 'blocked');
      send({ type: 'notice', content: `⛓「${String(t.title || '').slice(0, 30)}」因前置未完成被阻塞，已跳过`, taskId: t.id });
    };

    const pump = () => {
      if (settled) return;
      // 停止检查：不再启动新任务，等 inflight 收尾
      const stoppedNow = isStopped();
      if (!stoppedNow) {
        // 先做一轮阻塞传播 + 启动（重扫直到无状态变化，保证链式阻塞全部落定）
        let changed = true;
        while (changed) {
          changed = false;
          for (const t of tasks) {
            if (state.get(t.id) !== 'waiting') continue;
            const deps = t.dependsOn || [];
            if (deps.some(id => state.get(id) === 'failed' || state.get(id) === 'blocked')) {
              markBlocked(t);
              changed = true;
            }
          }
        }
        for (const t of tasks) {
          if (inflight.size >= maxParallel) break;
          if (state.get(t.id) !== 'waiting') continue;
          if (!(t.dependsOn || []).every(id => state.get(id) === 'done')) continue;
          state.set(t.id, 'running');
          inflight.add(t.id);
          Promise.resolve()
            .then(() => runOneTask(t))
            .then((r) => {
              const s = r === 'done' || r === 'failed' || r === 'stopped' ? r : 'failed';
              state.set(t.id, s);
              stat[s === 'done' ? 'done' : s === 'failed' ? 'failed' : 'stopped']++;
              inflight.delete(t.id);
              pump(); // 事件驱动：任一完成立即重扫解锁
            })
            .catch(() => {
              state.set(t.id, 'failed');
              stat.failed++;
              inflight.delete(t.id);
              pump();
            });
        }
      }
      // 终止判定：停止后 inflight 清空即结束；正常情况无 inflight 且无 waiting（其余全终态）即结束
      if (inflight.size === 0) {
        if (stoppedNow || isStopped()) return finish(true);
        const hasWaiting = tasks.some(t => state.get(t.id) === 'waiting');
        // hasWaiting 为真但无法启动：理论上不会发生（无环且无 inflight 时 waiting 的依赖必已就绪）；
        // 防御：等待一个 tick 再 pump 一次，仍无进展则强制结束避免挂死
        if (hasWaiting) {
          setImmediate(pump);
          const stillWaiting = () => tasks.some(t => state.get(t.id) === 'waiting');
          setImmediate(() => { if (settled) return; if (stillWaiting() && inflight.size === 0) finish(false); });
          return;
        }
        finish(false);
      }
    };

    pump();
  });
}

module.exports = { runDagBatch, dagMaxParallel };
