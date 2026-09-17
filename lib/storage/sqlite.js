/**
 * SQLite 连接与版本化迁移（§18 / §23.6）。
 *
 * 使用 Node 内置 `node:sqlite`：实测 Node 24.14.1 提供 SQLite 3.51.2 且
 * FTS5 与 bm25() 均可用，故无需任何原生依赖（§18.1）。
 *
 * @module dsh-contextvm/storage/sqlite
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * 默认库路径：宿主数据目录下的插件自有目录（§18.3 MUST NOT 写入会话存储目录）。
 * @returns {string}
 */
export function defaultDbPath() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'contextvm', 'contextvm.db');
}

/**
 * 迁移列表。MUST 只追加，MUST NOT 修改已发布的条目（§23.6）。
 * @type {ReadonlyArray<{version: number, name: string, sql: string}>}
 */
export const MIGRATIONS = Object.freeze([
  {
    version: 1,
    name: 'phase-a-core',
    sql: `
CREATE TABLE raw_events (
  event_id        TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL,
  thread_id       TEXT,
  task_id         TEXT,
  parent_event_id TEXT,
  role            TEXT NOT NULL,
  event_type      TEXT NOT NULL,
  content         TEXT NOT NULL,
  content_hash    TEXT NOT NULL,
  token_count     INTEGER,
  created_at      TEXT NOT NULL,
  metadata_json   TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_raw_session_time ON raw_events(session_id, created_at, event_id);
CREATE INDEX idx_raw_hash ON raw_events(content_hash);

-- 检索列 search 存归一化文本（见 core/text.js）；event_id/session_id 仅随行携带不参与匹配
CREATE VIRTUAL TABLE raw_fts USING fts5(
  search,
  event_id UNINDEXED,
  session_id UNINDEXED,
  tokenize='unicode61'
);

CREATE TABLE state_items (
  state_id              TEXT PRIMARY KEY,
  session_id            TEXT NOT NULL,
  item_type             TEXT NOT NULL,
  key                   TEXT,
  value_json            TEXT NOT NULL,
  status                TEXT NOT NULL,
  confidence            REAL,
  source_event_ids_json TEXT NOT NULL,
  superseded_by         TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  version               INTEGER NOT NULL
);
CREATE INDEX idx_state_key ON state_items(session_id, item_type, key, version);
CREATE INDEX idx_state_status ON state_items(session_id, status);

CREATE TABLE episodes (
  episode_id          TEXT PRIMARY KEY,
  session_id          TEXT NOT NULL,
  start_event_id      TEXT NOT NULL,
  end_event_id        TEXT NOT NULL,
  raw_token_count     INTEGER NOT NULL,
  summary             TEXT,
  summary_token_count INTEGER,
  status              TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  closed_at           TEXT
);
CREATE INDEX idx_episode_session ON episodes(session_id, created_at);

CREATE TABLE artifacts (
  artifact_id      TEXT PRIMARY KEY,
  session_id       TEXT NOT NULL,
  logical_name     TEXT NOT NULL,
  version          INTEGER NOT NULL,
  uri              TEXT,
  content_hash     TEXT,
  summary          TEXT,
  created_event_id TEXT,
  status           TEXT NOT NULL,
  metadata_json    TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_artifact_name ON artifacts(session_id, logical_name, version);

-- 插件自有 kv：schema 版本之外的运行时标定等（token 估算系数等）
CREATE TABLE kv (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
`,
  },
]);

/**
 * 打开并迁移数据库。父目录不存在时创建。
 * @param {string} [dbPath] 省略或传 ':memory:' 时不落盘
 * @returns {DatabaseSync}
 */
export function openDb(dbPath) {
  const target = dbPath ?? defaultDbPath();
  if (target !== ':memory:') {
    fs.mkdirSync(path.dirname(target), { recursive: true });
  }
  const db = new DatabaseSync(target);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  if (target !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  migrate(db);
  return db;
}

/**
 * 应用未执行的迁移。
 * @param {DatabaseSync} db
 * @returns {number} 应用到的最高版本
 */
export function migrate(db) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  const done = new Set(db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version));
  let max = 0;
  for (const m of MIGRATIONS) {
    if (done.has(m.version)) {
      max = Math.max(max, m.version);
      continue;
    }
    db.exec('BEGIN');
    try {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations(version, name, applied_at) VALUES (?,?,?)').run(
        m.version,
        m.name,
        new Date().toISOString(),
      );
      db.exec('COMMIT');
      max = Math.max(max, m.version);
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`[contextvm] 迁移 v${m.version}(${m.name}) 失败：${err.message}`);
    }
  }
  return max;
}

/** 当前 schema 版本。 */
export function schemaVersion(db) {
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get();
  return row?.v ?? 0;
}

/** 读 kv。 */
export function kvGet(db, key, fallback = null) {
  const row = db.prepare('SELECT v FROM kv WHERE k = ?').get(key);
  if (!row) return fallback;
  try {
    return JSON.parse(row.v);
  } catch {
    return fallback;
  }
}

/** 写 kv（覆盖）。 */
export function kvSet(db, key, value) {
  db.prepare('INSERT INTO kv(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(
    key,
    JSON.stringify(value),
  );
}
