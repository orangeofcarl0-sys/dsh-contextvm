/**
 * Context Compiler（§9 / §21.3）。
 *
 * 产物是**两路**而非一路：`renderedSections` 供 system-prompt/assemble，
 * `admittedMessages` 供 agent/pre-step。两路 MUST 由同一次编译产出，
 * MUST NOT 各自独立计算预算（否则会出现两套预算算术）。
 *
 * 本实现只做**增量注入**：把状态、近期原文、检索证据渲染成 system prompt 段落；
 * 不改写历史。历史缩减是另一个显式决定（规范 §21.6），此处不预留半成品开关。
 *
 * 结构：`compile` 只是一条流水线；每个上下文来源由一个 `_collectXxx` 采集器负责
 * （各自的裁剪与降级判定都留在采集器内，便于单独阅读与替换）。采集器之间不相互
 * 调用，全部经返回值汇总到 `_buildItems`。
 *
 * @module dsh-contextvm/context/compiler
 */
import { classify } from './classifier.js';
import { CONTEXT_MODE_SET } from '../core/enums.js';
import { isInjectableContent } from '../core/injectability.js';
import { PRIORITY, packByPriority, componentCaps } from './budget.js';
import { dedupeEvidence, dedupeAgainstState } from './dedup.js';
import {
  SECTION_ORDER,
  OUTPUT_CONTRACT,
  assembleSections,
  renderTask,
  renderStateBlock,
  renderInactiveState,
  renderRecent,
  renderEvidence,
  renderNavigator,
  renderFindings,
  renderCoverage,
  renderArtifacts,
} from './renderer.js';
import { assertCompileFits } from '../app/config.js';

/** §8.3：GLOBAL 未做穷举扫描时 MUST 明确告知，MUST NOT 声称"已检查全部"。 */export const NON_EXHAUSTIVE_NOTICE = [
  '注意：本次并未对全部历史做穷举扫描（该能力尚未接入）。',
  '若用户要求"全部/无遗漏/完整检查"，你必须明确说明当前结论不保证覆盖全部历史，',
  '不得使用"已检查全部""没有遗漏"这类表述。',
].join('\n');

/** §10.2/§8.3：非 active 状态也要进上下文，否则模型会重新推荐已被否决的方案。 */
export const INACTIVE_SECTION_TITLE = 'Rejected / superseded (do not re-propose)';

/** §9.3：这些 item_type 视作 hard constraint（永不因低优先级被先删）。 */
const CONSTRAINT_TYPES = new Set(['constraint']);
/** §9.3：这些 item_type 属"active decisions/facts"档。 */
const DECISION_FACT_TYPES = new Set(['decision', 'fact', 'assumption', 'preference', 'artifact_state', 'plan_step']);

/** 非 active 清单最多列出的条数（再按组件预算裁剪）。 */
const INACTIVE_MAX_ENTRIES = 12;
/** 非 active 清单占 authoritative_state 组件的比例上限。 */
const INACTIVE_BUDGET_SHARE = 0.35;

/**
 * recent verbatim 的扫描倍数：多取一些事件再筛掉非内容事件（宿主托管的上下文快照、
 * 我们自己的记账事件）。实测宿主样板可占镜像内容的 98%，只取 `recent_events` 条
 * 会被它们占满，真实的最近对话反而进不来。
 */
const RECENT_SCAN_FACTOR = 4;

export class Compiler {
  /**
   * @param {{
   *   raw: import('../storage/raw_events.js').RawEventStore,
   *   state: import('../storage/state_store.js').StateStore,
   *   retriever: import('../retrieval/hybrid.js').Retriever,
   *   tokenizer: import('../core/tokenization.js').Tokenizer,
   *   config: object,
   *   episodes?: import('../app/episodes.js').EpisodeManager|null,
   *   artifacts?: import('../storage/artifacts.js').ArtifactStore|null,
   *   scanState?: Map<string, object>|null,
   * }} deps
   */
  constructor(deps) {
    this.raw = deps.raw;
    this.state = deps.state;
    this.retriever = deps.retriever;
    this.tokenizer = deps.tokenizer;
    this.config = deps.config;
    this.episodes = deps.episodes ?? null;
    this.scanState = deps.scanState ?? null;
    this.artifacts = deps.artifacts ?? null;
  }

