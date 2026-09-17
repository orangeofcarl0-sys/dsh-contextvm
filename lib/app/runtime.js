/**
 * 运行时编排（§15.1 在线关键路径 / §22.1 故障恢复 / §9.1.1 收缩）。
 *
 * 本模块是"把各层接起来"的唯一处：镜像宿主事件、编译上下文、抽取并应用 delta、
 * 记录容量拒绝后的注入缩放。宿主缝（host/seams.js）只做事件→本模块的薄转发，
 * MUST NOT 在缝里再写一遍流程，否则会出现两套顺序。
 *
 * 关键路径刻意保持短：镜像 + 编译 是同步的；delta 抽取是异步的，
 * 且失败不阻塞回答（§22.1）。
 *
 * @module dsh-contextvm/app/runtime
 */
import { projectStateSummary } from '../memory/projection.js';
import { applyDelta, recentEventIds } from '../memory/delta.js';
import { validateDelta, parseJsonLoose } from '../llm/schemas.js';
import { DELTA_SYSTEM, DELTA_TOOL, deltaUserMessage } from '../llm/prompts.js';
import { deriveBudgets } from './config.js';
import { kvGet, kvSet } from '../storage/sqlite.js';

const PENDING_KEY = 'pending_deltas';

/** 队列硬上限（条）。 */
const PENDING_MAX = 50;
/** 单条 delta 的最大重试次数；超过即丢弃并上报，避免一条坏数据长期占位。 */
const PENDING_MAX_ATTEMPTS = 5;

export class Runtime {
  /**
   * @param {{
   *   db: import('node:sqlite').DatabaseSync,
   *   raw: import('../storage/raw_events.js').RawEventStore,
   *   state: import('../storage/state_store.js').StateStore,
   *   compiler: import('../context/compiler.js').Compiler,
   *   llmClient: import('../llm/client.js').LlmClient,
   *   tokenizer: import('../core/tokenization.js').Tokenizer,
   *   config: object,
   *   onTelemetry?: (rec: object) => void,
   * }} deps
   */
  constructor(deps) {
    this.db = deps.db;
    this.raw = deps.raw;
    this.state = deps.state;
    this.compiler = deps.compiler;
    this.llmClient = deps.llmClient;
    this.tokenizer = deps.tokenizer;
    this.config = deps.config;
    /** @type {import('./episodes.js').EpisodeManager|null} */
    this.episodes = deps.episodes ?? null;
    /** @type {import('../global_scan/scanner.js').GlobalScanner|null} */
    this.scanner = deps.scanner ?? null;
    /** @type {import('../retrieval/hybrid.js').Retriever|null} 语义索引状态的唯一来源 */
    this.retriever = deps.retriever ?? null;
    /** @type {import('../storage/artifacts.js').ArtifactStore|null} */
    this.artifacts = deps.artifacts ?? null;
    /** @type {import('../indexing/lexical.js').LexicalIndex|null} 供维护作业校验索引 */
    this.lexical = deps.lexical ?? null;
    /** @type {import('../maintenance/queue.js').MaintenanceQueue|null} */
    this.maintenance = deps.maintenance ?? null;
    /** @type {Map<string, object>|null} 会话 → 最近一次穷举扫描结果 */
    this.scanState = deps.scanState ?? null;
    this.onTelemetry = deps.onTelemetry ?? (() => {});
    /** @type {Map<string, number>} 会话 → 注入缩放（§9.1.1 容量拒绝后下调） */
    this._injectionScale = new Map();
    /** @type {Map<string, number>} 会话 → 当次路由窗口 W（由宿主缝解析后写入） */
    this._windows = new Map();
  }

  /**
   * 把宿主会话事件镜像进索引（幂等：已存在的事件跳过）。
   * 真相源是宿主 session log；本方法只做索引（§18.3）。
   * @param {string} sessionId
   * @param {Array<object>} events
   * @returns {{added: number, skipped: number}}
   */
  mirror(sessionId, events) {
    let added = 0;
    let skipped = 0;
    for (const e of events) {
      const eventId = e.eventId ?? e.event_id;
      if (eventId && this.raw.has(eventId)) {
        skipped += 1;
        continue;
      }
      this.raw.append({
        sessionId,
        eventId,
        role: e.role,
        eventType: e.eventType ?? e.event_type ?? (e.role === 'user' ? 'user_message' : 'assistant_message'),
        content: e.content,
        threadId: e.threadId ?? e.thread_id ?? null,
        taskId: e.taskId ?? e.task_id ?? null,
        parentEventId: e.parentEventId ?? e.parent_event_id ?? null,
        createdAt: e.createdAt ?? e.created_at,
        metadata: e.metadata,
      });
      added += 1;
    }
    return { added, skipped };
  }

