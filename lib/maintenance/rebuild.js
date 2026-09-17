/**
 * 索引重建（§22.4 / §25 的重建工具）。
 *
 * 只要 raw_events 与 artifacts 还在，以下派生物都可重建：
 *   - FTS 检索索引；
 * 其余（episodes summaries、state projection）本身即为派生物，可重跑。
 *
 * @module dsh-contextvm/maintenance/rebuild
 */
import { normalizeSearchText } from '../core/text.js';

/**
 * 重建 FTS 索引。
 * @param {{
 *   db: import('node:sqlite').DatabaseSync,
 *   sessionId?: string|null,
 *   onProgress?: (n: number) => void,
 * }} p
 * @returns {{rebuilt: number}}
 */
export function rebuildSearchIndex(p) {
  const { db } = p;
  const where = p.sessionId ? 'WHERE session_id = ?' : '';
  const rows = p.sessionId
    ? db.prepare(`SELECT event_id, session_id, content FROM raw_events ${where}`).all(p.sessionId)
    : db.prepare('SELECT event_id, session_id, content FROM raw_events').all();

  db.exec('BEGIN');
  try {
    if (p.sessionId) db.prepare('DELETE FROM raw_fts WHERE session_id = ?').run(p.sessionId);
    else db.exec('DELETE FROM raw_fts');
    const ins = db.prepare('INSERT INTO raw_fts(search, event_id, session_id) VALUES (?,?,?)');
    for (const r of rows) ins.run(normalizeSearchText(r.content), r.event_id, r.session_id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw new Error(`[contextvm] FTS 重建失败：${err.message}`);
  }
  if (p.onProgress) p.onProgress(rows.length);
  return { rebuilt: rows.length };
}

/**
 * 校验可重建性：raw 事件数与 FTS 行数一致，且每条事件都能被自身内容检索到。
 * @param {{db: import('node:sqlite').DatabaseSync, sessionId?: string|null, sampleSize?: number, lexical: any}} p
 * @returns {{ok: boolean, rawCount: number, ftsCount: number, sampled: number, misses: string[]}}
 */
export function verifyRebuildability(p) {
  const { db, lexical } = p;
  const rawCount = p.sessionId
    ? db.prepare('SELECT COUNT(*) n FROM raw_events WHERE session_id = ?').get(p.sessionId).n
    : db.prepare('SELECT COUNT(*) n FROM raw_events').get().n;
  const ftsCount = p.sessionId
    ? db.prepare('SELECT COUNT(*) n FROM raw_fts WHERE session_id = ?').get(p.sessionId).n
    : db.prepare('SELECT COUNT(*) n FROM raw_fts').get().n;

  const sampleRows = p.sessionId
    ? db.prepare('SELECT event_id, session_id, content FROM raw_events WHERE session_id = ? ORDER BY rowid LIMIT ?').all(p.sessionId, p.sampleSize ?? 20)
    : db.prepare('SELECT event_id, session_id, content FROM raw_events ORDER BY rowid LIMIT ?').all(p.sampleSize ?? 20);

  const misses = [];
  for (const r of sampleRows) {
    // 用事件内容的前若干字符做自我检索；命中不必然唯一，但必须包含该事件
    const probe = r.content.slice(0, 24);
    if (!probe.trim()) continue;
    const hits = lexical.search(r.session_id, probe, { limit: 20 });
    if (!hits.some((h) => h.eventId === r.event_id)) misses.push(r.event_id);
  }
  return {
    ok: rawCount === ftsCount && misses.length === 0,
    rawCount,
    ftsCount,
    sampled: sampleRows.length,
    misses,
  };
}
