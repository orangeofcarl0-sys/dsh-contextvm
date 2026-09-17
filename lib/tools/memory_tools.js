/**
 * JIT Memory Tools（§14）。
 *
 * 纪律：每个 tool result SHOULD 只返回**必要内容与 source IDs**（§14），
 * 因此所有结果都经统一的有界渲染，超限时明确写出"已截断"而不是静默丢内容。
 *
 * 这组工具与 `commit_state` / `exhaustive_scan` 的区别：前者写入，后者是
 * "完整性请求"的专用通道；本组只做按需读取。若模型需要更多历史，允许多轮
 * tool retrieval，轮数上限见 §14（配置 `toolRounds`）。
 *
 * 结构：**定义表 + 实现函数**分离。定义表保留全部描述与参数 schema（便于集中审阅
 * 模型看到什么），实现函数各自独立（便于单读）。两者只通过 `ctx` 对象耦合。
 *
 * @module dsh-contextvm/tools/memory_tools
 */
import { toolOutput, TRACEABLE_FIELDS } from './output.js';
import { sessionIdOf } from './exec.js';

/** 单个 tool result 的目标上限（token）。超出即截断并标注。 */
const RESULT_BUDGET_TOKENS = 1200;

export const MEMORY_TOOL_NAMES = Object.freeze([
  'search_memory',
  'fetch_event',
  'fetch_events',
  'fetch_episode',
  'fetch_artifact',
  'search_artifacts',
]);

/**
 * 有界渲染：把可能的超长内容裁到预算内，并显式标注截断。
 * @param {import('../core/tokenization.js').Tokenizer} tokenizer
 * @param {string} text
 * @param {number} [budget]
 */
function boundText(tokenizer, text, budget = RESULT_BUDGET_TOKENS) {
  const s = String(text ?? '');
  if (tokenizer.estimate(s) <= budget) return { text: s, truncated: false };
  // 按字符比例估计可留长度，再逐步收紧以适配估算误差
  let keep = Math.max(200, Math.floor((s.length * budget) / Math.max(1, tokenizer.estimate(s))));
  let out = s.slice(0, keep);
  while (tokenizer.estimate(out) > budget && keep > 200) {
    keep = Math.floor(keep * 0.9);
    out = s.slice(0, keep);
  }
  return { text: `${out}\n…（已截断，原文约 ${tokenizer.estimate(s)} token）`, truncated: true };
}

// ---------------------------------------------------------------- 实现

/** search_memory：关键词检索（摘要作为导航层一并返回）。 */
async function runSearchMemory(ctx, args, exec) {
  const sessionId = ctx.sessionOf(exec);
  if (!sessionId) return { ok: false, result: '无法确定会话。', source_event_ids: [], truncated: false };
  const limit = Math.max(1, Math.min(20, Math.round(args.limit ?? 8)));
  const got = ctx.runtime.retriever.retrieve(sessionId, String(args.query ?? ''), {
    tokenBudget: RESULT_BUDGET_TOKENS * 2,
    limits: { merged: limit },
    filters: args.taskId ? { taskId: String(args.taskId) } : undefined,
  });
  if (got.bundles.length === 0) {
    return { ok: true, result: '未命中任何历史证据。', source_event_ids: [], truncated: false };
  }
  const ids = [...new Set(got.bundles.flatMap((b) => b.sourceEventIds))];
  const body = got.bundles
    .map((b, i) => `${i + 1}. [${b.kind}] score=${b.score.toFixed(3)} why=${b.reason.join('+')}\n${b.content}`)
    .join('\n\n');
  const bounded = boundText(ctx.tok, body);
  return { ok: true, result: bounded.text, source_event_ids: ids, truncated: bounded.truncated };
}

/** fetch_event：按 id 取单条原始事件。 */
async function runFetchEvent(ctx, args, exec) {
  // 与其它 §14 工具一致：**全部**要求会话上下文。若无会话即放行，
  // 会形成一条"跨会话可读"的旁路（id 虽难猜，但权限姿态必须统一）。
  const sessionId = ctx.sessionOf(exec);
  if (!sessionId) return { ok: false, result: '无法确定会话。', source_event_ids: [], truncated: false };
  const ev = ctx.runtime.raw.get(String(args.event_id ?? ''));
  if (!ev || ev.sessionId !== sessionId) {
    return { ok: false, result: `未找到事件 ${args.event_id}（或不属于本会话）。`, source_event_ids: [], truncated: false };
  }
  const bounded = boundText(ctx.tok, `[${ev.eventType} ${ev.eventId}] ${ev.content}`);
  return { ok: true, result: bounded.text, source_event_ids: [ev.eventId], truncated: bounded.truncated };
}

