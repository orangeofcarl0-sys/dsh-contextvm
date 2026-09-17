/**
 * LlmPort 的宿主适配器（§21.7）。
 *
 * 宿主 `llm.stream()` 是**流式**缝（`AsyncIterable<StreamChunk>`），而端口对外只有
 * 一个 `complete()`。本文件负责这层形态转换，且是唯一做转换的地方。
 *
 * 关键纪律：
 *   - `reasoning-delta` 一律丢弃（§1.3 / §27.4：不依赖隐藏推理状态）；
 *   - MUST NOT 试图改写请求（loop 请求 deep-frozen，改就抛）；
 *   - 消息与工具 schema 的宿主形态转换集中在此。
 *
 * @module dsh-contextvm/host/llm
 */

/**
 * 创建端口。
 * @param {any} ctx Cordis 上下文（需要 `ctx.get('llm')`）
 * @param {{logger?: Function}} [deps]
 * @returns {import('./ports.js').LlmPort}
 */
export function createLlmPort(ctx, deps = {}) {
  const logger = deps.logger ?? (() => {});
  /** @type {Promise<any>|null} */
  let llmMod = null;

  async function hostModule() {
    if (!llmMod) {
      llmMod = import('@deepseek-ai/dsh-llm').catch((err) => {
        logger('warn', `contextvm: 无法加载 @deepseek-ai/dsh-llm（${String(err?.message ?? err)}）`);
        return null;
      });
    }
    return llmMod;
  }

  let seq = 0;
  /**
   * 构造一条消息。优先用宿主构造器（保证满足其不可变创建契约），
   * 宿主模块缺失时退化为等效的普通对象 —— 这是宿主形态适配，不是第二套逻辑。
   */
  async function makeMessage(role, text) {
    const mod = await hostModule();
    seq += 1;
    const id = `cvmsg_${Date.now().toString(36)}_${seq}`;
    const content = [{ type: 'text', text }];
    if (mod?.createUserMessage && role === 'user') {
      try {
        return mod.createUserMessage({ id, content, source: { kind: 'contextvm' } });
      } catch {
        /* 落到普通对象 */
      }
    }
    return { id, role, content, source: { kind: 'contextvm' } };
  }

  return {
    async complete(req) {
      const llm = ctx.get?.('llm');
      if (!llm || typeof llm.stream !== 'function') {
        throw new Error('[contextvm] 宿主 llm 服务不可用：无法发起调用');
      }
      const messages = [];
      for (const m of req.messages ?? []) {
        messages.push(await makeMessage(m.role === 'assistant' ? 'assistant' : 'user', String(m.content ?? '')));
      }
      const options = {
        provider: req.provider,
        model: req.model,
        messages,
        maxTokens: req.maxTokens,
        temperature: req.temperature,
        signal: req.signal,
        purpose: req.purpose,
      };
      if (req.system) options.system = req.system;
      if (req.tools?.length) {
        // ToolSchema = {name, description, parameters}，与本插件使用的形状一致
        options.tools = req.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
      }

      const agg = await aggregateStream(llm.stream(options), logger);
      return {
        text: agg.text,
        toolCalls: agg.toolCalls,
        usage: toPortUsage(agg.usage),
        stopReason: agg.stopReason,
        chunks: agg.chunks,
        types: agg.types,
      };
    },
  };
}

/**
 * 宿主的 `TokenUsage` 用 camelCase（`inputTokens` / `outputTokens`），
 * 而端口契约（`ports.js`）与遥测字段用 snake_case。**转换只在这一处做** ——
 * 插件内部与所有假端口只有一套词汇，不在下游做"两种字段名都认"的兼容。
 *
 * @param {any} u 宿主的 TokenUsage
 * @returns {{input_tokens: number|null, output_tokens: number|null, cache_read_input_tokens?: number, reasoning_tokens?: number}|null}
 */
export function toPortUsage(u) {
  if (!u || typeof u !== 'object') return null;
  const out = {
    input_tokens: u.inputTokens ?? null,
    output_tokens: u.outputTokens ?? null,
  };
  if (u.cacheReadTokens != null) out.cache_read_input_tokens = u.cacheReadTokens;
  // reasoning_tokens 只用于记账与排障：它是"模型把输出预算花在推理上"的
  // 唯一可见证据（正文为空时，这个数能解释为什么）。
  if (u.reasoningTokens != null) out.reasoning_tokens = u.reasoningTokens;
  return out;
}

/**
 * 消费宿主的流式输出并聚合成一次调用的结果。
 *
 * 单独成函数的原因：这里同时处理五种 chunk 形态与两类累加（文本、工具参数增量），
 * 是端口适配里唯一有真实控制流复杂度的地方；抽出来后 `complete()` 只剩"构造请求"。
 *
 * @param {AsyncIterable<object>} stream
 * @param {Function} logger
 * @returns {Promise<{text: string, toolCalls: object[], usage: object|null, stopReason: string|null}>}
 */
export async function aggregateStream(stream, logger = () => {}) {
  let text = '';
  /** @type {Map<number, {name: string, args: string}>} */
  const toolAcc = new Map();
  let stopReason = null;
  let usage = null;
  let reasoningDropped = 0;
  let chunks = 0;
  /** @type {Set<string>} */
  const types = new Set();
  /** @type {Set<string>} */
  const unknown = new Set();

  for await (const chunk of stream) {
    chunks += 1;
    const t = chunk?.type ?? '(无 type)';
    types.add(t);
    switch (t) {
      case 'text-delta':
        text += chunk.text ?? '';
        break;
      case 'reasoning-delta':
        reasoningDropped += 1; // 显式丢弃：不使用 CoT（§1.3 / §27.4）
        break;
      case 'tool-call-delta': {
        const cur = toolAcc.get(chunk.index) ?? { name: '', args: '' };
        if (chunk.name) cur.name = chunk.name;
        // 字段名以宿主类型为准：StreamChunk 的 tool-call-delta 携带 **argumentsDelta**
        if (chunk.argumentsDelta) cur.args += chunk.argumentsDelta;
        toolAcc.set(chunk.index, cur);
        break;
      }
      case 'block-start':
      case 'block-end':
        break;
      // usage 与 finish 是**独立的 chunk 类型**（不是挂在某个 done 上）：
      // 漏读它们的代价是用量与结束原因永远为 null —— 既让 §9.6 的真实 usage 标定
      // 一直拿不到数，也让排障时无法区分"模型没回内容"与"我们没读"。
      case 'usage':
        usage = chunk.usage ?? usage;
        break;
      case 'finish':
        stopReason = chunk.reason ?? stopReason;
        break;
      default:
        unknown.add(t);
        break;
    }
  }
  if (reasoningDropped > 0) {
    logger('info', `contextvm: 丢弃 ${reasoningDropped} 个 reasoning 增量（不使用 CoT）`);
  }
  // 未识别的 chunk 类型此前被静默丢弃 —— 真机上表现为"调用花了 27 秒、text/usage/stopReason
  // 全空、且毫无线索"，查不动。宁可吵一点，也要让它们露面。
  if (unknown.size) {
    logger('warn', `contextvm: 收到未识别的流 chunk 类型 ${[...unknown].join(', ')}；已忽略，若结果为空请优先查这里`);
  }

  const toolCalls = [...toolAcc.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, t]) => {
      let args = {};
      try {
        args = t.args ? JSON.parse(t.args) : {};
      } catch {
        // 参数流被截断：保留原文而不是静默当成空参数，便于上游诊断
        args = { __unparsed: t.args };
      }
      return { index, name: t.name, args };
    });

  return { text, toolCalls, usage, stopReason, chunks, types: [...types] };
}
