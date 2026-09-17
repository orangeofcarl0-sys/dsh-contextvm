/**
 * Reducer（§11.3 / §23.3）。
 *
 * MUST：
 *   - 验证每个 worker 的 coverage 是否覆盖其被分配的范围；
 *   - 去重 findings；
 *   - 冲突 findings **保留双方 source**（不做多数投票式覆盖）；
 *   - coverage 不完整时禁止声称"已检查全部"。
 *
 * @module dsh-contextvm/global_scan/reducer
 */

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * @param {{
 *   chunks: Array<object>,
 *   results: Array<{chunk: object, ok: boolean, result?: object, reason?: string}>,
 *   scope: {firstSeq: number, lastSeq: number},
 * }} p
 * @returns {{
 *   findings: object[],
 *   coverage: {complete: boolean, reason: string, chunks: number, coveredChunks: number, gaps: object[], failedChunks: object[]},
 *   conflicts: Array<{a: object, b: object, key: string}>,
 *   duplicates: number,
 * }}
 */
export function reduceScan(p) {
  const { chunks, results, scope } = p;
  const gaps = [];
  const failedChunks = [];
  const seen = new Set();
  const findings = [];
  let duplicates = 0;

  for (const r of results) {
    const chunk = r.chunk;
    if (!r.ok || !r.result) {
      failedChunks.push({ chunkIndex: chunk.index, range: [chunk.startEventId, chunk.endEventId], reason: r.reason ?? 'worker_failed' });
      continue;
    }
    const cov = r.result.coverage;
    // worker 自报的覆盖必须与其被分配的范围一致；不一致即视为缺口（§11.3）
    const coversStart = cov.startEvent === chunk.startEventId;
    const coversEnd = cov.endEvent === chunk.endEventId;
    if (!cov.complete || !coversStart || !coversEnd) {
      gaps.push({
        chunkIndex: chunk.index,
        range: [chunk.startEventId, chunk.endEventId],
        reported: [cov.startEvent, cov.endEvent],
        reportedComplete: cov.complete,
      });
    }
    for (const f of r.result.findings) {
      const key = `${norm(f.claim)}|${f.sourceEventIds.join(',')}`;
      if (seen.has(key)) {
        duplicates += 1;
        continue;
      }
      seen.add(key);
      findings.push({
        claim: f.claim,
        sourceEventIds: f.sourceEventIds,
        category: f.category,
        relevance: f.relevance,
        conflictWith: f.conflictWith,
        chunkIndex: chunk.index,
      });
    }
  }

  const coveredChunks = chunks.length - failedChunks.length - gaps.length;
  const complete = chunks.length > 0 && failedChunks.length === 0 && gaps.length === 0;
  const conflicts = detectConflicts(findings);

  return {
    findings,
    coverage: {
      complete,
      reason: complete
        ? 'all_chunks_covered'
        : failedChunks.length
          ? 'worker_failures'
          : gaps.length
            ? 'coverage_gaps'
            : 'no_chunks',
      chunks: chunks.length,
      coveredChunks,
      gaps,
      failedChunks,
      scope,
    },
    conflicts,
    duplicates,
  };
}

/**
 * 冲突检测：同一术语下结论互斥的 findings。**保留双方**，不做多数决。
 * @param {object[]} findings
 * @returns {Array<{a: object, b: object, key: string}>}
 */
export function detectConflicts(findings) {
  const out = [];
  for (let i = 0; i < findings.length; i += 1) {
    for (let j = i + 1; j < findings.length; j += 1) {
      const a = findings[i];
      const b = findings[j];
      // 显式标注的冲突
      if (a.conflictWith?.length || b.conflictWith?.length) {
        out.push({ a, b, key: 'declared' });
        continue;
      }
      // 同类别下的否定式冲突（含"不是/没有/不得"与相反表述）
      if (a.category === b.category && isNegationConflict(a.claim, b.claim)) {
        out.push({ a, b, key: 'negation' });
      }
    }
  }
  return out;
}

/**
 * 否定与情态词表。
 *
 * 冲突判定是**启发式**：只用来把可疑的互相矛盾项标出来供模型/人复核，
 * 双方证据一律保留，绝不据此覆盖任何一方（§11.3）。
 */
const NEG_PATTERNS = [
  /不是/, /没有/, /不得/, /禁止/, /不应/, /不需要/, /不采用/, /不用/, /不要/, /不具备/, /不支持/,
  /未/, /否决/, /放弃/, /取消/,
  /must not/i, /should not/i, /\bnot\b/i, /\bno\b/i, /\bnever\b/i,
];

const MODAL_PATTERNS = [/必须/, /需要/, /应该/, /应当/, /须/, /要/, /must\b/i, /should\b/i, /need\b/i, /required?/i];

/**
 * 仅用于"剥离后比较词干"的停用词。
 * 注意：不得把 /是/ 放进 NEG_PATTERNS —— 它是系动词，不是否定词；
 * 放进否定词表会让"是"与"不是"被当成同向，从而漏掉真正的冲突。
 */
const STOP_PATTERNS = [/是/, /的/, /了/, /\bis\b/i, /\bare\b/i, /\bthe\b/i, /\ba\b/i, /\ban\b/i, /\bof\b/i];

/** 归一化 + 去掉否定/情态/停用词 + 只留字母数字，用于判断"是否是同一命题的正反两方"。 */
function stem(s) {
  let out = norm(s);
  for (const re of [...NEG_PATTERNS, ...MODAL_PATTERNS, ...STOP_PATTERNS]) {
    out = out.replace(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'), '');
  }
  return out.replace(/[^\p{L}\p{N}]/gu, '');
}

function isNegationConflict(a, b) {
  const na = NEG_PATTERNS.some((re) => re.test(a));
  const nb = NEG_PATTERNS.some((re) => re.test(b));
  if (na === nb) return false; // 同向（都肯定或都否定）不算冲突
  const sa = stem(a);
  const sb = stem(b);
  if (!sa || !sb) return false;
  return sa === sb || sa.includes(sb) || sb.includes(sa);
}
