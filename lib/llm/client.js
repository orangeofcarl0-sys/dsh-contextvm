/**
 * LLM 客户端 —— 对宿主端口的唯一封装（§9.1.1 / §9.6 / §13.1 / §17.1）。
 *
 * 职责边界（避免与调用方重复实现）：
 *   - 本模块只负责：发调用、按 purpose 施加输出上限、回灌 token 标定、
 *     识别容量类拒绝并抛出**结构化**错误；
 *   - 收缩后重试由编排方（respond）负责，因为只有它才握有"如何重新编译更小上下文"
 *     的能力。本模块 MUST NOT 自行裁剪消息。
 *
 * @module dsh-contextvm/llm/client
 */
import { detectKind } from '../core/tokenization.js';

/** 容量类拒绝（网关预检）。§9.1.1 MUST 与其它失败区分处理。 */
export class PreflightRejection extends Error {
  /**
   * @param {string} message
   * @param {{gatekeeperTokens: number|null, limit: number|null, raw: string}} info
   */
  constructor(message, info) {
    super(message);
    this.name = 'PreflightRejection';
    this.gatekeeperTokens = info.gatekeeperTokens ?? null;
    this.limit = info.limit ?? null;
    this.raw = info.raw;
  }
}

/** 其它上游失败（网络、5xx、空流等）。 */
export class LlmCallError extends Error {
  constructor(message, info = {}) {
    super(message);
    this.name = 'LlmCallError';
    this.status = info.status ?? null;
    this.retryable = info.retryable ?? false;
    this.raw = info.raw ?? '';
  }
}

const PREFLIGHT_PATTERNS = [
  // OpenRouter 形态
  /maximum context length is (\d+) tokens[\s\S]{0,200}?you requested about (\d+) tokens/i,
  // opencode zen/go 形态
  /Prompt too long: about (\d+) tokens estimated, but the maximum context length is (\d+) tokens/i,
];

/**
 * 从错误文本中解析容量信息。
 * @param {string} text
 * @returns {{gatekeeperTokens: number|null, limit: number|null}|null}
 */
export function parsePreflightError(text) {
  const s = String(text ?? '');
  for (const re of PREFLIGHT_PATTERNS) {
    const m = s.match(re);
    if (!m) continue;
    // 两种形态的捕获组顺序相反，按语义判定
    const a = Number(m[1]);
    const b = Number(m[2]);
    const limit = Math.max(a, b);
    const gatekeeper = Math.min(a, b);
    return { gatekeeperTokens: gatekeeper, limit };
  }
  if (/context length|prompt too long|too many tokens|context_length_exceeded/i.test(s)) {
    return { gatekeeperTokens: null, limit: null };
  }
  return null;
}

export class LlmClient {
  /**
   * @param {{
   *   llm: import('../host/ports.js').LlmPort,
   *   tokenizer: import('../core/tokenization.js').Tokenizer,
   *   config: object,
   *   route: {provider: string, model: string},
   *   onTelemetry?: (rec: object) => void,
   * }} deps
   */
  constructor(deps) {
    this.llm = deps.llm;
    this.tokenizer = deps.tokenizer;
    this.config = deps.config;
    this.route = deps.route;
    this.onTelemetry = deps.onTelemetry ?? (() => {});
    /** @type {Array<{at: string, purpose: string, gatekeeperTokens: number|null, limit: number|null, ourEstimate: number}>} */
    this.preflightLog = [];
  }

  /**
   * 按 purpose 取默认输出上限（§17.1：绝对上限，不随 W 缩放）。
   * @param {string} purpose
   * @returns {number}
   */
  defaultMaxFor(purpose) {
    const o = this.config.output;
    switch (purpose) {
      case 'state_delta':
        return o.state_delta_soft_max_tokens;
      case 'episode_summary':
        // 唯一来源是 episode 段（同一数值也用于摘要正文预算）：
        // 这里曾读 `o.episode_summary_hard_max_tokens` —— output 段根本没这个键，
        // 于是摘要调用的输出上限一直是 undefined（静默用了宿主的默认值）。
        return this.config.episode.summary_hard_max_tokens;
      case 'global_worker':
        return o.global_worker_output_max_tokens;
      default:
        return o.default_max_output_tokens;
    }
  }

