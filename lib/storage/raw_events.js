/**
 * Raw Event Store —— 追加日志的索引副本（§4.1 / §18.3）。
 *
 * 真相源是宿主 session log；本表是可重建的检索索引。纪律：
 *   - MUST 只追加，MUST NOT 原地修改或删除内容（§23.7）；
 *   - 同内容可经 content_hash 检测重复，但 event 语义记录不得丢失（§4.1）；
 *   - 需要修正时写入新的 correction event，而不是改旧行。
 *
 * @module dsh-contextvm/storage/raw_events
 */
import { nextId, contentHash } from '../core/ids.js';
import { EVENT_TYPE_SET } from '../core/enums.js';
import { normalizeSearchText } from '../core/text.js';

const rowToEvent = (r) => ({
  seq: r.seq,
  eventId: r.event_id,
  sessionId: r.session_id,
  threadId: r.thread_id,
  taskId: r.task_id,
  parentEventId: r.parent_event_id,
  role: r.role,
  eventType: r.event_type,
  content: r.content,
  contentHash: r.content_hash,
  tokenCount: r.token_count,
  createdAt: r.created_at,
  metadata: JSON.parse(r.metadata_json),
});

export class RawEventStore {
  /**
   * @param {import('node:sqlite').DatabaseSync} db
   * @param {import('../core/tokenization.js').Tokenizer} tokenizer
   */
  constructor(db, tokenizer) {
    this.db = db;
    this.tokenizer = tokenizer;
  }

  /**
   * 批量追加。**在单个事务内提交**：逐条隐式事务在百万 token 语料下
   * （数千条事件）会慢一个数量级，而 §24.2 的验收正是这个量级。
   * 事务失败即整体回滚，不会留下半截日志。
   *
   * @param {Array<object>} events
   * @returns {object[]}
   */
  appendAll(events) {
    if (!Array.isArray(events) || events.length === 0) return [];
    const insertEvent = this.db.prepare(
      `INSERT INTO raw_events
       (event_id, session_id, thread_id, task_id, parent_event_id, role, event_type,
        content, content_hash, token_count, created_at, metadata_json)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    const insertFts = this.db.prepare('INSERT INTO raw_fts(search, event_id, session_id) VALUES (?,?,?)');
    const prepared = events.map((e) => this._prepare(e));

    this.db.exec('BEGIN');
    try {
      for (const p of prepared) {
        insertEvent.run(
          p.eventId, p.sessionId, p.threadId, p.taskId, p.parentEventId, p.role, p.eventType,
          p.content, p.hash, p.tokenCount, p.createdAt, JSON.stringify(p.metadata),
        );
        insertFts.run(p.search, p.eventId, p.sessionId);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw new Error(`[contextvm] 批量追加失败（已回滚）：${err.message}`);
    }
    return this.getMany(prepared.map((p) => p.eventId));
  }

  /** 校验并规范化一条待写入事件（append 与 appendAll 共用，MUST NOT 各写一份）。 */
  _prepare(e) {
    if (!e?.sessionId) throw new Error('append 需要 sessionId');
    if (!e.role) throw new Error('append 需要 role');
    if (!EVENT_TYPE_SET.has(e.eventType)) {
      throw new Error(`append 收到未知 event_type: ${e.eventType}`);
    }
    const content = String(e.content ?? '');
    return {
      eventId: e.eventId ?? nextId('evt'),
      sessionId: e.sessionId,
      threadId: e.threadId ?? null,
      taskId: e.taskId ?? null,
      parentEventId: e.parentEventId ?? null,
      role: e.role,
      eventType: e.eventType,
      content,
      hash: contentHash(content),
      tokenCount: e.tokenCount ?? this.tokenizer.estimate(content),
      createdAt: e.createdAt ?? new Date().toISOString(),
      metadata: e.metadata ?? {},
      search: normalizeSearchText(content),
    };
  }

  /**
   * 追加一条事件。
   * @param {{
   *   sessionId: string, role: string, eventType: string, content: string,
   *   eventId?: string, threadId?: string, taskId?: string, parentEventId?: string,
   *   createdAt?: string, metadata?: object, tokenCount?: number|null
   * }} e
   * @returns {object} 落库后的事件记录
   */
  append(e) {
    const p = this._prepare(e);
    this.db
      .prepare(
        `INSERT INTO raw_events
         (event_id, session_id, thread_id, task_id, parent_event_id, role, event_type,
          content, content_hash, token_count, created_at, metadata_json)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        p.eventId, p.sessionId, p.threadId, p.taskId, p.parentEventId, p.role, p.eventType,
        p.content, p.hash, p.tokenCount, p.createdAt, JSON.stringify(p.metadata),
      );
    this.db
      .prepare('INSERT INTO raw_fts(search, event_id, session_id) VALUES (?,?,?)')
      .run(p.search, p.eventId, p.sessionId);

    return this.get(p.eventId);
  }

