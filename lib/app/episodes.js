/**
 * Episode 管理与分层导航（§6 / §8.2 BROAD）。
 *
 * 关闭触发（§6.1 的 5 条，本实现覆盖可用数据支持的 3 条 + 显式强制）：
 *   1. 自 episode 起累计 raw token 达到目标（§6.1-1）；
 *   2. task 切换（raw_events.task_id 变化，§6.1-2）；
 *   3. 长空闲间隔（§6.1-5 的可用代理）；
 *   4. 显式 force（用户明确结束一个阶段，§6.1-3）。
 * 未实现：artifact 稳定版本触发（§6.1-4）——需要 artifact 版本管理，属后续阶段，
 * 此处不假装支持。
 *
 * 分层摘要（§6.4）：meta-summary **只做导航**，且 MUST NOT 无限递归。
 * 故其内容由固定子摘要**确定性抽取**得到（不调用模型、不改写子摘要），
 * 每次重建都是同一结果。
 *
 * @module dsh-contextvm/app/episodes
 */
import { EpisodeStore } from '../storage/episodes.js';
import { summarizeEpisode } from '../memory/summarizer.js';

/** 长空闲视为阶段结束的阈值。 */
const IDLE_GAP_MS = 30 * 60 * 1000;

export class EpisodeManager {
  /**
   * @param {{
   *   raw: import('../storage/raw_events.js').RawEventStore,
   *   db: import('node:sqlite').DatabaseSync,
   *   tokenizer: import('../core/tokenization.js').Tokenizer,
   *   config: object,
   *   llmClient: import('../llm/client.js').LlmClient,
   *   onTelemetry?: (rec: object) => void,
   * }} deps
   */
  constructor(deps) {
    this.raw = deps.raw;
    this.db = deps.db;
    this.episodes = new EpisodeStore(deps.db);
    this.tokenizer = deps.tokenizer;
    this.config = deps.config;
    this.llmClient = deps.llmClient;
    this.onTelemetry = deps.onTelemetry ?? (() => {});
  }

  /**
   * 推进 episode 边界；必要时关闭并（异步）摘要。
   *
   * 分段回填：一次 sync 可能跨越很长的未分段历史（例如维护一直没跑），
   * 因此按目标尺寸**逐段**切分，而不是把整段关成一个巨型 episode
   * ——后者会让单段尺寸突破 §6.1 的上界，摘要保真度随之劣化。
   *
   * @param {{sessionId: string, budgets: object, force?: boolean, signal?: AbortSignal, summarize?: boolean}} req
   * @returns {Promise<{created: string|null, closed: string[], closeReasons: string[], summarized: number, pending: number}>}
   */
  async sync(req) {
    const { sessionId, budgets } = req;
    const all = this.raw.range(sessionId);
    const closedIds = [];
    const closeReasons = [];
    let created = null;

    if (all.length === 0) return { created: null, closed: closedIds, closeReasons, summarized: 0, pending: 0 };

    // 起点：最后一个已关闭 episode 之后
    let cursor = 0;
    const closedExisting = this.episodes.closed(sessionId);
    if (closedExisting.length) {
      const lastEnd = this.raw.get(closedExisting.at(-1).endEventId);
      if (lastEnd) cursor = all.findIndex((e) => e.seq > lastEnd.seq);
      if (cursor < 0) cursor = all.length;
    }

    let open = this.episodes.open(sessionId);
    if (!open && cursor < all.length) {
      open = this.episodes.createOpen({ sessionId, startEventId: all[cursor].eventId });
      created = open.episodeId;
    }
    if (open) {
      const startEv = this.raw.get(open.startEventId);
      if (startEv) {
        const idx = all.findIndex((e) => e.seq >= startEv.seq);
        if (idx >= 0) cursor = idx;
      }
    }

    // 逐段切分。
    // 判定的是"是否在第 i 条处收段"，而空闲/任务切换这类触发看的是
    // 相邻两条的**边界**（i 与 i+1 之间）——否则末尾前的间隔永远不会触发。
    let tokens = 0;
    let segmentStart = cursor;
    for (let i = cursor; i < all.length; i += 1) {
      tokens += all[i].tokenCount ?? 0;
      const hasNext = i + 1 < all.length;
      const reasons = [];

      if (hasNext) {
        const prevT = Date.parse(all[i].createdAt);
        const nextT = Date.parse(all[i + 1].createdAt);
        if (Number.isFinite(prevT) && Number.isFinite(nextT) && nextT - prevT >= IDLE_GAP_MS) {
          reasons.push('idle_gap');
        }
        if ((all[i].taskId ?? null) !== (all[i + 1].taskId ?? null)) reasons.push('task_switch');
      }
      if (tokens >= budgets.episode.targetRaw) reasons.push('token_target');
      if (!hasNext && req.force === true && i > segmentStart) reasons.push('forced');

      if (reasons.length === 0) continue;
      const ep = this.episodes.open(sessionId);
      if (!ep) break;
      this.episodes.close(ep.episodeId, { endEventId: all[i].eventId, rawTokenCount: tokens });
      closedIds.push(ep.episodeId);
      closeReasons.push(reasons[0]);
      this.onTelemetry({
        event: 'episode_closed', session_id: sessionId, episode_id: ep.episodeId,
        reason: reasons[0], raw_tokens: tokens, events: i - segmentStart + 1,
      });
      if (hasNext) this.episodes.createOpen({ sessionId, startEventId: all[i + 1].eventId });
      tokens = 0;
      segmentStart = i + 1;
    }

    let summarized = 0;
    if (req.summarize !== false) {
      const r = await this.summarizePending({ sessionId, budgets, limit: 2, signal: req.signal });
      summarized = r.summarized;
    }
    return {
      created,
      closed: closedIds,
      closeReasons,
      summarized,
      pending: this.episodes.pendingSummaries(sessionId).length,
    };
  }

