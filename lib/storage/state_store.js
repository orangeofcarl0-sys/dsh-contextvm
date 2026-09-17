/**
 * State Store —— 权威状态与版本链（§4.2 / §16 / §23）。
 *
 * 语义要点：
 *   - 同一逻辑项由 (session_id, item_type, key) 标识；
 *   - 变更 MUST 产生新版本并把旧版本标为 superseded（superseded_by 指向新版本），
 *     MUST NOT 原地覆盖（§4.2 / §23.5）；
 *   - 无 source 的项 MUST NOT 直接成为 active（§4.2 / §23.2），
 *     只能以 uncertain 落库；
 *   - 物理删除不存在；需要淡出时用 archived 状态。
 *
 * @module dsh-contextvm/storage/state_store
 */
import { nextId } from '../core/ids.js';
import { ITEM_STATUS_SET, ITEM_TYPE_SET } from '../core/enums.js';

const rowToItem = (r) => ({
  stateId: r.state_id,
  sessionId: r.session_id,
  itemType: r.item_type,
  key: r.key,
  value: JSON.parse(r.value_json),
  status: r.status,
  confidence: r.confidence,
  sourceEventIds: JSON.parse(r.source_event_ids_json),
  supersededBy: r.superseded_by,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  version: r.version,
});

/** 这些类型的项必须有 source 才能成为 active（§4.2）。 */
const NEEDS_SOURCE = new Set(['fact', 'decision', 'constraint', 'rejected_option', 'artifact_state']);

export class StateStore {
  /** @param {import('node:sqlite').DatabaseSync} db */
  constructor(db) {
    this.db = db;
  }

  /**
   * 最新版本行（key 为 null 时返回 null：null key 不参与版本链）。
   * @param {string} sessionId
   * @param {string} itemType
   * @param {string|null} key
   * @returns {object|null}
   */
  latest(sessionId, itemType, key) {
    if (key === null || key === undefined) return null;
    const r = this.db
      .prepare(
        `SELECT * FROM state_items WHERE session_id = ? AND item_type = ? AND key = ?
         ORDER BY version DESC LIMIT 1`,
      )
      .get(sessionId, itemType, key);
    return r ? rowToItem(r) : null;
  }