  /** 最近一条用户消息内容（供编译时作 query 用）。 */
  lastUserQuery(sessionId) {
    const rows = this.db
      .prepare("SELECT content FROM raw_events WHERE session_id = ? AND event_type = 'user_message' ORDER BY rowid DESC LIMIT 1")
      .get(sessionId);
    return rows?.content ?? '';
  }

  /**
   * 记录当次路由的物理窗口 W。W 按请求解析，MUST NOT 在启动时固化（§2.1）。
   * @param {string} sessionId
   * @param {number} W
   */
  setWindow(sessionId, W) {
    if (!(Number.isFinite(W) && W > 0)) throw new Error(`setWindow 需要正的 W，收到 ${W}`);
    this._windows.set(sessionId, W);
    return W;
  }

  /**
   * 取该会话当前窗口。未知时抛错，MUST NOT 用默认窗口静默兜底。
   * @param {string} sessionId
   */
  window(sessionId) {
    const W = this._windows.get(sessionId);
    if (!W) throw new Error(`[contextvm] 会话 ${sessionId} 的 W 尚未解析；调用方 MUST 先 setWindow()`);
    return W;
  }

  /**
   * 该会话是否已解析过 W。
   *
   * 用途只有一个：判断待处理 delta 是否还属于"活着的"会话（`/contextvm` 的显示与队列剪枝）。
   * 存在的意义是让调用方**不必**用 try/catch 去试探 `window()` —— 那是把异常当控制流。
   * @param {string} sessionId
   */
  hasWindow(sessionId) {
    return this._windows.has(sessionId);
  }

  /**
   * 语义索引状态（§22.3）。唯一来源是 Retriever 的 semanticState ——
   * 它据实反映"可用 / 未接 / 已降级"，而不是仅凭端口是否存在来声称可用。
   * @returns {{enabled: boolean, status: 'ok'|'disabled'|'degraded', note: string, lastError?: string|null}}
   */
  semanticStatus() {
    const st = this.retriever?.semanticStatus?.() ?? { enabled: false, status: 'disabled', lastError: null };
    const note =
      st.status === 'ok'
        ? '语义索引可用，按 §7.1 权重（0.10）参与打分'
        : st.status === 'degraded'
          ? `语义索引已降级（${st.lastError ?? '未知错误'}）：本轮起按关键词路径工作，权重已自动重归一化（§22.3）`
          : '未接 embedding：已降级为 FTS/BM25 + 摘要 + metadata（§22.3 允许）；关键词检索不受影响';
    return { ...st, note };
  }

  /** 当前注入缩放（1 = 不缩放）。 */
  injectionScale(sessionId) {
    return this._injectionScale.get(sessionId) ?? 1;
  }

  /**
   * 记录一次容量拒绝，并下调该会话的注入缩放（§9.1.1 MUST 自适应收缩）。
   * @param {string} sessionId
   * @returns {number} 下调后的缩放
   */
  shrinkInjection(sessionId) {
    const cur = this.injectionScale(sessionId);
    const next = Math.max(0.15, cur * this.config.ratios.preflight_shrink_factor);
    this._injectionScale.set(sessionId, next);
    this.onTelemetry({ event: 'injection_shrunk', session_id: sessionId, from: cur, to: next });
    return next;
  }

