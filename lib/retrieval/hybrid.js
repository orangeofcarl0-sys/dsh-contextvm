/**
 * Hybrid 检索与证据打包（§7.1 / §7.2 / §7.3 / §7.4 / §9.4）。
 *
 * 一条规则处理"分量缺失"：权重表固定声明，实际可用分量之外的权重被丢弃后
 * **按剩余权重重新归一化**。Phase A 无 embedding 时 semantic 缺失即走此路径，
 * Phase B 接上 embedding 时只是多一个可用分量，不改接口、不加分支开关。
 *
 * @module dsh-contextvm/retrieval/hybrid
 */
import { expandNeighborhoods } from './neighborhood.js';
import { EXACT_FIRST_PATTERNS } from '../core/enums.js';
import { toMatchExpression } from '../core/text.js';

/**
 * 检索权重（§7.1）。
 *
 * **关键词为主、embedding 为辅**：lexical 权重最高；semantic 降到与其它辅助
 * 分量同级，且在 embedding 不可用时按"缺分量即重归一化"的规则自动退出，
 * 无需开关、无需另一套打分逻辑。
 *
 * `summary` 是替代 embedding 那部分真实价值的**平价手段**：episode 摘要由模型
 * 生成，措辞与原始事件不同，故"用户换了个说法"时往往能命中摘要——这正是向量
 * 检索原本要解决的问题，而摘要本就是本项目已有的派生物。
 */
export const WEIGHTS = Object.freeze({
  lexical: 0.36,
  summary: 0.14,
  recency: 0.12,
  entity_task: 0.12,
  state_priority: 0.1,
  source_authority: 0.06,
  semantic: 0.1,
});

/** §16.1 authority 顺序映射到分值。 */
const ROLE_AUTHORITY = Object.freeze({
  user_message: 1.0,
  system_note: 0.6,
  artifact_created: 0.7,
  artifact_updated: 0.7,
  tool_result: 0.8,
  tool_request: 0.6,
  assistant_message: 0.5,
  state_delta: 0.4,
});

/** 查询是否含 §7.2 的 exact-first 元素。 */
export function hasExactFirst(query) {
  return EXACT_FIRST_PATTERNS.some((re) => re.test(String(query ?? '')));
}

/**
 * 抽出 exact-first 字面量（数字、文件名、标识符、引号原话等），供字面命中加分。
 * @param {string} query
 * @returns {string[]}
 */