  /**
   * 编译一次上下文。
   *
   * @param {{
   *   sessionId: string,
   *   query: string,
   *   mode?: 'LOCAL'|'BROAD'|'GLOBAL',
   *   budgets: object,
   *   taskId?: string|null,
   *   retrievalConfidence?: number|null,
   *   requestedMaxTokens?: number,
   * }} req
   * @returns {{
   *   mode: string, modeReasons: string[], renderedSections: object[], admittedMessages: object[],
   *   includedEventIds: string[], includedStateIds: string[], includedEpisodeIds: string[],
   *   includedArtifactIds: string[], tokenCount: number, coverage: object,
   *   evidenceManifest: object[], notes: object
   * }}
   */
  compile(req) {
    const { sessionId, query, budgets } = req;
    const decision = this._classify(req);
    const caps = componentCaps(budgets);
    const notes = { drops: [], degraded: [] };

    const stateGroups = this._collectState(sessionId);
    const evidence = this._collectEvidence({ sessionId, query, caps, active: stateGroups.active, taskId: req.taskId, notes });
    const recent = this._collectRecent({ sessionId, caps, notes });
    const navigator = this._collectNavigator({ sessionId, caps, mode: decision.mode });
    const artifacts = this._collectArtifacts({ sessionId, caps, notes });
    const inactive = this._collectInactive({ sessionId, caps });

    const items = this._buildItems({
      stateGroups, evidence, recent, navigator, artifacts, inactive, taskId: req.taskId ?? null,
    });
    const coverage = this._resolveCoverage({ mode: decision.mode, sessionId, items, notes });

    const packed = packByPriority(items, { budget: budgets.normalTargetInput });
    // §9.3/§10.2：hard constraint 被预算挤掉时必须显式暴露，MUST NOT 静默丢失
    if (packed.dropped.some((d) => d.id === 'constraints')) {
      notes.degraded.push('active_constraints_dropped_by_budget');
    }

    const { renderedSections, tokenCount } = this._render(packed);
    assertCompileFits(budgets, {
      estimatedInput: tokenCount,
      requestedMaxTokens: req.requestedMaxTokens ?? budgets.outputReserve,
    });

    return {
      mode: decision.mode,
      modeReasons: decision.reasons,
      renderedSections,
      // 本实现不改写历史，故为空；字段本身是稳定契约（§21.3）
      admittedMessages: [],
      includedEventIds: [...new Set(packed.included.flatMap((i) => i.eventIds ?? []))],
      includedStateIds: [...new Set(packed.included.flatMap((i) => i.stateIds ?? []))],
      includedEpisodeIds: [...new Set(packed.included.flatMap((i) => i.episodeIds ?? []))],
      includedArtifactIds: [...new Set(packed.included.flatMap((i) => i.artifactIds ?? []))],
      tokenCount,
      coverage,
      evidenceManifest: evidence.manifest,
      notes: { ...notes, packedDropped: packed.dropped, packedTokens: packed.tokens },
    };
  }

  // ---------------------------------------------------------------- 分类

  /** 模式判定。强制 mode 时校验其合法性，避免非法值静默流穿。 */
  _classify(req) {
    if (req.mode === undefined || req.mode === null) {
      return classify(req.query, { retrievalConfidence: req.retrievalConfidence ?? null });
    }
    if (!CONTEXT_MODE_SET.has(req.mode)) {
      throw new Error(`[contextvm] 未知的 context mode: ${req.mode}`);
    }
    return { mode: req.mode, reasons: ['forced'] };
  }

  // ---------------------------------------------------------------- 采集器

  /** §9.3：按优先级档位分组 active 状态。 */
  _collectState(sessionId) {
    const active = this.state.active(sessionId);
    return {
      active,
      constraints: active.filter((i) => CONSTRAINT_TYPES.has(i.itemType)),
      decisionsFacts: active.filter((i) => DECISION_FACT_TYPES.has(i.itemType)),
      goals: active.filter((i) => i.itemType === 'goal'),
      nextActions: active.filter((i) => i.itemType === 'next_action'),
    };
  }