  /**
   * 处理待摘要的 episode（§22.2 可重试）。
   * @param {{sessionId: string, budgets: object, limit?: number, signal?: AbortSignal}} req
   */
  async summarizePending(req) {
    const pending = this.episodes.pendingSummaries(req.sessionId).slice(0, req.limit ?? 2);
    let summarized = 0;
    const failures = [];
    for (const ep of pending) {
      const res = await summarizeEpisode({
        episode: ep,
        raw: this.raw,
        episodes: this.episodes,
        llmClient: this.llmClient,
        tokenizer: this.tokenizer,
        budgets: req.budgets,
        signal: req.signal,
      });
      if (res.ok) {
        summarized += 1;
        this.onTelemetry({ event: 'episode_summarized', session_id: req.sessionId, episode_id: ep.episodeId });
      } else {
        failures.push({ episodeId: ep.episodeId, reason: res.reason });
        this.onTelemetry({ event: 'episode_summary_failed', session_id: req.sessionId, episode_id: ep.episodeId, reason: res.reason });
      }
    }
    return { summarized, failures };
  }

  /**
   * 生成导航块（§8.2 BROAD 用）。
   *
   * @param {{sessionId: string, tokenBudget: number}} req
   * @returns {{blocks: Array<{episodeId: string, topic: string|null, summary: string}>, meta: Array<object>, tokens: number}}
   */
  navigator(req) {
    const summarized = this.episodes.summarized(req.sessionId);
    const blocks = [];
    let tokens = 0;
    // 最近的 episode 优先（尾部信息与当前任务更相关）
    for (const ep of [...summarized].reverse()) {
      const text = ep.summary ?? '';
      const cost = this.tokenizer.estimate(text);
      if (tokens + cost > req.tokenBudget) break;
      const topic = /^topic:\s*(.+)$/m.exec(text)?.[1] ?? null;
      blocks.push({ episodeId: ep.episodeId, topic, summary: text });
      tokens += cost;
    }
    return { blocks, meta: this.metaSummaries(req.sessionId), tokens };
  }

  /**
   * 分层摘要（§6.4）。确定性抽取，不调用模型、不递归。
   * @param {string} sessionId
   * @returns {Array<{id: string, range: [string, string], digest: string}>}
   */
  metaSummaries(sessionId) {
    const summarized = this.episodes.summarized(sessionId);
    if (summarized.length <= 20) return [];
    const size = this.config.maintenance.meta_summary_group_size;
    const out = [];
    for (let i = 0; i < summarized.length; i += size) {
      const group = summarized.slice(i, i + size);
      const topics = group
        .map((e) => /^topic:\s*(.+)$/m.exec(e.summary ?? '')?.[1])
        .filter(Boolean);
      out.push({
        id: `M${String(out.length + 1).padStart(2, '0')}`,
        range: [group[0].episodeId, group.at(-1).episodeId],
        // 确定性 digest：只列子摘要的 topic，便于导航；不做二次概括以免引入偏差
        digest: topics.length ? topics.join(' / ') : `${group.length} 段（无 topic）`,
      });
    }
    return out;
  }
}
