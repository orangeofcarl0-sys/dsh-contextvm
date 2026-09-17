/**
 * Artifact Store（§4.4 / §9.2 的 current artifact / §26 Phase B）。
 *
 * §4.4 的硬要求：代码、文件、报告 MUST 用 artifact + version 管理，
 * MUST NOT 把整个对象永久塞进 state。故本表只存**引用与摘要**，
 * 正文经 uri 或 raw event 取（JIT）。
 *
 * 版本语义与 state_items 一致：同 logical_name 的新版本把旧版本标为
 * superseded，不物理删除（§4.2 的同一原则）。
 *
 * @module dsh-contextvm/storage/artifacts
 */
import { nextId } from '../core/ids.js';

const rowToArtifact = (r) => ({
  artifactId: r.artifact_id,
  sessionId: r.session_id,
  logicalName: r.logical_name,
  version: r.version,
  uri: r.uri,
  contentHash: r.content_hash,
  summary: r.summary,
  createdEventId: r.created_event_id,
  status: r.status,
  metadata: JSON.parse(r.metadata_json),
});

export class ArtifactStore {
  /** @param {import('node:sqlite').DatabaseSync} db */
  constructor(db) {
    this.db = db;
  }

  /**
   * 登记一个新版本。若同 logical_name 已有 active 版本，则把旧版本标为 superseded。
   *
   * @param {{
   *   sessionId: string, logicalName: string, uri?: string|null, contentHash?: string|null,
   *   summary?: string|null, createdEventId?: string|null, metadata?: object, now?: string,
   * }} a
   * @returns {{artifact: object, superseded: string|null}}
   */
  register(a) {
    if (!a?.sessionId) throw new Error('register 需要 sessionId');
    if (!a.logicalName) throw new Error('register 需要 logicalName');
    const now = a.now ?? new Date().toISOString();
    const prev = this.latest(a.sessionId, a.logicalName);
    if (prev && prev.status === 'active') {
      this.db
        .prepare("UPDATE artifacts SET status = 'superseded' WHERE artifact_id = ?")
        .run(prev.artifactId);
    }
    const artifactId = nextId('art');
    const version = prev ? prev.version + 1 : 1;
    this.db
      .prepare(
        `INSERT INTO artifacts
         (artifact_id, session_id, logical_name, version, uri, content_hash, summary,
          created_event_id, status, metadata_json)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        artifactId,
        a.sessionId,
        a.logicalName,
        version,
        a.uri ?? null,
        a.contentHash ?? null,
        a.summary ?? null,
        a.createdEventId ?? null,
        'active',
        JSON.stringify(a.metadata ?? {}),
      );
    return { artifact: this.get(artifactId), superseded: prev?.artifactId ?? null };
  }

  /**
   * 某逻辑名的最新版本（含非 active，便于审计）。
   * @returns {object|null}
   */
  latest(sessionId, logicalName) {
    const r = this.db
      .prepare('SELECT * FROM artifacts WHERE session_id = ? AND logical_name = ? ORDER BY version DESC LIMIT 1')
      .get(sessionId, logicalName);
    return r ? rowToArtifact(r) : null;
  }

  get(artifactId) {
    const r = this.db.prepare('SELECT * FROM artifacts WHERE artifact_id = ?').get(artifactId);
    return r ? rowToArtifact(r) : null;
  }

  /** 会话内全部 active 产物。 */
  active(sessionId) {
    return this.db
      .prepare("SELECT * FROM artifacts WHERE session_id = ? AND status = 'active' ORDER BY logical_name")
      .all(sessionId)
      .map(rowToArtifact);
  }

  /** 某逻辑名的版本链（旧→新）。 */
  history(sessionId, logicalName) {
    return this.db
      .prepare('SELECT * FROM artifacts WHERE session_id = ? AND logical_name = ? ORDER BY version')
      .all(sessionId, logicalName)
      .map(rowToArtifact);
  }

  /** 按逻辑名模糊检索（供 §14 的 search_artifacts）。 */
  search(sessionId, query, limit = 10) {
    return this.db
      .prepare(
        `SELECT * FROM artifacts WHERE session_id = ? AND status = 'active'
         AND (logical_name LIKE ? OR COALESCE(summary,'') LIKE ?)
         ORDER BY logical_name LIMIT ?`,
      )
      .all(sessionId, `%${query}%`, `%${query}%`, limit)
      .map(rowToArtifact);
  }

  stats(sessionId) {
    const out = { active: 0, superseded: 0, total: 0 };
    for (const r of this.db
      .prepare('SELECT status, COUNT(*) AS n FROM artifacts WHERE session_id = ? GROUP BY status')
      .all(sessionId)) {
      out[r.status] = r.n;
      out.total += r.n;
    }
    return out;
  }
}
