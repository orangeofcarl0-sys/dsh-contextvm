/**
 * Lexical 检索 —— FTS5 + bm25（§7.1）。
 *
 * 查询与索引共用 `core/text.js` 的同一归一化函数；本模块不另做转义。
 * bm25 在 FTS5 中越小越好（负值），此处统一转成 [0,1] 的 relevance，越大越相关，
 * 以免上层出现两套"分数方向"。
 *
 * @module dsh-contextvm/indexing/lexical
 */
import { toMatchExpression } from '../core/text.js';

export class LexicalIndex {
  /** @param {import('node:sqlite').DatabaseSync} db */
  constructor(db) {
    this.db = db;
    this._stmt = db.prepare(
      `SELECT f.event_id AS eventId, bm25(raw_fts) AS rank
       FROM raw_fts f
       WHERE raw_fts MATCH ? AND f.session_id = ?
       ORDER BY rank
       LIMIT ?`,
    );
  }

  /**
   * @param {string} sessionId
   * @param {string} query
   * @param {{limit?: number}} [opts]
   * @returns {Array<{eventId: string, relevance: number, rank: number}>} relevance ∈ [0,1]，越大越相关
   */
  search(sessionId, query, opts = {}) {
    const match = toMatchExpression(query);
    if (!match) return [];
    const limit = opts.limit ?? 30;
    let rows;
    try {
      rows = this._stmt.all(match, sessionId, limit);
    } catch (err) {
      // 归一化后仍可能被 bm25 拒绝（极端输入）；此处不吞错，但不让检索失败拖垮整轮
      return [];
    }
    if (rows.length === 0) return [];
    const ranks = rows.map((r) => r.rank);
    const best = Math.min(...ranks); // bm25 越小越好
    const worst = Math.max(...ranks);
    const span = worst - best;
    return rows.map((r, i) => ({
      eventId: r.eventId,
      // 最好者为 1，最差者为 1/(1+span) 的单调压缩，单条结果恒为 1
      relevance: span === 0 ? 1 : 1 - (r.rank - best) / (span + 1),
      rank: i + 1,
    }));
  }

  /**
   * 术语是否在事件内容中出现（精确子串，供 §7.2 exact-first 使用）。
   * @param {string} eventId
   * @param {string} needle
   * @returns {boolean}
   */
  containsLiteral(eventId, needle) {
    const row = this.db.prepare('SELECT content FROM raw_events WHERE event_id = ?').get(eventId);
    if (!row) return false;
    return row.content.includes(needle);
  }
}