  /** 检索 + 双重去重（§7.4 / §9.4）。 */
  _collectEvidence({ sessionId, query, caps, active, taskId, notes }) {
    const retrieved = this.retriever.retrieve(sessionId, query, {
      tokenBudget: caps.retrieved_evidence,
      filters: taskId ? { taskId } : undefined,
    });
    const contained = dedupeEvidence(retrieved.bundles);
    const vsState = dedupeAgainstState(contained.kept, active);
    const bundles = vsState.kept;
    // 观测：本轮有多少候选因"非内容"（宿主托管的上下文 / 我们自己的记账事件）被排除。
    // 不记的话，"宿主样板又混进证据"这类回归将不可见。
    if (this.retriever.lastExcluded?.nonContent) {
      notes.excludedNonContent = this.retriever.lastExcluded.nonContent;
    }
    notes.drops.push(
      ...contained.dropped.map((d) => ({ ...d, kind: 'evidence' })),
      ...vsState.dropped.map((d) => ({ ...d, kind: 'evidence' })),
      ...(retrieved.dropped.budget ? [{ reason: 'budget_at_retrieval', kind: 'evidence', count: retrieved.dropped.budget }] : []),
    );
    return {
      bundles,
      text: renderEvidence(bundles),
      manifest: bundles.map((b) => ({
        kind: b.kind ?? 'raw',
        sourceEventIds: b.sourceEventIds,
        hitEventIds: b.hitEventIds ?? [],
        // episodeId 由 Retriever 在打包时确定（唯一判定处），此处只透传
        episodeId: b.episodeId ?? null,
        score: b.score,
        reason: b.reason,
        tokenCount: b.tokenCount,
      })),
    };
  }

  /**
   * recent verbatim：从最旧开始裁到组件上限（§10.1 允许丢弃旧低价值内容）。
   *
   * 只注入"对话内容"：宿主托管的上下文（运行时快照 / 技能目录）与我们自己的
   * `state_delta` 记账事件一律排除（§4.1 / §9.2）。它们仍在索引里可追溯、可检索，
   * 只是不作为"最近原文"重复注入 —— 宿主已在自己提示词里发过，实测它们占镜像内容的 98%。
   */
  _collectRecent({ sessionId, caps, notes }) {
    // 多取一些再筛：否则宿主样板会把窗口占满，真实的最近对话反而进不来。
    const wanted = this.config.recent_events;
    const scanned = this.raw.recent(sessionId, wanted * RECENT_SCAN_FACTOR);
    const events = scanned.filter((e) => isInjectableContent(e.eventType, e.metadata)).slice(-wanted);
    const skipped = scanned.length - events.length;
    if (skipped > 0) notes.skippedNonContent = skipped;

    let kept = events;
    let text = renderRecent(kept);
    let tokens = this.tokenizer.estimate(text);
    while (tokens > caps.recent_verbatim && kept.length > 1) {
      kept = kept.slice(1);
      text = renderRecent(kept);
      tokens = this.tokenizer.estimate(text);
    }
    if (tokens > caps.recent_verbatim) {
      notes.degraded.push('recent_verbatim_empty');
      return { events: [], text: '', tokens: 0 };
    }
    return { events: kept, text, tokens };
  }

  /** episode 导航：BROAD 与 GLOBAL 都需要（§8.2 / §8.3）。 */
  _collectNavigator({ sessionId, caps, mode }) {
    if (mode === 'LOCAL' || !this.episodes) return { text: '', episodeIds: [] };
    const nav = this.episodes.navigator({ sessionId, tokenBudget: caps.episode_navigator });
    const metaLines = nav.meta.map((m) => `- ${m.id} [${m.range[0]}..${m.range[1]}]: ${m.digest}`);
    const text = [metaLines.length ? `meta:\n${metaLines.join('\n')}` : '', renderNavigator(nav.blocks)]
      .filter(Boolean)
      .join('\n');
    return { text, episodeIds: nav.blocks.map((b) => b.episodeId) };
  }

