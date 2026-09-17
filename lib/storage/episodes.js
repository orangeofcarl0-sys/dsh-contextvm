/**
 * Episode Store（§4.3 / §6）。
 *
 * Episode 是**导航单元**，不是事实真相源（§4.3）。因此：
 *   - 关闭与摘要失败 MUST NOT 影响原始事件（§22.2）；
 *   - summary 仅用于导航；正文仍在 raw_events 中；
 *   - status 迁移：open → closed(summary_pending) → summarized；
 *     摘要失败保持 summary_pending 并可重试。
 *
 * @module dsh-contextvm/storage/episodes
 */
import { nextId } from '../core/ids.js';
import { extractTerms } from '../core/text.js';

const rowToEpisode = (r) => ({
  episodeId: r.episode_id,
  sessionId: r.session_id,
  startEventId: r.start_event_id,
  endEventId: r.end_event_id,
  rawTokenCount: r.raw_token_count,
  summary: r.summary,
  summaryTokenCount: r.summary_token_count,
  status: r.status,
  createdAt: r.created_at,
  closedAt: r.closed_at,
});

export class EpisodeStore {
  /** @param {import('node:sqlite').DatabaseSync} db */
  constructor(db) {
    this.db = db;
  }

  /** 当前打开的 episode（每会话最多一个）。 */
  open(sessionId) {
    const r = this.db
      .prepare("SELECT * FROM episodes WHERE session_id = ? AND status = 'open' ORDER BY created_at DESC LIMIT 1")
      .get(sessionId);
    return r ? rowToEpisode(r) : null;
  }

  /** 新建一个打开的 episode。 */
  createOpen({ sessionId, startEventId, now }) {
    const episodeId = nextId('ep');
    this.db
      .prepare(
        `INSERT INTO episodes (episode_id, session_id, start_event_id, end_event_id, raw_token_count,
                               summary, summary_token_count, status, created_at, closed_at)
         VALUES (?,?,?,?,?,NULL,NULL,'open',?,NULL)`,
      )
      .run(episodeId, sessionId, startEventId, startEventId, 0, now ?? new Date().toISOString());
    return this.get(episodeId);
  }

  /** 关闭：落入 endEventId 与累计 token，状态置 summary_pending（§22.2）。 */
  close(episodeId, { endEventId, rawTokenCount, now }) {
    this.db
      .prepare(
        `UPDATE episodes SET end_event_id = ?, raw_token_count = ?, status = 'summary_pending', closed_at = ?
         WHERE episode_id = ? AND status = 'open'`,
      )
      .run(endEventId, rawTokenCount, now ?? new Date().toISOString(), episodeId);
    return this.get(episodeId);
  }

  /** 写入摘要并置 summarized。 */
  setSummary(episodeId, { summary, summaryTokenCount, now }) {
    this.db
      .prepare(
        `UPDATE episodes SET summary = ?, summary_token_count = ?, status = 'summarized'
         WHERE episode_id = ?`,
      )
      .run(summary, summaryTokenCount, episodeId);
    return this.get(episodeId);
  }

  get(episodeId) {
    const r = this.db.prepare('SELECT * FROM episodes WHERE episode_id = ?').get(episodeId);
    return r ? rowToEpisode(r) : null;
  }

  /** 已关闭（含 summary_pending 与 summarized）的 episode，按时间升序。 */
  closed(sessionId, limit) {
    const sql =
      `SELECT * FROM episodes WHERE session_id = ? AND status != 'open' ORDER BY created_at` +
      (limit ? ' LIMIT ?' : '');
    const args = limit ? [sessionId, limit] : [sessionId];
    return this.db.prepare(sql).all(...args).map(rowToEpisode);
  }

  /** 已成功摘要的 episode，按时间升序。 */
  summarized(sessionId, limit) {
    const sql =
      `SELECT * FROM episodes WHERE session_id = ? AND status = 'summarized' ORDER BY created_at` +
      (limit ? ' LIMIT ?' : '');
    const args = limit ? [sessionId, limit] : [sessionId];
    return this.db.prepare(sql).all(...args).map(rowToEpisode);
  }

  /** 摘要待重试的 episode（§22.2）。 */
  pendingSummaries(sessionId) {
    return this.db
      .prepare("SELECT * FROM episodes WHERE session_id = ? AND status = 'summary_pending' ORDER BY created_at")
      .all(sessionId)
      .map(rowToEpisode);
  }

  /**
   * 在**已摘要的 episode** 上做关键词检索（§7.1 的 episode navigation 候选源）。
   *
   * 为什么放在这里而不是 FTS：摘要文本量小（千级），且是派生物，
   * 单独建 FTS 索引需要迁移与同步成本，收益不成比例。用同一套术语抽取
   * （core/text.extractTerms）做子串匹配，命中率与 FTS 在本场景等价。
   *
   * @param {string} sessionId
   * @param {string} query
   * @param {{limit?: number}} [opts]
   * @returns {Array<{episodeId: string, summary: string, score: number, matchedTerms: string[]}>}
   *          score ∈ (0,1]，为命中项占全部可检索项的比例
   */
  searchSummaries(sessionId, query, opts = {}) {
    const terms = extractTerms(query);
    if (terms.length === 0) return [];
    // 注意匹配形式：extractTerms 给 CJK 二元组加了空格（供 FTS 短语匹配用），
    // 而这里是原文子串匹配，必须去掉该空格，否则"温漂"这类词永远匹配不上。
    const needles = terms.map((t) => ({ term: t, needle: t.replace(/\s+/g, '') }));
    const hits = [];
    for (const ep of this.summarized(sessionId)) {
      const hay = ep.summary ?? '';
      if (!hay) continue;
      const matched = needles.filter((n) => hay.includes(n.needle)).map((n) => n.needle);
      if (matched.length === 0) continue;
      hits.push({
        episodeId: ep.episodeId,
        summary: hay,
        score: matched.length / needles.length,
        matchedTerms: matched,
      });
    }
    hits.sort((a, b) => b.score - a.score || (a.episodeId < b.episodeId ? -1 : 1));
    return hits.slice(0, opts.limit ?? 10);
  }

  /** 某 episode 的起止事件 id（供摘要命中时标注原始范围）。 */
  rangeOf(episodeId) {
    const ep = this.get(episodeId);
    return ep ? { startEventId: ep.startEventId, endEventId: ep.endEventId, episodeId } : null;
  }

  /** 某事件落在哪个 episode（供证据回填 episodeId）。 */
  containingEvent(sessionId, seq) {
    const r = this.db
      .prepare(
        `SELECT e.* FROM episodes e
         JOIN raw_events s ON s.event_id = e.start_event_id
         JOIN raw_events t ON t.event_id = e.end_event_id
         WHERE e.session_id = ? AND s.rowid <= ? AND t.rowid >= ?
         ORDER BY e.created_at DESC LIMIT 1`,
      )
      .get(sessionId, seq, seq);
    return r ? rowToEpisode(r) : null;
  }

  /** 统计。 */
  stats(sessionId) {
    const out = { open: 0, summary_pending: 0, summarized: 0, total: 0 };
    for (const r of this.db
      .prepare('SELECT status, COUNT(*) AS n FROM episodes WHERE session_id = ? GROUP BY status')
      .all(sessionId)) {
      out[r.status] = r.n;
      out.total += r.n;
    }
    return out;
  }
}