  /**
   * 编译本次要注入的上下文。
   * @param {{sessionId: string, query?: string, taskId?: string|null, requestedMaxTokens?: number, mode?: string}} req
   */
  compile(req) {
    const sessionId = req.sessionId;
    const W = req.W ?? this.window(sessionId);
    const budgets = deriveBudgets(this.config, W);
    const scale = this.injectionScale(sessionId);
    const scaled = scale === 1 ? budgets : scaleBudgets(budgets, scale);
    const ctx = this.compiler.compile({
      sessionId,
      query: req.query ?? this.lastUserQuery(sessionId),
      mode: req.mode,
      taskId: req.taskId ?? null,
      budgets: scaled,
      requestedMaxTokens: req.requestedMaxTokens,
    });
    this.onTelemetry({
      event: 'context_compiled',
      session_id: sessionId,
      mode: ctx.mode,
      token_count: ctx.tokenCount,
      injection_scale: scale,
      evidence_count: ctx.evidenceManifest.length,
    });
    return ctx;
  }

  /**
   * 抽取本轮状态增量并应用（§5.2 / §5.3 / §13.2）。
   *
   * 走工具路径：把 §5.2 的结构作为 function 工具的参数携带（§13.1 的可用增强手段）。
   * 宿主缝不暴露 tool_choice，故提示词里明确要求调用；若模型未调用工具，
   * 退回到"从文本里解析 JSON"这一条同一校验入口，不另写解析器。
   *
   * @param {{sessionId: string, query: string, answer: string, eventIds?: string[], signal?: AbortSignal}} req
   * @returns {Promise<{ok: boolean, applied?: object, rejected?: object[], reason?: string, raw?: string}>}
   */
  async extractDelta(req) {
    const { sessionId, query, answer } = req;
    const eventIds = req.eventIds ?? recentEventIds(this.raw, sessionId, 8);
    const stateSummary = projectStateSummary(this.state, sessionId, {
      tokenizer: this.tokenizer,
      maxTokens: Math.max(200, Math.floor(this.config.ratios.state_hard_max * this.window(sessionId))),
    });
    const messages = deltaUserMessage({ query, answer, stateSummary, eventIds });

    let res;
    try {
      res = await this.llmClient.call({
        purpose: 'state_delta',
        system: DELTA_SYSTEM,
        messages,
        tools: [DELTA_TOOL],
        maxTokens: this.config.output.state_delta_soft_max_tokens,
        temperature: 0,
        signal: req.signal,
      });
    } catch (err) {
      // §22.1：delta 失败 MUST NOT 影响已回答的内容；入队待重试
      this.enqueuePending({ sessionId, query, answer, eventIds, error: String(err.message) });
      return { ok: false, reason: 'llm_call_failed', raw: String(err.message) };
    }

    const fromTool = res.toolCalls.find((t) => t.name === DELTA_TOOL.name);
    const parsed = fromTool ? { value: fromTool.args ?? {}, error: null } : parseJsonLoose(res.text);
    if (!parsed.value) {
      // 只报 "unparseable" 是查不动的：真机上出现过 text 为空、usage/stopReason 皆 null
      // 的响应，光看 reason 无法区分"模型什么都没回"与"回了非 JSON"。带一段样本出去。
      this.onTelemetry({
        event: 'delta_unparseable',
        session_id: sessionId,
        text_chars: res.text.length,
        tool_calls: res.toolCalls.length,
        stop_reason: res.stopReason,
        sample: res.text.slice(0, 160),
      });
      this.enqueuePending({ sessionId, query, answer, eventIds, error: 'unparseable' });
      return { ok: false, reason: 'unparseable_delta', raw: res.text.slice(0, 500) };
    }
    // 校验与应用只有一处实现：工具路径与文本 JSON 路径共用 applySubmittedDelta
    return this.applySubmittedDelta({ sessionId, rawDelta: parsed.value });
  }

