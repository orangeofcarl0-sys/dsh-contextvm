/**
 * Neighborhood 扩展（§7.3）。
 *
 * 纪律：任何命中的 raw event MUST NOT 被孤立返回。默认扩展到前后各 N 条，
 * 目的不是"多给上下文"，而是避免孤立句子丢失限定条件。
 *
 * @module dsh-contextvm/retrieval/neighborhood
 */

/**
 * 把命中集合扩展为连续片段。
 *
 * @param {import('../storage/raw_events.js').RawEventStore} raw
 * @param {string[]} eventIds 命中事件（无序亦可）
 * @param {{before?: number, after?: number}} [opts]
 * @returns {Array<{startSeq: number, endSeq: number, events: object[], hitEventIds: string[]}>}
 *          按 startSeq 升序、互不重叠的片段
 */
export function expandNeighborhoods(raw, eventIds, opts = {}) {
  const before = opts.before ?? 3;
  const after = opts.after ?? 3;
  if (eventIds.length === 0) return [];

  // 1. 取每个命中的窗口，按 seq 区间合并
  const spans = [];
  for (const hit of eventIds) {
    const n = raw.neighbors(hit, before, after);
    if (!n.self) continue;
    spans.push({ startSeq: n.before[0]?.seq ?? n.self.seq, endSeq: n.after.at(-1)?.seq ?? n.self.seq, hit });
  }
  if (spans.length === 0) return [];
  spans.sort((a, b) => a.startSeq - b.startSeq);

  const merged = [];
  for (const s of spans) {
    const last = merged.at(-1);
    if (last && s.startSeq <= last.endSeq + 1) {
      last.endSeq = Math.max(last.endSeq, s.endSeq);
      last.hitEventIds.push(s.hit);
    } else {
      merged.push({ startSeq: s.startSeq, endSeq: s.endSeq, hitEventIds: [s.hit] });
    }
  }

  // 2. 逐片段取事件（需要 sessionId；所有 span 同会话）
  const sessionRow = raw.db.prepare('SELECT session_id FROM raw_events WHERE event_id = ?').get(eventIds[0]);
  if (!sessionRow) return [];
  return merged.map((m) => ({
    startSeq: m.startSeq,
    endSeq: m.endSeq,
    events: raw.range(sessionRow.session_id, { fromSeq: m.startSeq, toSeq: m.endSeq }),
    hitEventIds: m.hitEventIds,
  }));
}
