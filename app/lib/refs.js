// 参考资料（知识库轻量版）：把用户挂载的路径/URL 清单注入任务与会话 prompt
// - 内核自带读文件/抓网页能力，系统只注入清单与使用指引，不做内容分片检索
// - 上限：单条 500 字符、总 10 条，超限截断并提示（防 prompt 膨胀）
const REF_MAX_LEN = 500;
const REF_MAX_COUNT = 10;

// 清单净化：trim、去空、去重、截断（纯函数）
function normalizeRefs(input) {
  const list = Array.isArray(input) ? input : String(input || '').split('\n');
  const out = [];
  let truncated = false;
  for (const raw of list) {
    const t = String(raw || '').trim();
    if (!t) continue;
    if (out.includes(t)) continue;
    if (out.length >= REF_MAX_COUNT) { truncated = true; break; }
    out.push(t.length > REF_MAX_LEN ? t.slice(0, REF_MAX_LEN) + '…（已截断）' : t);
  }
  if (truncated) out.push(`（参考条目超过上限 ${REF_MAX_COUNT} 条，仅保留前 ${REF_MAX_COUNT} 条）`);
  return out;
}

// 注入块：空清单返回 ''；否则返回带使用指引的编号清单（拼在 prompt 尾部）
function buildRefsBlock(refs) {
  const list = normalizeRefs(refs);
  if (!list.length) return '';
  return '\n\n【参考资料（可直接读取）】\n以下是用户为本次任务挂载的参考路径/链接，需要时请读取文件或抓取网页获取内容：\n'
    + list.map((r, i) => `${i + 1}. ${r}`).join('\n')
    + '\n目录路径请按需选择性读取其中的相关文件；某项资料无法读取时在结果中说明即可，不要凭空编造其内容。';
}

module.exports = { normalizeRefs, buildRefsBlock, REF_MAX_LEN, REF_MAX_COUNT };