/** fetch_events：批量取原始事件（单次上限 20 条）。 */
async function runFetchEvents(ctx, args, exec) {
  const sessionId = ctx.sessionOf(exec);
  if (!sessionId) return { ok: false, result: '无法确定会话。', source_event_ids: [], truncated: false };
  const ids = (Array.isArray(args.event_ids) ? args.event_ids : []).slice(0, 20).map(String);
  if (ids.length === 0) return { ok: false, result: '未提供 event_ids。', source_event_ids: [], truncated: false };
  const found = ctx.runtime.raw.getMany(ids).filter((e) => e && e.sessionId === sessionId);
  const missing = ids.length - found.length;
  const body = found.map((e) => `[${e.eventType} ${e.eventId}] ${e.content}`).join('\n');
  const bounded = boundText(ctx.tok, missing ? `${body}\n（${missing} 条未找到或不属于本会话）` : body);
  return { ok: true, result: bounded.text, source_event_ids: found.map((e) => e.eventId), truncated: bounded.truncated };
}

/** fetch_episode：取导航摘要与原始范围（摘要不是真相源）。 */
async function runFetchEpisode(ctx, args, exec) {
  const sessionId = ctx.sessionOf(exec);
  if (!sessionId) return { ok: false, result: '无法确定会话。', source_event_ids: [], truncated: false };
  const ep = ctx.runtime.episodes?.episodes.get(String(args.episode_id ?? ''));
  if (ep && ep.sessionId !== sessionId) {
    return { ok: false, result: `未找到 episode ${args.episode_id}（或不属于本会话）。`, source_event_ids: [], truncated: false };
  }
  if (!ep) return { ok: false, result: `未找到 episode ${args.episode_id}。`, source_event_ids: [], truncated: false };
  const body = [
    `episode: ${ep.episodeId} status=${ep.status} raw_tokens=${ep.rawTokenCount}`,
    `范围: ${ep.startEventId} .. ${ep.endEventId}`,
    ep.summary ? `摘要（导航，非真相源）:\n${ep.summary}` : '（尚未生成摘要）',
  ].join('\n');
  return { ok: true, result: body, source_event_ids: [ep.startEventId, ep.endEventId], truncated: false };
}

/** fetch_artifact：取引用与摘要（正文属宿主文件能力，插件不读取）。 */
async function runFetchArtifact(ctx, args, exec) {
  const sessionId = ctx.sessionOf(exec);
  if (!sessionId) return { ok: false, result: '无法确定会话。', source_event_ids: [], truncated: false };
  const art = ctx.runtime.artifacts?.get(String(args.artifact_id ?? ''));
  if (art && art.sessionId !== sessionId) {
    return { ok: false, result: `未找到 artifact ${args.artifact_id}（或不属于本会话）。`, source_event_ids: [], truncated: false };
  }
  if (!art) return { ok: false, result: `未找到 artifact ${args.artifact_id}。`, source_event_ids: [], truncated: false };
  const body = [
    `${art.logicalName} v${art.version} status=${art.status}`,
    art.uri ? `uri: ${art.uri}` : 'uri: （无）',
    art.summary ? `摘要: ${art.summary}` : '摘要: （无）',
    art.createdEventId ? `创建事件: ${art.createdEventId}` : '',
    '（本插件不读取文件正文；请按 uri 用宿主文件能力取）',
  ]
    .filter(Boolean)
    .join('\n');
  return {
    ok: true,
    result: body,
    source_event_ids: art.createdEventId ? [art.createdEventId] : [],
    truncated: false,
  };
}