  /**
   * 校验并应用一份 delta（§5.3）。工具路径与文本路径的唯一入口。
   * @param {{sessionId: string, rawDelta: any, now?: string}} req
   * @returns {{ok: boolean, applied?: object, rejected?: Array<{reason: string}>, reason?: string}}
   */
  applySubmittedDelta(req) {
    const { sessionId, rawDelta } = req;
    const v = validateDelta(rawDelta);
    if (!v.ok) {
      return { ok: false, reason: 'invalid_delta', rejected: v.errors.map((e) => ({ reason: e, detail: null })) };
    }
    const result = applyDelta({ state: this.state, raw: this.raw, sessionId, delta: v.delta, now: req.now });
    // 落一条 state_delta 事件，使状态变更在 raw 日志中可追溯（§4.1 派生 memory 保留 source 语义）
    if (result.applied.upserts.length || result.applied.superseded.length || result.applied.resolved.length) {
      this.raw.append({
        sessionId,
        role: 'assistant',
        eventType: 'state_delta',
        content: JSON.stringify({
          upserted: result.applied.upserts.map((i) => i.stateId),
          superseded: result.applied.superseded.map((s) => s.stateId),
          resolved: result.applied.resolved.map((r) => r.stateId),
        }),
      });
    }
    this.onTelemetry({
      event: 'delta_applied',
      session_id: sessionId,
      upserts: result.applied.upserts.length,
      superseded: result.applied.superseded.length,
      resolved: result.applied.resolved.length,
      rejected: result.rejected.length,
    });
    return { ok: true, applied: result.applied, rejected: result.rejected };
  }

  /**
   * 轮末调度 delta 抽取（§15.1 非关键路径 / §22.1 先写后做）。
   *
   * 先落一条 pending 记录（写前日志），再异步处理；成功即从队列移除。
   * 这样即使进程在抽取途中退出，delta 也不会静默丢失，且**不阻塞**轮次结束。
   *
   * @param {{sessionId: string, query: string, answer: string, eventIds?: string[]}} req
   */
  scheduleDelta(req) {
    const eventIds = req.eventIds ?? recentEventIds(this.raw, req.sessionId, 8);
    this.enqueuePending({ sessionId: req.sessionId, query: req.query, answer: req.answer, eventIds, error: 'scheduled' });
    // 不 await：§15.2 明确不得阻塞正常回答
    queueMicrotask(() => {
      this.flushPendingDeltas({ limit: 1 }).catch((err) => {
        this.onTelemetry({ event: 'delta_flush_failed', session_id: req.sessionId, error: String(err?.message ?? err) });
      });
    });
  }

  /**
   * 对目标范围做穷举扫描，并把结果缓存在共享 scanState 上（§11 / §21.5）。
   *
   * 由工具或其他入口显式调用；编译期只**读取**缓存，不触发扫描
   * （编译是同步的、且在 system-prompt 装配路径上，绝不能阻塞）。
   *
   * @param {{sessionId: string, query: string, concurrency?: number, complex?: boolean, signal?: AbortSignal}} req
   */
  async exhaustiveScan(req) {
    if (!this.scanner) throw new Error('[contextvm] 未装配 GlobalScanner');
    const budgets = deriveBudgets(this.config, this.window(req.sessionId));
    const result = await this.scanner.scan({
      sessionId: req.sessionId,
      query: req.query,
      budgets,
      concurrency: req.concurrency,
      complex: req.complex,
      signal: req.signal,
    });
    if (this.scanState) {
      this.scanState.set(req.sessionId, { ...result, query: req.query, scannedAt: new Date().toISOString() });
    }
    return result;
  }

  /** 最近一次扫描结果（供编译期注入）。 */
  lastScan(sessionId) {
    return this.scanState?.get(sessionId) ?? null;
  }

  /**
   * 推进 episode 边界并处理待摘要（§6 / §15.2 非关键路径）。
   *
   * 由轮末钩子以 fire-and-forget 方式调用；失败 MUST NOT 影响对话（§22.2）。
   * @param {{sessionId: string, force?: boolean, summarize?: boolean, signal?: AbortSignal}} req
   */
  async syncEpisodes(req) {
    if (!this.episodes) return { skipped: 'no_episode_manager' };
    const budgets = deriveBudgets(this.config, this.window(req.sessionId));
    const res = await this.episodes.sync({
      sessionId: req.sessionId,
      budgets,
      force: req.force === true,
      summarize: req.summarize !== false,
      signal: req.signal,
    });
    this.onTelemetry({
      event: 'episodes_synced',
      session_id: req.sessionId,
      closed: res.closed.length,
      summarized: res.summarized,
      pending: res.pending,
    });
    return res;
  }