  /**
   * 按 purpose 取**硬**上限：override 也 MUST NOT 突破它。无硬上限的 purpose 返回 null。
   *
   * 存在的意义：`maxTokensFor` 此前是 `if (override) return override` —— 任何调用方
   * 传什么就发什么，配置里的 hard_max 字段没有任何消费者（死配置）。上限直接决定
   * 免费慢模型上单次调用的时长，MUST 有一处不可突破的兜底。
   *
   * @param {string} purpose
   * @returns {number|null}
   */
  hardMaxFor(purpose) {
    const o = this.config.output;
    switch (purpose) {
      case 'state_delta':
        return o.state_delta_hard_max_tokens;
      case 'global_worker':
        return o.global_worker_output_complex_max_tokens;
      case 'episode_summary':
        return this.config.episode.summary_hard_max_tokens;
      default:
        return null;
    }
  }

  /**
   * 本次调用实际使用的输出上限 = min(请求值, 该 purpose 的硬上限)。
   * @param {string} purpose
   * @param {number|undefined} override
   * @returns {number}
   */
  maxTokensFor(purpose, override) {
    const wanted = override || this.defaultMaxFor(purpose);
    const hard = this.hardMaxFor(purpose);
    return hard ? Math.min(wanted, hard) : wanted;
  }

  /**
   * 发一次调用。
   *
   * @param {{
   *   purpose: string,
   *   system?: string,
   *   messages: Array<{role: string, content: string}>,
   *   tools?: Array<object>,
   *   maxTokens?: number,
   *   temperature?: number,
   *   signal?: AbortSignal,
   * }} req
   * @returns {Promise<{text: string, toolCalls: Array<object>, usage: object|null, stopReason: string|null, meta: object}>}
   */
  async call(req) {
    const maxTokens = this.maxTokensFor(req.purpose, req.maxTokens);
    const inputChars = (req.system?.length ?? 0) + req.messages.reduce((a, m) => a + String(m.content ?? '').length, 0);
    const inputKind = detectKind((req.system ?? '') + req.messages.map((m) => m.content).join('\n'));
    const ourEstimate = this.tokenizer.estimate((req.system ?? '') + req.messages.map((m) => m.content).join('\n'), { kind: inputKind });
    const startedAt = Date.now();

    let res;
    try {
      res = await this.llm.complete({
        provider: this.route.provider,
        model: this.route.model,
        system: req.system,
        messages: req.messages,
        tools: req.tools,
        maxTokens,
        temperature: req.temperature,
        signal: req.signal,
        purpose: req.purpose,
      });
    } catch (err) {
      const message = String(err?.message ?? err);
      const pf = parsePreflightError(message);
      if (pf) {
        this.preflightLog.push({
          at: new Date().toISOString(),
          purpose: req.purpose,
          gatekeeperTokens: pf.gatekeeperTokens,
          limit: pf.limit,
          ourEstimate,
        });
        throw new PreflightRejection(`容量拒绝：${message.slice(0, 300)}`, { ...pf, raw: message });
      }
      throw new LlmCallError(`调用失败（${req.purpose}）：${message.slice(0, 300)}`, {
        retryable: /timeout|ECONN|5\d\d|provider_unavailable|stream/i.test(message),
        raw: message,
      });
    }

    // §9.6：以 ①（真实 usage）回灌标定。
    // 字段名是端口契约的 snake_case；宿主的 camelCase 已在 host/llm.js 的 toPortUsage 转过。
    const usage = res?.usage ?? null;
    if (usage && Number.isFinite(usage.input_tokens) && usage.input_tokens > 0) {
      try {
        this.tokenizer.recordUsage({ chars: inputChars, actualTokens: usage.input_tokens, kind: inputKind });
      } catch {
        /* 标定失败不影响主流程 */
      }
    }

    this.onTelemetry({
      purpose: req.purpose,
      input_estimate_tokens: ourEstimate,
      input_chars: inputChars,
      output_tokens: usage?.output_tokens ?? null,
      provider_input_tokens: usage?.input_tokens ?? null,
      // 正文为空时，推理用量是唯一的解释线索（输出预算被推理吃掉）
      reasoning_tokens: usage?.reasoning_tokens ?? null,
      latency_ms: Date.now() - startedAt,
      stop_reason: res?.stopReason ?? null,
      max_tokens: maxTokens,
      // 真机上 delta 出现过 "unparseable"，而 usage/stopReason 全 null ——
      // 看不出是"模型什么都没回"还是"回了非 JSON"。带上字符数与流 chunk 数即可区分：
      // text_chars 0 + chunks 0 说明上游压根没送内容（偶发空响应，重试即好）。
      text_chars: String(res?.text ?? '').length,
      chunks: res?.chunks ?? null,
    });

    return {
      text: String(res?.text ?? ''),
      toolCalls: Array.isArray(res?.toolCalls) ? res.toolCalls : [],
      usage,
      stopReason: res?.stopReason ?? null,
      meta: { ourEstimate, inputChars, inputKind, maxTokens },
    };
  }
}
