/**
 * 分块器（§11.1）。
 *
 * 规则：优先在 episode 边界切分；跨 episode 时保留 overlap。
 * overlap 的作用是避免限定条件被切在块外（§11.1），不是为了让 worker 看到更多。
 *
 * @module dsh-contextvm/global_scan/splitter
 */

/**
 * 把会话事件切成扫描块。
 *
 * @param {{
 *   raw: import('../storage/raw_events.js').RawEventStore,
 *   sessionId: string,
 *   tokenTarget: number,
 *   overlapTokens: number,
 *   episodeBoundaries?: Set<number>, // 可作为切点的 seq（episode 末端）
 * }} p
 * @returns {{
 *   chunks: Array<{index: number, startSeq: number, endSeq: number, startEventId: string, endEventId: string, tokens: number, eventIds: string[]}>,
 *   totalTokens: number,
 *   eventCount: number,
 * }}
 */
export function splitIntoChunks(p) {
  const { raw, sessionId, tokenTarget, overlapTokens } = p;
  const boundaries = p.episodeBoundaries ?? new Set();
  const events = raw.range(sessionId);
  if (events.length === 0) return { chunks: [], totalTokens: 0, eventCount: 0 };

  const totalTokens = events.reduce((a, e) => a + (e.tokenCount ?? 0), 0);
  const chunks = [];
  let start = 0;

  while (start < events.length) {
    let end = start;
    let tokens = 0;
    // 尽量吃到目标尺寸
    while (end < events.length && (tokens < tokenTarget || end === start)) {
      tokens += events[end].tokenCount ?? 0;
      end += 1;
    }
    // 若目标点之后不远处有 episode 边界，优先切在边界上（§11.1）
    if (end < events.length) {
      const lookAheadLimit = Math.min(events.length, end + Math.ceil((end - start) * 0.3) + 1);
      for (let j = end; j < lookAheadLimit; j += 1) {
        if (boundaries.has(events[j].seq)) {
          for (let k = end; k <= j; k += 1) tokens += events[k].tokenCount ?? 0;
          end = j + 1;
          break;
        }
      }
    }
    const slice = events.slice(start, end);
    chunks.push({
      index: chunks.length,
      startSeq: slice[0].seq,
      endSeq: slice.at(-1).seq,
      startEventId: slice[0].eventId,
      endEventId: slice.at(-1).eventId,
      tokens: slice.reduce((a, e) => a + (e.tokenCount ?? 0), 0),
      eventIds: slice.map((e) => e.eventId),
    });

    if (end >= events.length) break;
    // overlap：下一块回溯到累计 overlapTokens 处
    let back = end;
    let acc = 0;
    while (back > start + 1 && acc < overlapTokens) {
      back -= 1;
      acc += events[back].tokenCount ?? 0;
    }
    // 防止零前进（单条事件超长时回退到 start 会死循环）
    start = Math.max(back, start + 1);
  }

  return { chunks, totalTokens, eventCount: events.length };
}

/**
 * 校验块集合是否连续覆盖整个目标范围（§11.3）。
 * @param {Array<{startSeq: number, endSeq: number}>} chunks
 * @param {number} firstSeq
 * @param {number} lastSeq
 * @returns {{contiguous: boolean, gaps: Array<{afterSeq: number, beforeSeq: number}>}}
 */
export function verifyChunkContiguity(chunks, firstSeq, lastSeq) {
  const sorted = [...chunks].sort((a, b) => a.startSeq - b.startSeq);
  const gaps = [];
  if (sorted.length === 0) return { contiguous: false, gaps: [{ afterSeq: firstSeq, beforeSeq: lastSeq }] };
  if (sorted[0].startSeq > firstSeq) gaps.push({ afterSeq: firstSeq, beforeSeq: sorted[0].startSeq });
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i].startSeq > sorted[i - 1].endSeq + 1) {
      gaps.push({ afterSeq: sorted[i - 1].endSeq, beforeSeq: sorted[i].startSeq });
    }
  }
  const last = sorted.at(-1).endSeq;
  if (last < lastSeq) gaps.push({ afterSeq: last, beforeSeq: lastSeq });
  return { contiguous: gaps.length === 0, gaps };
}
