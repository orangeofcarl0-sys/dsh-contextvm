/**
 * GlobalScanner 编排（§11 / §8.3 / §12）。
 *
 * 这是本系统相对普通 RAG 的关键能力：对"全部/无遗漏/查矛盾"类请求做
 * **分块并行穷举扫描**，而不是 top-k 召回后声称完整（§8.3 / §23.3）。
 *
 * 编排纪律：
 *   - 分块连续覆盖整个目标范围；覆盖校验不通过则 MUST NOT 声称完整；
 *   - worker 并发受限（免费额度下并发是廉价的，但不能无限）；
 *   - 单个 worker 失败不掩盖：计入 failedChunks，最终 coverage.complete=false。
 *
 * @module dsh-contextvm/global_scan/scanner
 */
import { splitIntoChunks, verifyChunkContiguity } from './splitter.js';
import { runWorker } from './worker.js';
import { reduceScan } from './reducer.js';

/** 有界并发执行。 */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const width = Math.max(1, Math.min(limit, items.length));
  const runners = Array.from({ length: width }, async () => {
    for (;;) {
      const i = cursor;
      cursor += 1;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(runners);
  return out;
}

export class GlobalScanner {
  /**
   * @param {{
   *   raw: import('../storage/raw_events.js').RawEventStore,
   *   tokenizer: import('../core/tokenization.js').Tokenizer,
   *   llmClient: import('../llm/client.js').LlmClient,
   *   config: object,
   *   episodes?: import('../app/episodes.js').EpisodeManager|null,
   *   onTelemetry?: (rec: object) => void,
   * }} deps
   */
  constructor(deps) {
    this.raw = deps.raw;
    this.tokenizer = deps.tokenizer;
    this.llmClient = deps.llmClient;
    this.config = deps.config;
    this.episodes = deps.episodes ?? null;
    this.onTelemetry = deps.onTelemetry ?? (() => {});
  }

  /**
   * 对目标范围做穷举扫描。
   *
   * @param {{
   *   sessionId: string,
   *   query: string,
   *   budgets: object,
   *   concurrency?: number,
   *   complex?: boolean,
   *   signal?: AbortSignal,
   * }} req
   * @returns {Promise<{
   *   findings: object[], coverage: object, conflicts: object[],
   *   chunks: object[], tokens: {scope: number, workerInput: number, reducerInput: number},
   *   stats: {chunks: number, workersOk: number, workersFailed: number, duplicates: number, concurrency: number, elapsedMs: number},
   * }>}
   */
  async scan(req) {
    const startedAt = Date.now();
    const { sessionId, query, budgets } = req;
    const concurrency = Math.max(1, Math.min(req.concurrency ?? this.config.global_scan.max_concurrency, 16));

    // episode 末端作为优先切点（§11.1）
    const boundaries = new Set();
    if (this.episodes) {
      for (const ep of this.episodes.episodes.closed(sessionId)) {
        const endEv = this.raw.get(ep.endEventId);
        if (endEv) boundaries.add(endEv.seq);
      }
    }

    const split = splitIntoChunks({
      raw: this.raw,
      sessionId,
      tokenTarget: budgets.chunkTarget,
      overlapTokens: budgets.chunkOverlap,
      episodeBoundaries: boundaries,
    });
    if (split.chunks.length === 0) {
      return {
        findings: [],
        coverage: { complete: false, reason: 'no_chunks', chunks: 0, coveredChunks: 0, gaps: [], failedChunks: [], scope: null },
        conflicts: [],
        chunks: [],
        tokens: { scope: 0, workerInput: 0, reducerInput: 0 },
        stats: { chunks: 0, workersOk: 0, workersFailed: 0, duplicates: 0, concurrency, elapsedMs: Date.now() - startedAt },
      };
    }

    const first = this.raw.get(split.chunks[0].startEventId);
    const last = this.raw.get(split.chunks.at(-1).endEventId);
    const scope = { firstSeq: first.seq, lastSeq: last.seq };
    const contiguity = verifyChunkContiguity(split.chunks, scope.firstSeq, scope.lastSeq);

    const workerMax = req.complex
      ? this.config.output.global_worker_output_complex_max_tokens
      : this.config.output.global_worker_output_max_tokens;

    const results = await mapLimit(split.chunks, concurrency, async (chunk) => {
      const r = await runWorker({
        chunk,
        raw: this.raw,
        query,
        llmClient: this.llmClient,
        maxTokens: workerMax,
        signal: req.signal,
      });
      return { chunk, ...r };
    });

    const reduced = reduceScan({ chunks: split.chunks, results, scope });
    const workersOk = results.filter((r) => r.ok).length;
    const workersFailed = results.length - workersOk;

    // 分块本身不连续也 MUST 视为覆盖不完整（§11.3）
    let coverage = reduced.coverage;
    if (!contiguity.contiguous) {
      coverage = {
        ...coverage,
        complete: false,
        reason: 'chunk_gaps',
        chunkGaps: contiguity.gaps,
      };
    }

    const stats = {
      chunks: split.chunks.length,
      workersOk,
      workersFailed,
      duplicates: reduced.duplicates,
      concurrency,
      elapsedMs: Date.now() - startedAt,
    };
    this.onTelemetry({
      event: 'global_scan',
      session_id: sessionId,
      chunks: stats.chunks,
      workers_ok: workersOk,
      workers_failed: workersFailed,
      coverage_complete: coverage.complete,
      findings: reduced.findings.length,
      conflicts: reduced.conflicts.length,
      scope_tokens: split.totalTokens,
      elapsed_ms: stats.elapsedMs,
    });

    return {
      findings: reduced.findings,
      coverage,
      conflicts: reduced.conflicts,
      chunks: split.chunks,
      tokens: {
        scope: split.totalTokens,
        workerInput: split.chunks.reduce((a, c) => a + c.tokens, 0),
        reducerInput: this.tokenizer.estimate(JSON.stringify(reduced.findings)),
      },
      stats,
    };
  }
}
