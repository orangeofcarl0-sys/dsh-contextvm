/**
 * 宿主端口（port）定义 —— 本插件与宿主之间的**唯一**接缝。
 *
 * 全部外部能力都经这里注入；测试用假实现，生产用 lib/host/seams.js 的适配器。
 * MUST NOT 在别处直接触碰宿主 API，也 MUST NOT 为"宿主版本差异"再开第二套接口
 * （若宿主能力缺失，实现方在适配器内降级并如实上报，而不是改这里的签名）。
 *
 * @module dsh-contextvm/host/ports
 */

/**
 * 模型调用端口。
 *
 * 宿主侧 `llm.stream()` 是流式的；适配器负责消费流并聚合成一个结果，
 * 因此本端口对外只有一个非流式方法，调用方无需区分两种形态。
 *
 * @typedef {object} LlmPort
 * @property {(req: {
 *   provider: string,
 *   model: string,
 *   system?: string,
 *   messages: Array<{role: 'user'|'assistant', content: string}>,
 *   tools?: Array<object>,
 *   maxTokens?: number,
 *   temperature?: number,
 *   signal?: AbortSignal,
 *   purpose?: string,
 * }) => Promise<{
 *   text: string,
 *   toolCalls: Array<{id?: string, name: string, args: any}>,
 *   usage: {input_tokens?: number|null, output_tokens?: number|null, cache_read_input_tokens?: number, reasoning_tokens?: number} | null,
 *   stopReason: {kind: string}|null,   // 宿主 FinishReason（{kind:'stop'|'tool-calls'|'max-tokens'|'aborted'|...}），不转字符串
 * }>} complete
 */

/**
 * 会话日志端口 —— 原始历史的真相源（§18.3）。
 * @typedef {object} SessionLogPort
 * @property {(sessionId: string, opts?: {from?: string, limit?: number}) => Promise<Array<{
 *   eventId: string, role: string, eventType: string, content: string,
 *   createdAt?: string, taskId?: string|null, threadId?: string|null,
 *   parentEventId?: string|null, metadata?: object,
 * }>>} read
 */

/**
 * token 压力端口（§9.6）。仅用于**相对压力**与调度，
 * MUST NOT 用作"是否超出硬窗口"的判定依据。
 * @typedef {object} TokenMeterPort
 * @property {(sessionId: string) => {estimatedTokens: number, ratio: number}|null} measure
 */

/** 端口契约自检：便于在装配处尽早失败。 */
export function assertLlmPort(port) {
  if (!port || typeof port.complete !== 'function') {
    throw new Error('[contextvm] llm 端口必须实现 complete()');
  }
  return port;
}