/** search_artifacts：按名字或摘要检索当前有效版本。 */
async function runSearchArtifacts(ctx, args, exec) {
  const sessionId = ctx.sessionOf(exec);
  if (!sessionId) return { ok: false, result: '无法确定会话。', source_event_ids: [], truncated: false };
  const found = ctx.runtime.artifacts?.search(
    sessionId,
    String(args.query ?? ''),
    Math.min(20, Math.round(args.limit ?? 10)),
  ) ?? [];
  if (found.length === 0) return { ok: true, result: '未找到匹配的 artifact。', source_event_ids: [], truncated: false };
  const body = found
    .map((a) => `- ${a.logicalName} v${a.version} (${a.artifactId})${a.summary ? `: ${a.summary}` : ''}`)
    .join('\n');
  const bounded = boundText(ctx.tok, body);
  return {
    ok: true,
    result: bounded.text,
    source_event_ids: found.map((a) => a.createdEventId).filter(Boolean),
    truncated: bounded.truncated,
  };
}

// ---------------------------------------------------------------- 定义表

/**
 * 构造全部 JIT 工具定义。
 * @param {import('../app/runtime.js').Runtime} runtime
 * @param {{defineTool: Function}} deps
 * @returns {Array<object>}
 */
export function memoryTools(runtime, deps) {
  const { defineTool } = deps;
  /** §14：结果短、且必须带 source ids 与截断标记 —— 契约由 tools/output.js 统一定义。 */
  const OUT = (extra = {}) => toolOutput({ ...TRACEABLE_FIELDS, ...extra });
  // 实现函数只依赖这一个上下文对象，避免各自捕获一堆闭包变量
  const ctx = {
    runtime,
    tok: runtime.tokenizer,
    sessionOf: sessionIdOf,
  };

  return [
    defineTool({
      name: 'search_memory',
      description:
        '按需检索历史记忆（关键词为主；episode 摘要作为导航层一并返回）。' +
        '普通追问用这个；要求"全部/无遗漏"时请用 contextvm_exhaustive_scan。' +
        '返回内容带 source_event_ids，可用 fetch_event(s) 取原文。',
      parameters: {
        query: { type: 'string', required: true, description: '检索词，尽量用原始术语/数字/文件名。' },
        limit: { type: 'number', description: '返回条数上限，默认 8。' },
        taskId: { type: 'string', description: '只看某个任务的历史。' },
      },
      output: OUT(),
      execute: (args, exec) => runSearchMemory(ctx, args, exec),
    }),

    defineTool({
      name: 'fetch_event',
      description: '按 event id 取单条原始事件全文（用于核对精确值、原文措辞）。',
      parameters: {
        event_id: { type: 'string', required: true, description: '事件 id，形如 evt_...' },
      },
      output: OUT(),
      execute: (args, exec) => runFetchEvent(ctx, args, exec),
    }),

    defineTool({
      name: 'fetch_events',
      description: '批量按 id 取原始事件（每次最多 20 条）。',
      parameters: {
        event_ids: { type: 'array', items: { type: 'string' }, required: true, description: '事件 id 数组' },
      },
      output: OUT(),
      execute: (args, exec) => runFetchEvents(ctx, args, exec),
    }),

    defineTool({
      name: 'fetch_episode',
      description:
        '取某个 episode 的导航摘要与原始范围。摘要**只是导航**，需要精确原文时请用 fetch_events 按范围取。',
      parameters: {
        episode_id: { type: 'string', required: true, description: 'episode id，形如 ep_...' },
      },
      output: OUT(),
      execute: (args, exec) => runFetchEpisode(ctx, args, exec),
    }),

    defineTool({
      name: 'fetch_artifact',
      description:
        '取某个 artifact 版本的**引用与摘要**。本条返回 uri；本插件不读取工作区文件，' +
        '需要正文时请用宿主自己的文件读取能力按 uri 取。',
      parameters: {
        artifact_id: { type: 'string', required: true, description: 'artifact id，形如 art_...' },
      },
      output: OUT(),
      execute: (args, exec) => runFetchArtifact(ctx, args, exec),
    }),

    defineTool({
      name: 'search_artifacts',
      description: '按名字或摘要检索 artifact（只看当前有效版本）。',
      parameters: {
        query: { type: 'string', required: true, description: '文件名或摘要片段' },
        limit: { type: 'number', description: '返回条数上限，默认 10。' },
      },
      output: OUT(),
      execute: (args, exec) => runSearchArtifacts(ctx, args, exec),
    }),
  ];
}