  /**
   * 写入/更新一个状态项。
   *
   * @param {{
   *   sessionId: string, itemType: string, key?: string|null, value: any,
   *   status?: string, confidence?: number|null, sourceEventIds?: string[],
   *   now?: string, expectedVersion?: number
   * }} item
   * @returns {{item: object, superseded: Array<{stateId: string, reason: string}>}}
   */
  upsert(item) {
    if (!item?.sessionId) throw new Error('upsert 需要 sessionId');
    if (!ITEM_TYPE_SET.has(item.itemType)) throw new Error(`upsert 收到未知 item_type: ${item.itemType}`);
    const status = item.status ?? 'active';
    if (!ITEM_STATUS_SET.has(status)) throw new Error(`upsert 收到未知 status: ${status}`);
    const key = item.key ?? null;
    const sources = Array.isArray(item.sourceEventIds) ? [...item.sourceEventIds] : [];
    const now = item.now ?? new Date().toISOString();

    if (status === 'active' && sources.length === 0 && NEEDS_SOURCE.has(item.itemType)) {
      throw new Error(
        `拒绝把无 source 的 ${item.itemType} 标为 active（§4.2/§23.2）：请提供 sourceEventIds，或以 uncertain 落库`,
      );
    }

    const superseded = [];
    const prev = this.latest(item.sessionId, item.itemType, key);

    if (prev && item.expectedVersion !== undefined && prev.version !== item.expectedVersion) {
      throw new Error(
        `版本冲突：期望 v${item.expectedVersion}，实际 v${prev.version}（state_id=${prev.stateId}）；MUST NOT 静默覆盖`,
      );
    }

    // 旧版本让位：标 superseded 而非删除
    if (prev && ['active', 'uncertain'].includes(prev.status)) {
      this.db
        .prepare('UPDATE state_items SET status = ?, superseded_by = ?, updated_at = ? WHERE state_id = ?')
        .run('superseded', '__pending__', now, prev.stateId);
      superseded.push({ stateId: prev.stateId, reason: 'replaced_by_new_version' });
    }

    const version = prev ? prev.version + 1 : 1;
    const stateId = nextId('st');
    this.db
      .prepare(
        `INSERT INTO state_items
         (state_id, session_id, item_type, key, value_json, status, confidence,
          source_event_ids_json, superseded_by, created_at, updated_at, version)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        stateId,
        item.sessionId,
        item.itemType,
        key,
        JSON.stringify(item.value ?? null),
        status,
        item.confidence ?? null,
        JSON.stringify(sources),
        null,
        now,
        now,
        version,
      );

    // 回填旧版本的 superseded_by
    if (superseded.length) {
      this.db
        .prepare('UPDATE state_items SET superseded_by = ? WHERE state_id = ?')
        .run(stateId, superseded[0].stateId);
    }

    return { item: this.get(stateId), superseded };
  }

  /**
   * 改状态（resolve / reject / uncertain / archived）。
   * @param {string} stateId
   * @param {string} status
   * @param {{now?: string}} [opts]
   * @returns {object}
   */
  setStatus(stateId, status, opts = {}) {
    if (!ITEM_STATUS_SET.has(status)) throw new Error(`未知 status: ${status}`);
    const now = opts.now ?? new Date().toISOString();
    const row = this.get(stateId);
    if (!row) throw new Error(`setStatus: state_id 不存在: ${stateId}`);
    this.db.prepare('UPDATE state_items SET status = ?, updated_at = ? WHERE state_id = ?').run(status, now, stateId);
    return this.get(stateId);
  }

  /** 按 id 取。 */
  get(stateId) {
    const r = this.db.prepare('SELECT * FROM state_items WHERE state_id = ?').get(stateId);
    return r ? rowToItem(r) : null;
  }

  /** 会话内指定状态的项。 */
  byStatus(sessionId, status) {
    return this.db
      .prepare('SELECT * FROM state_items WHERE session_id = ? AND status = ? ORDER BY item_type, created_at, state_id')
      .all(sessionId, status)
      .map(rowToItem);
  }

  /** 会话内全部 active 项。 */
  active(sessionId) {
    return this.byStatus(sessionId, 'active');
  }

  /**
   * 某逻辑项的全部版本（旧→新）。
   * @returns {object[]}
   */
  history(sessionId, itemType, key) {
    return this.db
      .prepare(
        `SELECT * FROM state_items WHERE session_id = ? AND item_type = ? AND key = ?
         ORDER BY version`,
      )
      .all(sessionId, itemType, key)
      .map(rowToItem);
  }

  /** 会话内所有项（含历史版本），按类型与版本排序。 */
  all(sessionId) {
    return this.db
      .prepare('SELECT * FROM state_items WHERE session_id = ? ORDER BY item_type, key, version')
      .all(sessionId)
      .map(rowToItem);
  }

  /**
   * 统计。返回固定形状：每个已知状态都存在，缺省为 0
   * （避免调用方拿到 undefined 后在别处补默认值，形成第二套语义）。
   */
  stats(sessionId) {
    const out = { total: 0 };
    for (const s of ITEM_STATUS_SET) out[s] = 0;
    const rows = this.db
      .prepare('SELECT status, COUNT(*) AS n FROM state_items WHERE session_id = ? GROUP BY status')
      .all(sessionId);
    for (const r of rows) {
      if (!(r.status in out)) out[r.status] = 0;
      out[r.status] += r.n;
      out.total += r.n;
    }
    return out;
  }

  /**
   * 统计会话内无 source 的 active 项数量（§24.3 要求 100% 有效 provenance）。
   * @returns {number}
   */
  countWithoutProvenance(sessionId) {
    const rows = this.db
      .prepare("SELECT source_event_ids_json FROM state_items WHERE session_id = ? AND status = 'active'")
      .all(sessionId);
    return rows.filter((r) => JSON.parse(r.source_event_ids_json).length === 0).length;
  }
}