  /** 记录待重试的 delta（§22.1：标记 pending，后续 maintenance 重试）。 */
  enqueuePending(entry) {
    const list = kvGet(this.db, PENDING_KEY, []);
    list.push({ ...entry, createdAt: new Date().toISOString(), attempts: 0 });
    if (list.length > PENDING_MAX) {
      // 队列上限是硬边界，但静默丢弃会让"某条 delta 再也没被抽取"变得不可见
      const overflow = list.length - PENDING_MAX;
      const gone = list.slice(0, overflow).map((e) => e.sessionId);
      this.onTelemetry({ event: 'delta_queue_overflow', dropped: overflow, sessions: [...new Set(gone)].slice(0, 5) });
    }
    kvSet(this.db, PENDING_KEY, list.slice(-PENDING_MAX));
    this.onTelemetry({ event: 'delta_pending', session_id: entry.sessionId, reason: entry.error });
  }

  /** 待重试队列快照。 */
  pendingDeltas() {
    return kvGet(this.db, PENDING_KEY, []);
  }

  /**
   * 把队列分成"可处理"与"永久不可处理"两拨。
   *
   * 真机教训：队列是**全局**的（不按会话隔离），进程退出后遗留的条目会在下次运行被取出，
   * 而其会话早已结束 → `window()` 按设计抛错。若照旧处理，队首一条旧条目就会让
   * `flushPendingDeltas` 整体抛出、**连 `kvSet(remain)` 都执行不到**：队列永不推进，
   * 当前会话的 delta 再也没机会抽取。会话已结束（无 W）与重试超限的条目，
   * 都只能丢弃 —— 如实上报，而不是留着它反复失败。
   */
  prunePending() {
    const live = [];
    const gone = [];
    for (const entry of this.pendingDeltas()) {
      const reason = this.hasWindow(entry.sessionId)
        ? (entry.attempts ?? 0) >= PENDING_MAX_ATTEMPTS
          ? 'attempts_exhausted'
          : null
        : 'session_gone';
      if (reason) gone.push({ entry, reason });
      else live.push(entry);
    }
    if (gone.length) {
      this.onTelemetry({
        event: 'delta_pruned',
        count: gone.length,
        sessions: [...new Set(gone.map((g) => g.entry.sessionId))].slice(0, 5),
        reasons: [...new Set(gone.map((g) => g.reason))],
        note: '这些 delta 的会话已结束或重试超限，其 raw 事件仍在库中可检索（§23.7）；仅放弃状态抽取这一步',
      });
      kvSet(this.db, PENDING_KEY, live);
    }
    return { live, gone };
  }

  /**
   * 重试待处理 delta。Phase A 由测试/手动触发；Phase D 的维护队列会周期调用。
   *
   * 每条独立容错：任一条抛错都 MUST NOT 让其余条目停止处理。
   *
   * @param {{limit?: number}} [opts]
   */
  async flushPendingDeltas(opts = {}) {
    const { live, gone } = this.prunePending();
    const limit = opts.limit ?? 5;
    const results = [];
    const remain = [];
    for (const [i, entry] of live.entries()) {
      if (i >= limit) {
        remain.push(entry);
        continue;
      }
      let res;
      try {
        res = await this.extractDelta({
          sessionId: entry.sessionId,
          query: entry.query,
          answer: entry.answer,
          eventIds: entry.eventIds,
        });
      } catch (err) {
        res = { ok: false, reason: 'flush_threw', error: String(err?.message ?? err) };
      }
      results.push({ entry, res });
      if (!res.ok) remain.push({ ...entry, attempts: (entry.attempts ?? 0) + 1, lastError: res.reason });
    }
    kvSet(this.db, PENDING_KEY, remain);
    return { attempted: results.length, remaining: remain.length, pruned: gone.length, results };
  }
}

/**
 * 按缩放系数重算预算。只缩放**输入侧**；输出上限是绝对值，MUST NOT 缩放（§17.1）。
 * @param {object} budgets
 * @param {number} scale
 */
export function scaleBudgets(budgets, scale) {
  const s = (v) => Math.max(1, Math.floor(v * scale));
  return {
    ...budgets,
    normalTargetInput: s(budgets.normalTargetInput),
    heavyTargetInput: s(budgets.heavyTargetInput),
    hardInputCap: s(budgets.hardInputCap),
    chunkTarget: s(budgets.chunkTarget),
    finalBundleTarget: s(budgets.finalBundleTarget),
    components: Object.fromEntries(Object.entries(budgets.components).map(([k, v]) => [k, s(v)])),
  };
}
