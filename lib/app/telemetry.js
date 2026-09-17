/**
 * 遥测（规范附录 B）。
 *
 * 只记录**真实可得**的字段；不可得的字段留 null 并注明原因，
 * MUST NOT 用估算值顶替实测值（否则报告会说谎）。
 *
 * @module dsh-contextvm/app/telemetry
 */

/** 附录 B 的请求级字段。 */
export const REQUEST_FIELDS = Object.freeze([
  'request_id',
  'session_id',
  'context_mode',
  'input_tokens',
  'output_tokens',
  'ttft_ms',
  'total_latency_ms',
  'decode_tps',
  'retrieval_latency_ms',
  'retrieved_event_count',
  'retrieved_token_count',
  'state_token_count',
  'recent_token_count',
  'artifact_token_count',
  'context_compile_ms',
  'state_delta_tokens',
]);

/** GLOBAL 追加字段（附录 B）。 */
export const GLOBAL_FIELDS = Object.freeze([
  'scan_scope_tokens',
  'chunk_count',
  'max_concurrency',
  'worker_failures',
  'coverage_ratio',
  'reducer_input_tokens',
]);

export class Telemetry {
  /**
   * @param {{capacity?: number, now?: () => number}} [opts]
   */
  constructor(opts = {}) {
    this.capacity = opts.capacity ?? 1000;
    this.now = opts.now ?? (() => Date.now());
    /** @type {object[]} */
    this.records = [];
    /** @type {object[]} */
    this.events = [];
  }

  /**
   * 记录一条请求级记录。缺失字段填 null，不臆造。
   * @param {object} rec
   */
  record(rec) {
    const row = { at: new Date(this.now()).toISOString() };
    for (const f of REQUEST_FIELDS) row[f] = rec[f] ?? null;
    for (const f of GLOBAL_FIELDS) if (f in rec) row[f] = rec[f];
    this.records.push(row);
    if (this.records.length > this.capacity) this.records.shift();
    return row;
  }

  /** 记录一条内部事件（编译、扫描、摘要、delta 等）。 */
  event(rec) {
    const row = { at: new Date(this.now()).toISOString(), ...rec };
    this.events.push(row);
    if (this.events.length > this.capacity) this.events.shift();
    return row;
  }

  /**
   * 汇总报告。
   * @returns {object}
   */
  report() {
    const by = (name) => this.events.filter((e) => e.event === name);
    const num = (arr, k) => arr.map((x) => x[k]).filter((v) => typeof v === 'number');
    const sum = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) : 0);
    const avg = (arr) => (arr.length ? sum(arr) / arr.length : null);
    const max = (arr) => (arr.length ? Math.max(...arr) : null);

    const compiles = by('context_compiled');
    const scans = by('global_scan');
    const episodes = by('episode_closed');
    const deltas = by('delta_applied');
    const pending = by('delta_pending');

    return {
      generated_at: new Date(this.now()).toISOString(),
      requests: this.records.length,
      context: {
        compiles: compiles.length,
        avg_token_count: avg(num(compiles, 'token_count')),
        max_token_count: max(num(compiles, 'token_count')),
        by_mode: compiles.reduce((acc, c) => {
          acc[c.mode] = (acc[c.mode] ?? 0) + 1;
          return acc;
        }, {}),
        injection_shrinks: by('injection_shrunk').length,
      },
      retrieval: {
        avg_evidence_count: avg(num(compiles, 'evidence_count')),
        // §22.3：embedding 不可用时必须可见地标记为降级
        semantic_index_status: (() => {
          const st = by('semantic_index_status').at(-1);
          return st ? { enabled: st.enabled, status: st.status, note: st.note } : { enabled: false, status: 'unknown', note: '未记录' };
        })(),
        strategy: '关键词为主（lexical 0.36 + summary 0.14），embedding 可选（0.10，缺失即重归一化）',
      },
      episodes: {
        closed: episodes.length,
        summarized: by('episode_summarized').length,
        summary_failed: by('episode_summary_failed').length,
        close_reasons: episodes.reduce((acc, e) => {
          acc[e.reason] = (acc[e.reason] ?? 0) + 1;
          return acc;
        }, {}),
      },
      state_delta: {
        applied: deltas.length,
        total_upserts: sum(num(deltas, 'upserts')),
        total_superseded: sum(num(deltas, 'superseded')),
        total_rejected: sum(num(deltas, 'rejected')),
        pending_events: pending.length,
      },
      global_scan: {
        runs: scans.length,
        chunks: sum(num(scans, 'chunks')),
        workers_ok: sum(num(scans, 'workers_ok')),
        workers_failed: sum(num(scans, 'workers_failed')),
        coverage_complete_runs: scans.filter((s) => s.coverage_complete === true).length,
        avg_elapsed_ms: avg(num(scans, 'elapsed_ms')),
        scope_tokens: sum(num(scans, 'scope_tokens')),
      },
      maintenance: {
        runs: by('maintenance_run').length,
        jobs_ok: sum(by('maintenance_run').flatMap((r) => (r.ok ?? []).map(() => 1))),
        jobs_failed: sum(by('maintenance_run').flatMap((r) => (r.failed ?? []).map(() => 1))),
      },
      notes: [
        'ttft_ms / decode_tps 仅在适配器能观测到流式时序时才有值，宿主 port 未提供时为 null。',
        'artifact_token_count 在未接入 artifact 版本管理前恒为 null。',
      ],
    };
  }

  /** 清空。 */
  reset() {
    this.records = [];
    this.events = [];
  }
}