  /**
   * 按 id 取事件。
   * @param {string} eventId
   * @returns {object|null}
   */
  get(eventId) {
    const r = this.db
      .prepare('SELECT rowid AS seq, * FROM raw_events WHERE event_id = ?')
      .get(eventId);
    return r ? rowToEvent(r) : null;
  }

  /** 是否存在。 */
  has(eventId) {
    return !!this.db.prepare('SELECT 1 FROM raw_events WHERE event_id = ?').get(eventId);
  }

  /** 批量取，保持入参顺序，缺失项为 null。 */
  getMany(eventIds) {
    const stmt = this.db.prepare('SELECT rowid AS seq, * FROM raw_events WHERE event_id = ?');
    return eventIds.map((id) => {
      const r = stmt.get(id);
      return r ? rowToEvent(r) : null;
    });
  }

  /**
   * 会话内的插入顺序切片（含端点）。
   * @param {string} sessionId
   * @param {{fromSeq?: number, toSeq?: number, limit?: number}} [opts]
   * @returns {object[]}
   */
  range(sessionId, opts = {}) {
    const clauses = ['session_id = ?'];
    const args = [sessionId];
    if (opts.fromSeq !== undefined) {
      clauses.push('rowid >= ?');
      args.push(opts.fromSeq);
    }
    if (opts.toSeq !== undefined) {
      clauses.push('rowid <= ?');
      args.push(opts.toSeq);
    }
    let sql = `SELECT rowid AS seq, * FROM raw_events WHERE ${clauses.join(' AND ')} ORDER BY rowid`;
    if (opts.limit !== undefined) {
      sql += ' LIMIT ?';
      args.push(opts.limit);
    }
    return this.db.prepare(sql).all(...args).map(rowToEvent);
  }

  /**
   * 最近 n 条（按插入顺序返回）。
   * @param {string} sessionId
   * @param {number} n
   * @returns {object[]}
   */
  recent(sessionId, n) {
    if (!(n > 0)) return [];
    const rows = this.db
      .prepare('SELECT rowid AS seq, * FROM raw_events WHERE session_id = ? ORDER BY rowid DESC LIMIT ?')
      .all(sessionId, n);
    return rows.reverse().map(rowToEvent);
  }

  /** 会话事件总数。 */
  count(sessionId) {
    return this.db.prepare('SELECT COUNT(*) AS n FROM raw_events WHERE session_id = ?').get(sessionId).n;
  }

  /** 会话内事件的 token 合计（按存储的 token_count）。 */
  totalTokens(sessionId) {
    const r = this.db
      .prepare('SELECT COALESCE(SUM(token_count),0) AS n FROM raw_events WHERE session_id = ?')
      .get(sessionId);
    return r.n;
  }

  /**
   * 内容哈希去重检测；返回同哈希的既有事件（不含自身）。
   * @param {string} sessionId
   * @param {string} content
   * @param {string} [exceptEventId]
   * @returns {object[]}
   */
  findDuplicates(sessionId, content, exceptEventId) {
    const hash = contentHash(String(content));
    return this.db
      .prepare('SELECT rowid AS seq, * FROM raw_events WHERE session_id = ? AND content_hash = ? AND event_id != ? ORDER BY rowid')
      .all(sessionId, hash, exceptEventId ?? '')
      .map(rowToEvent);
  }

  /** 指定事件的前后邻居（§7.3 neighborhood expansion 用）。 */
  neighbors(eventId, before, after) {
    const self = this.db.prepare('SELECT rowid AS seq, session_id FROM raw_events WHERE event_id = ?').get(eventId);
    if (!self) return { before: [], self: null, after: [] };
    const b = this.db
      .prepare('SELECT rowid AS seq, * FROM raw_events WHERE session_id = ? AND rowid < ? ORDER BY rowid DESC LIMIT ?')
      .all(self.session_id, self.seq, before)
      .reverse()
      .map(rowToEvent);
    const a = this.db
      .prepare('SELECT rowid AS seq, * FROM raw_events WHERE session_id = ? AND rowid > ? ORDER BY rowid LIMIT ?')
      .all(self.session_id, self.seq, after)
      .map(rowToEvent);
    return { before: b, self: this.get(eventId), after: a };
  }
}