  /** 当前产物：只给引用与摘要（§9.5 / §4.4），受组件上限约束。 */
  _collectArtifacts({ sessionId, caps, notes }) {
    if (!this.artifacts) return { text: '', artifactIds: [] };
    const actives = this.artifacts.active(sessionId);
    let text = renderArtifacts(actives);
    while (this.tokenizer.estimate(text) > caps.current_artifact && actives.length > 1) {
      actives.pop();
      text = renderArtifacts(actives);
    }
    if (this.tokenizer.estimate(text) > caps.current_artifact) {
      notes.degraded.push('artifact_section_dropped');
      return { text: '', artifactIds: [] };
    }
    return { text, artifactIds: actives.map((a) => a.artifactId) };
  }

  /**
   * 非 active 状态清单（§8.3 / §10.2）。
   *
   * 为什么必须注入：只给 active 项时，模型看不到"哪些方案已被明确否决"，于是可能
   * 重新推荐 —— §8.3 要求否决项不得重新推荐、§10.2 要求明确否决项不得被移除。
   * 该清单占用 authoritative_state 组件的预算（它是状态，不是新组件），
   * 并按 INACTIVE_BUDGET_SHARE 限幅，避免挤掉 active 约束。
   */
  _collectInactive({ sessionId, caps }) {
    const rejected = this.state.byStatus(sessionId, 'rejected');
    // superseded 只取每个 (itemType,key) 的最新一次：列出全部历史版本没有信息增益
    const latestSuperseded = new Map();
    for (const it of this.state.byStatus(sessionId, 'superseded')) {
      const k = `${it.itemType}|${it.key ?? it.stateId}`;
      const prev = latestSuperseded.get(k);
      if (!prev || it.version > prev.version) latestSuperseded.set(k, it);
    }
    const pool = [...rejected, ...latestSuperseded.values()].slice(0, INACTIVE_MAX_ENTRIES);
    if (pool.length === 0) return { text: '', stateIds: [] };

    const budget = Math.max(120, Math.floor(caps.authoritative_state * INACTIVE_BUDGET_SHARE));
    let kept = pool;
    let text = renderInactiveState(kept);
    while (this.tokenizer.estimate(text) > budget && kept.length > 1) {
      kept = kept.slice(0, -1);
      text = renderInactiveState(kept);
    }
    if (this.tokenizer.estimate(text) > budget) return { text: '', stateIds: [] };
    return { text, stateIds: kept.map((i) => i.stateId) };
  }

  // ---------------------------------------------------------------- 组装

  /** 把各采集器的产物装成待装箱项（优先级取自 §9.3 的固定档位）。 */
  _buildItems({ stateGroups, evidence, recent, navigator, artifacts, inactive, taskId }) {
    const { goals, nextActions, constraints, decisionsFacts } = stateGroups;
    const taskText = renderTask({
      objective: goals.map((g) => (typeof g.value === 'string' ? g.value : JSON.stringify(g.value))).join(' / ') || null,
      nextAction: nextActions.at(-1) ? String(nextActions.at(-1).value) : null,
      taskId,
    });
    // 每段只渲染一次，token 数与内容取自同一结果（避免两次渲染产生不一致）
    const constraintText = renderStateBlock(constraints);
    const decisionText = renderStateBlock(decisionsFacts);
    const est = (t) => this.tokenizer.estimate(t);

    return [
      { id: 'output_contract', priority: PRIORITY.system_protocol, tokenCount: est(OUTPUT_CONTRACT), section: 'output_contract', title: 'Output contract', content: OUTPUT_CONTRACT },
      { id: 'non_exhaustive', priority: PRIORITY.system_protocol, tokenCount: est(NON_EXHAUSTIVE_NOTICE), section: 'output_contract', title: 'Coverage notice', content: NON_EXHAUSTIVE_NOTICE },
      { id: 'constraints', priority: PRIORITY.active_hard_constraint, tokenCount: est(constraintText), section: 'authoritative_state', title: 'Active constraints', content: constraintText, stateIds: constraints.map((i) => i.stateId) },
      { id: 'task', priority: PRIORITY.task_goal_next_action, tokenCount: est(taskText), section: 'current_task', title: 'Current task', content: taskText, stateIds: [...goals, ...nextActions].map((i) => i.stateId) },
      { id: 'recent', priority: PRIORITY.recent_verbatim, tokenCount: recent.tokens, section: 'recent_verbatim', title: 'Recent verbatim', content: recent.text, eventIds: recent.events.map((e) => e.eventId) },
      { id: 'evidence', priority: PRIORITY.primary_evidence, tokenCount: est(evidence.text), section: 'retrieved_evidence', title: 'Retrieved evidence', content: evidence.text },
      { id: 'decisions', priority: PRIORITY.active_decisions_facts, tokenCount: est(decisionText), section: 'authoritative_state', title: 'Active decisions / facts', content: decisionText, stateIds: decisionsFacts.map((i) => i.stateId) },
      { id: 'inactive', priority: PRIORITY.active_decisions_facts, tokenCount: est(inactive.text), section: 'authoritative_state', title: INACTIVE_SECTION_TITLE, content: inactive.text, stateIds: inactive.stateIds },
      { id: 'artifacts', priority: PRIORITY.current_artifact, tokenCount: est(artifacts.text), section: 'current_artifact', title: 'Current artifacts', content: artifacts.text, artifactIds: artifacts.artifactIds },
      { id: 'navigator', priority: PRIORITY.episode_navigator, tokenCount: est(navigator.text), section: 'episode_navigator', title: 'Episode navigator', content: navigator.text, episodeIds: navigator.episodeIds },
    ].filter((i) => i.content && i.content.length > 0);
  }

