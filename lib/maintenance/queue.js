/**
 * 维护队列（§15.2 / §16.3 / §22）。
 *
 * 全部作业都在**非关键路径**：单个作业超时或抛错只记录，绝不阻塞对话。
 * 作业列表是唯一的注册处；增量式扩展（embedding、实体抽取等）在此追加即可，
 * MUST NOT 在别处再写一套"顺手做点维护"的逻辑。
 *
 * @module dsh-contextvm/maintenance/queue
 */

/** 默认作业间隔。 */
export const DEFAULT_INTERVALS = Object.freeze({
  flush_pending_deltas: 0, // 每次机会都试
  summarize_pending_episodes: 60_000,
  audit_state: 10 * 60_000,
  verify_index: 30 * 60_000,
});

export class MaintenanceQueue {
  /**
   * @param {{
   *   name: string,
   *   intervalMs?: number,
   *   run: (ctx: object) => Promise<object>|object,
   * }[]} jobs
   * @param {{now?: () => number, onTelemetry?: (rec: object) => void, jobTimeoutMs?: number}} [opts]
   */
  constructor(jobs, opts = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.onTelemetry = opts.onTelemetry ?? (() => {});
    this.jobTimeoutMs = opts.jobTimeoutMs ?? 8000;
    /** @type {Map<string, {def: object, lastRunAt: number|null, runs: number, failures: number}>} */
    this.state = new Map(jobs.map((j) => [j.name, { def: j, lastRunAt: null, runs: 0, failures: 0 }]));
  }

  /** 列出作业状态。 */
  list() {
    return [...this.state.entries()].map(([name, s]) => ({
      name,
      intervalMs: s.def.intervalMs ?? DEFAULT_INTERVALS[name] ?? 60_000,
      lastRunAt: s.lastRunAt,
      runs: s.runs,
      failures: s.failures,
      due: this._due(name, s),
    }));
  }

  _due(name, s) {
    const interval = s.def.intervalMs ?? DEFAULT_INTERVALS[name] ?? 60_000;
    if (s.lastRunAt === null) return true;
    return this.now() - s.lastRunAt >= interval;
  }

  /**
   * 运行到期作业，受总时间预算约束。
   *
   * @param {object} ctx 传给作业的上下文（sessionId、budgets 等）
   * @param {{maxMs?: number, only?: string[]}} [opts]
   * @returns {Promise<{ran: string[], ok: string[], failed: Array<{name: string, error: string}>, elapsedMs: number, deadlineHit: boolean}>}
   */
  async runDue(ctx, opts = {}) {
    const startedAt = this.now();
    const maxMs = opts.maxMs ?? 2000;
    const ran = [];
    const ok = [];
    const failed = [];
    let deadlineHit = false;

    for (const [name, s] of this.state) {
      if (opts.only && !opts.only.includes(name)) continue;
      if (!this._due(name, s)) continue;
      if (this.now() - startedAt >= maxMs) {
        deadlineHit = true;
        break;
      }
      ran.push(name);
      try {
        await this._withTimeout(s.def.run(ctx), this.jobTimeoutMs);
        s.runs += 1;
        ok.push(name);
      } catch (err) {
        s.failures += 1;
        failed.push({ name, error: String(err?.message ?? err) });
      }
      s.lastRunAt = this.now();
    }

    const result = { ran, ok, failed, elapsedMs: this.now() - startedAt, deadlineHit };
    this.onTelemetry({ event: 'maintenance_run', ...result });
    return result;
  }

  /** 强制运行指定/全部作业（测试与重建场景使用）。 */
  async runAll(ctx, opts = {}) {
    return this.runDue(ctx, { maxMs: opts.maxMs ?? 60_000, only: opts.only });
  }

  _withTimeout(promise, ms) {
    let timer;
    return Promise.race([
      Promise.resolve(promise),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`作业超时（${ms}ms）`)), ms);
        if (timer.unref) timer.unref();
      }),
    ]).finally(() => clearTimeout(timer));
  }
}

/**
 * 构造本插件的标准作业集。
 *
 * 作业从调用上下文取 `runtime`（而不是构造时闭包捕获），
 * 这样队列可以先于 Runtime 构造并被注入，避免"构造后再赋值"的隐式耦合。
 *
 * @param {{
 *   verifyRebuildability: Function,
 *   auditState: Function,
 * }} deps 纯函数依赖（无状态，可先行注入）
 * @returns {MaintenanceQueue}
 */
export function createStandardQueue(deps) {
  const { verifyRebuildability, auditState } = deps;
  const needRuntime = (ctx) => {
    if (!ctx?.runtime) throw new Error('维护作业需要 ctx.runtime');
    return ctx.runtime;
  };
  return new MaintenanceQueue([
    {
      name: 'flush_pending_deltas',
      intervalMs: 0,
      run: async (ctx) => {
        const runtime = needRuntime(ctx);
        const r = await runtime.flushPendingDeltas({ limit: 1 });
        return { sessionId: ctx.sessionId, attempted: r.attempted, remaining: r.remaining };
      },
    },
    {
      name: 'summarize_pending_episodes',
      intervalMs: DEFAULT_INTERVALS.summarize_pending_episodes,
      run: async (ctx) => {
        const runtime = needRuntime(ctx);
        const res = await runtime.syncEpisodes({ sessionId: ctx.sessionId, summarize: true });
        return { pending: res.pending ?? 0, summarized: res.summarized ?? 0 };
      },
    },
    {
      name: 'audit_state',
      intervalMs: DEFAULT_INTERVALS.audit_state,
      run: async (ctx) => {
        const runtime = needRuntime(ctx);
        const res = auditState({
          state: runtime.state, raw: runtime.raw, sessionId: ctx.sessionId, applySafeFixes: true,
        });
        return { findings: res.findings.length, applied: res.applied.length };
      },
    },
    {
      name: 'verify_index',
      intervalMs: DEFAULT_INTERVALS.verify_index,
      run: async (ctx) => {
        const runtime = needRuntime(ctx);
        const v = verifyRebuildability({
          db: runtime.db, lexical: runtime.lexical, sampleSize: 10,
        });
        if (!v.ok) throw new Error(`索引校验未通过：raw=${v.rawCount} fts=${v.ftsCount} misses=${v.misses.join(',')}`);
        return { rawCount: v.rawCount };
      },
    },
  ]);
}