export function exactLiterals(query) {
  const s = String(query ?? '');
  const out = new Set();
  for (const re of EXACT_FIRST_PATTERNS) {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    for (const m of s.matchAll(g)) {
      const v = m[0].replace(/^["“”']|["“”']$/g, '').trim();
      if (v.length >= 2) out.add(v);
    }
  }
  return [...out];
}

export class Retriever {
  /**
   * @param {{
   *   db: import('node:sqlite').DatabaseSync,
   *   raw: import('../storage/raw_events.js').RawEventStore,
   *   tokenizer: import('../core/tokenization.js').Tokenizer,
   *   lexical: import('../indexing/lexical.js').LexicalIndex,
   *   state: import('../storage/state_store.js').StateStore,
   *   semantic?: {search: (sessionId: string, query: string, opts?: object) => Array<{eventId: string, relevance: number}>} | null,
   *   episodes?: import('../storage/episodes.js').EpisodeStore | null,
   *   config: object,
   * }} deps
   */
  constructor(deps) {
    this.db = deps.db;
    this.raw = deps.raw;
    this.tokenizer = deps.tokenizer;
    this.lexical = deps.lexical;
    this.state = deps.state;
    this.semantic = deps.semantic ?? null;
    /**
     * 语义索引状态（§22.3）。**据实报告**：embedding 抛错后必须从 ok 变为 degraded，
     * 而不是继续声称可用。
     * @type {{enabled: boolean, status: 'ok'|'disabled'|'degraded', lastError: string|null}}
     */
    this.semanticState = {
      enabled: !!deps.semantic,
      status: deps.semantic ? 'ok' : 'disabled',
      lastError: null,
    };
    this.episodes = deps.episodes ?? null;
    this.config = deps.config;
  }

  /** 语义索引状态（供 Runtime 与遥测读取，唯一来源）。 */
  semanticStatus() {
    return { ...this.semanticState };
  }

  /**
   * 取候选并打分，返回按 score 降序的候选列表。
   * @param {string} sessionId
   * @param {string} query
   * @param {{filters?: {taskId?: string, threadId?: string, roles?: string[]}, limits?: {lexical?: number, merged?: number}}} [opts]
   * @returns {Array<{eventId: string, score: number, components: object, reasons: string[]}>}
   */
  candidates(sessionId, query, opts = {}) {
    const limits = opts.limits ?? {};
    const lexicalTopK = limits.lexical ?? this.config.retrieval.lexical_top_k;
    const mergedTopK = limits.merged ?? this.config.retrieval.merged_top_k;
    const exact = hasExactFirst(query);

    const gathered = this._gatherCandidates({ sessionId, query, lexicalTopK, exact, filters: opts.filters });
    if (gathered.pool.size === 0) return [];

    const scored = [];
    for (const [eventId, comp] of gathered.pool) {
      const scoredItem = this._scoreCandidate({ sessionId, eventId, comp, gathered, exact, filters: opts.filters });
      if (scoredItem) scored.push(scoredItem);
    }
    scored.sort((a, b) => b.score - a.score || (a.eventId < b.eventId ? -1 : 1));
    return scored.slice(0, mergedTopK);
  }

  /**
   * 采集候选池（§7.1）：lexical ∪ semantic ∪ 字面命中 ∪ 摘要命中，
   * 并一次性取出打分所需的事件元数据与 provenance 集合。
   *
   * 与打分分离的原因：采集关心"哪些事件进入候选"，打分关心"它们各值多少分"；
   * 两者的失败模式也不同（前者是检索源不可用，后者是权重缺分量）。
   */
  _gatherCandidates({ sessionId, query, lexicalTopK, exact, filters }) {
    /** @type {Map<string, {lexical?: number, semantic?: number, literal?: boolean}>} */
    const pool = new Map();
    const touch = (id) => {
      if (!pool.has(id)) pool.set(id, {});
      return pool.get(id);
    };

    for (const hit of this.lexical.search(sessionId, query, { limit: lexicalTopK })) {
      touch(hit.eventId).lexical = hit.relevance;
    }

    if (this.semantic) {
      // §22.3：embedding 失败 MUST NOT 影响 lexical 检索。失败即丢弃该分量并标记 degraded，
      // 权重随"缺分量"规则自动重归一化 —— 不需要第二套打分逻辑。
      try {
        for (const hit of this.semantic.search(sessionId, query, { limit: lexicalTopK })) {
          touch(hit.eventId).semantic = hit.relevance;
        }
        this.semanticState = { enabled: true, status: 'ok', lastError: null };
      } catch (err) {
        this.semanticState = { enabled: true, status: 'degraded', lastError: String(err?.message ?? err) };
      }
    }

    // §7.2 exact-first：字面量命中补进候选池
    if (exact) {
      for (const lit of exactLiterals(query)) {
        const rows = this.db
          .prepare('SELECT event_id FROM raw_events WHERE session_id = ? AND instr(content, ?) > 0 LIMIT ?')
          .all(sessionId, lit, lexicalTopK);
        for (const r of rows) touch(r.event_id).literal = true;
      }
    }

    // 摘要命中：给落在相关 episode 内的原始命中加 summary 分量（§7.1 的 episode navigation）
    /** @type {Map<string, number>} episodeId → 命中分 */
    const summaryHits = new Map();
    if (this.episodes) {
      for (const h of this.episodes.searchSummaries(sessionId, query, { limit: 10 })) {
        summaryHits.set(h.episodeId, h.score);
      }
    }

    const seqs = this.db
      .prepare('SELECT event_id, rowid AS seq, role, event_type, task_id, thread_id FROM raw_events WHERE session_id = ?')
      .all(sessionId);
    return {
      pool,
      summaryHits,
      meta: new Map(seqs.map((r) => [r.event_id, r])),
      total: this.raw.count(sessionId),
      minSeq: this._minSeq(sessionId),
      provenance: new Set(this.state.active(sessionId).flatMap((i) => i.sourceEventIds)),
      filters,
    };
  }

  /**
   * 为单个候选计算分数（§7.1 的加权公式 + §7.2 的 exact-first 加成）。
   * @returns {{eventId: string, score: number, components: object, reasons: string[]}|null}
   *          候选不满足过滤器或被元数据缺失排除时返回 null
   */
  _scoreCandidate({ sessionId, eventId, comp, gathered, exact, filters }) {
    const m = gathered.meta.get(eventId);
    if (!m) return null;
    if (filters?.roles && !filters.roles.includes(m.role)) return null;
    if (filters?.taskId && m.task_id !== filters.taskId) return null;
    if (filters?.threadId && m.thread_id !== filters.threadId) return null;

    const taskMatched = (filters?.taskId && m.task_id === filters.taskId) || (filters?.threadId && m.thread_id === filters.threadId);
    const components = {
      lexical: comp.lexical ?? 0,
      semantic: comp.semantic,
      summary: gathered.summaryHits.size ? (gathered.summaryHits.get(this._episodeIdOf(sessionId, m.seq)) ?? 0) : undefined,
      recency: gathered.total > 1 ? 1 - (gathered.total - 1 - (m.seq - gathered.minSeq)) / (gathered.total - 1) : 1,
      entity_task: taskMatched ? 1 : 0,
      state_priority: gathered.provenance.has(eventId) ? 1 : 0,
      source_authority: ROLE_AUTHORITY[m.event_type] ?? 0.5,
    };

    // 权重：缺分量则丢弃并重新归一化（唯一规则）
    const available = Object.entries(WEIGHTS).filter(([k]) => components[k] !== undefined && components[k] !== null);
    const weightSum = available.reduce((a, [, w]) => a + w, 0);
    const boost = exact && comp.literal ? 1.5 : 1; // §7.2 exact-first 命中加成

    let score = 0;
    const reasons = [];
    for (const [k, w] of available) {
      score += (w / weightSum) * components[k] * (k === 'lexical' ? boost : 1);
      if (components[k] > 0) reasons.push(k);
    }
    if (comp.literal) reasons.push('literal');
    return { eventId, score, components, reasons };
  }

  _minSeq(sessionId) {
    const r = this.db.prepare('SELECT MIN(rowid) AS m FROM raw_events WHERE session_id = ?').get(sessionId);
    return r?.m ?? 0;
  }

  /** 某 seq 所属 episode（无摘要索引时返回 null）。 */
  _episodeIdOf(sessionId, seq) {
    if (!this.episodes) return null;
    return this.episodes.containingEvent(sessionId, seq)?.episodeId ?? null;
  }

  /**
   * 检索并打包为证据束（§7.4），含 neighborhood 扩展（§7.3）与去重（§9.4）。
   *
   * @param {string} sessionId
   * @param {string} query
   * @param {{tokenBudget: number, filters?: object, limits?: object}} opts
   * @returns {{bundles: Array<object>, tokens: number, dropped: {dedup: number, budget: number}}}
   */
  retrieve(sessionId, query, opts) {
    const tokenBudget = opts.tokenBudget ?? 0;
    const cands = this.candidates(sessionId, query, opts);

    // 摘要证据：即使原始命中为空也要给出（这正是"换个说法"时唯一的召回路径）。
    // 它被明确标注为导航单元（§6.3 摘要不是真相源），且排在原始证据之后。
    const summaryBundles = this._summaryBundles(sessionId, query, opts);

    if (cands.length === 0 && summaryBundles.length === 0) {
      return { bundles: [], tokens: 0, dropped: { dedup: 0, covered: 0, budget: 0, summary: 0 } };
    }

    const seenHash = new Set();
    const seenEvent = new Set();
    const bundles = [];
    let tokens = 0;
    let dedup = 0;
    let covered = 0;
    let budgetDropped = 0;

    for (const c of cands) {
      const ev = this.raw.get(c.eventId);
      if (!ev) continue;
      // 该命中已被前一条证据的邻域覆盖：整条跳过。
      // 否则过滤邻居后会把片段削成"孤立命中"，违反 §7.3。
      if (seenEvent.has(c.eventId)) {
        covered += 1;
        continue;
      }
      if (seenHash.has(ev.contentHash)) {
        dedup += 1;
        continue;
      }
      const segments = expandNeighborhoods(this.raw, [c.eventId], {
        before: this.config.retrieval.neighborhood_events_before,
        after: this.config.retrieval.neighborhood_events_after,
      });
      const seg = segments[0];
      const events = seg ? seg.events.filter((e) => !seenEvent.has(e.eventId)) : [ev];
      if (events.length === 0) continue;
      const content = events.map((e) => `[${e.eventType}] ${e.content}`).join('\n');
      const cost = this.tokenizer.estimate(content);
      // 预算必须严格落实：放行超额证据会击穿 §9.6 的硬上限。
      // 同时 §7.3 要求不得孤立返回命中，故不采用"只留命中本身"的裁剪，
      // 而是整条跳过并计数，交由上层按 §9.3 的优先级重新分配预算。
      if (tokens + cost > tokenBudget) {
        budgetDropped += 1;
        continue;
      }
      seenHash.add(ev.contentHash);
      for (const e of events) seenEvent.add(e.eventId);
      tokens += cost;
      bundles.push({
        kind: 'raw',
        sourceEventIds: events.map((e) => e.eventId),
        hitEventIds: [c.eventId],
        episodeId: this._episodeIdOf(sessionId, ev.seq),
        content,
        score: Number(c.score.toFixed(6)),
        reason: c.reasons,
        tokenCount: cost,
      });
    }

    // 摘要证据排在原始证据之后：它便宜、且是"换个说法"时的兜底召回，
    // 但 MUST NOT 挤掉可追溯的原始证据（§6.3 摘要不是真相源）。
    let summary = 0;
    for (const b of summaryBundles) {
      if (tokens + b.tokenCount > tokenBudget) {
        summary += 1;
        continue;
      }
      bundles.push(b);
      tokens += b.tokenCount;
    }
    return { bundles, tokens, dropped: { dedup, covered, budget: budgetDropped, summary } };
  }

  /**
   * 由 episode 摘要生成导航证据束（§7.1 的 episode navigation 候选源）。
   * 内容中显式标注这是导航摘要与其原始范围，模型需要精确值时据此再取原始事件。
   * @param {string} sessionId
   * @param {string} query
   * @param {{limits?: object}} opts
   * @returns {Array<object>}
   */
  _summaryBundles(sessionId, query, opts) {
    if (!this.episodes) return [];
    const limit = opts.limits?.summaries ?? 3;
    const out = [];
    for (const hit of this.episodes.searchSummaries(sessionId, query, { limit })) {
      const range = this.episodes.rangeOf(hit.episodeId);
      const header =
        `<episode_summary id=${hit.episodeId}` +
        `${range ? ` range=${range.startEventId}..${range.endEventId}` : ''} matched=${hit.matchedTerms.join(',')}>`;
      const content = `${header}\n${hit.summary}\n</episode_summary>`;
      out.push({
        kind: 'episode_summary',
        sourceEventIds: range ? [range.startEventId, range.endEventId] : [],
        hitEventIds: [],
        episodeId: hit.episodeId,
        content,
        score: Number((hit.score * 0.5).toFixed(6)), // 导航证据分值刻意低于原始命中
        reason: ['episode_summary'],
        tokenCount: this.tokenizer.estimate(content),
      });
    }
    return out;
  }
}

export { toMatchExpression };