  /**
   * 覆盖声明（§8.3 / §23.3）：未做穷举扫描时 MUST 明确告知，不得声称完整。
   * GLOBAL 下若已有本会话的扫描结果，则用它替换提示段并据实给出 coverage。
   */
  _resolveCoverage({ mode, sessionId, items, notes }) {
    const scan = mode === 'GLOBAL' ? (this.scanState?.get(sessionId) ?? null) : null;
    const base = {
      complete: false,
      scope: null,
      reason: mode === 'BROAD' ? 'broad_navigation_only' : 'no_exhaustive_scan',
    };
    const idx = items.findIndex((i) => i.id === 'non_exhaustive');
    if (mode !== 'GLOBAL') {
      if (idx >= 0) items.splice(idx, 1);
      return base;
    }
    if (!scan) {
      notes.degraded.push('global_scan_unavailable');
      return base;
    }

    const coverageText = renderCoverage(scan.coverage);
    if (idx >= 0) {
      items[idx] = {
        id: 'scan_coverage',
        priority: PRIORITY.system_protocol,
        tokenCount: this.tokenizer.estimate(coverageText),
        section: 'output_contract',
        title: 'Scan coverage',
        content: coverageText,
      };
    }
    const findingsText = renderFindings(scan.findings, scan.conflicts);
    if (findingsText) {
      items.push({
        id: 'scan_findings',
        priority: PRIORITY.primary_evidence,
        tokenCount: this.tokenizer.estimate(findingsText),
        section: 'retrieved_evidence',
        title: 'Exhaustive scan findings',
        content: findingsText,
        eventIds: [...new Set(scan.findings.flatMap((f) => f.sourceEventIds))],
      });
    }
    const coverage = {
      complete: scan.coverage.complete === true,
      scope: scan.coverage.scope ?? null,
      reason: scan.coverage.complete ? 'exhaustive_scan' : scan.coverage.reason,
    };
    if (!coverage.complete) notes.degraded.push(`scan_incomplete:${coverage.reason}`);
    return coverage;
  }

  /** 按 §9.5 的段落顺序渲染，并统计最终 token 数。 */
  _render(packed) {
    const sectionMap = new Map();
    for (const it of packed.included) {
      const order = SECTION_ORDER[it.section] ?? 999;
      const key = `${order}:${it.section}:${it.title ?? ''}`;
      if (!sectionMap.has(key)) {
        sectionMap.set(key, { id: key, order, title: it.title ?? it.section, content: it.content });
      }
    }
    const renderedSections = assembleSections([...sectionMap.values()]);
    const tokenCount = renderedSections.reduce((a, s) => a + this.tokenizer.estimate(s.content), 0);
    return { renderedSections, tokenCount };
  }
}
