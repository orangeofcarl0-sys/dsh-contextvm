/**
 * Prompt 契约（§20 / §13.2 / §5.2）。
 *
 * 所有提示词集中在此，MUST NOT 散落到业务逻辑里；这样"契约变了"只有一处要改。
 * 目标模型不回传 CoT，故全部契约只要求**结论性结构**，不要求推理过程。
 *
 * @module dsh-contextvm/llm/prompts
 */

/** §20.2 State Delta Extractor 的核心约束。 */
export const DELTA_SYSTEM = [
  '你是一个状态抽取器。输入是本轮的查询、助手回答与当前状态摘要。',
  '你的唯一任务是输出本轮**新增或变化**的状态增量，不回答问题、不做解释。',
  '',
  '硬性要求：',
  '1. 只记录本轮新增或变化的信息。已存在且未变化的信息不得重复输出。',
  '2. 推断出的内容必须标为 assumption，不得标为 fact。',
  '3. 只有明确被新信息取代时才写 supersede，并给出被取代项的 state_id。',
  '4. 删除或取代 active 约束必须有本轮的直接依据（用户明说或工具结果），否则不得取代。',
  '5. next_action 只写一条最直接的下一步。',
  '6. 没有变化就输出空对象：{"upsert":[],"supersede":[],"resolve":[],"open":[],"next_action":null}',
  '',
  '输出格式（只输出 JSON，不要任何其他文字、不要代码围栏）：',
  '{',
  '  "upsert": [{"type":"constraint|decision|fact|assumption|preference|goal|artifact_state|plan_step",',
  '              "key":"稳定的短标识或 null","value":"内容","status":"active|uncertain",',
  '              "source_event_ids":["evt_..."]}],',
  '  "supersede": [{"state_id":"st_...","reason":"简述依据"}],',
  '  "resolve": ["st_..."],',
  '  "open": [{"type":"open_question","value":"..."}],',
  '  "next_action": "一句话或 null"',
  '}',
  '',
  'source_event_ids 必须来自输入中出现的真实事件 id；编造 id 会导致整份增量被拒。',
].join('\n');

/**
 * 状态提交工具的 schema（§13.2 的工具路径）。
 * 该工具的参数即 §5.2 的 delta 结构；工具路径比纯提示词更稳，
 * 但宿主 `GenerateOptions` 不暴露 `tool_choice`，故仍须在提示词内明确要求调用。
 */
export const DELTA_TOOL = Object.freeze({
  name: 'contextvm_commit_state',
  description:
    '提交本轮对话产生的状态增量（新增/变化/被取代/已解决/未决问题/下一步）。' +
    '只写变化项；没有变化就提交空增量。不要用它回答用户问题。',
  parameters: {
    type: 'object',
    properties: {
      upsert: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            type: {
              type: 'string',
              enum: ['goal', 'constraint', 'fact', 'decision', 'assumption', 'rejected_option', 'open_question', 'preference', 'artifact_state', 'plan_step'],
            },
            key: { type: ['string', 'null'] },
            value: {},
            status: { type: 'string', enum: ['active', 'uncertain'] },
            source_event_ids: { type: 'array', items: { type: 'string' } },
          },
          required: ['type', 'value'],
        },
      },
      supersede: {
        type: 'array',
        items: {
          type: 'object',
          properties: { state_id: { type: 'string' }, reason: { type: 'string' } },
          required: ['state_id'],
        },
      },
      resolve: { type: 'array', items: { type: 'string' } },
      open: {
        type: 'array',
        items: {
          type: 'object',
          properties: { type: { type: 'string' }, value: {} },
          required: ['value'],
        },
      },
      next_action: { type: ['string', 'null'] },
    },
  },
});

/**
 * §20.3 Global Worker 的核心约束。
 *
 * worker 的价值在于"宽而短"（§12）：只分析分配给它的 chunk，输出严格受限。
 */
export const WORKER_SYSTEM = [
  '你是一个分块扫描 worker。输入是**整段历史中的一个片段**与一个待查问题。',
  '你只能依据本片段作答，不得假定片段之外的信息。',
  '',
  '硬性要求：',
  '1. 每条 finding 必须带 source_event_ids，且 id 必须来自本片段中出现的事件 id。',
  '2. 即使没有任何发现，也必须返回 coverage，并把 complete 设为 true。',
  '3. coverage.start_event / end_event 必须**逐字**填本片段的首尾事件 id（不要写别的）。',
  '4. 禁止长篇解释；每条 claim 一句话。',
  '5. 发现互相矛盾的结论时，两边都要列出，并在 conflict_with 里写上对方的状态 id（若有）。',
  '',
  '输出 JSON，不要代码围栏，不要任何额外文字：',
  '{',
  '  "findings": [{"claim":"...","source_event_ids":["evt_..."],',
  '                "category":"constraint|decision|conflict|evidence|missing",',
  '                "relevance":0.0,"conflict_with":[]}],',
  '  "coverage": {"start_event":"evt_...","end_event":"evt_...","complete":true}',
  '}',
].join('\n');

/**
 * 构造 worker 输入。
 * @param {{query: string, events: Array<{eventId: string, eventType: string, content: string}>}} p
 * @returns {Array<{role: 'user', content: string}>}
 */
export function workerUserMessage({ query, events }) {
  return [
    {
      role: 'user',
      content: [
        `待查问题：${query}`,
        '',
        // 首尾 id 单独成行、并明确要求逐字照抄：与"共 N 条"同行会让模型
        // （以及任何解析方）把计数粘到 id 尾部，导致覆盖校验误判为缺口。
        '本片段事件范围（start/end 必须逐字照抄，不要附加任何字符）：',
        `start_event: ${events[0]?.eventId ?? '-'}`,
        `end_event: ${events.at(-1)?.eventId ?? '-'}`,
        `本片段共 ${events.length} 条事件。`,
        '',
        '## 本片段事件',
        events.map((e) => `[${e.eventType} ${e.eventId}] ${e.content}`).join('\n'),
        '',
        '请输出 findings 与 coverage 的 JSON。',
      ].join('\n'),
    },
  ];
}

/**
 * §20.1 Episode Summarizer 的核心约束。
 * 目标 500–1200 token，hard max 1600（§6.2）。
 */
export const EPISODE_SYSTEM = [
  '你是一个导航摘要器。输入是某一段对话的原始事件。',
  '这是**导航摘要**，不是新的事实来源：不得据此发明或推断原文没有的内容。',
  '',
  '硬性要求：',
  '1. 精确保留用户给出的约束、数字、文件名、接口名与显式否决项（原文照抄，不要改写数值）。',
  '2. 不得把推测写成事实：推测只放进 open_questions，不要放进 confirmed_decisions。',
  '3. 不解释无关背景，不复述寒暄。',
  '4. 输出 JSON，不要代码围栏，不要任何额外文字。',
  '5. 控制长度：数组每项一句话，总量控制在 1200 token 以内。',
  '',
  '输出格式：',
  '{',
  '  "topic": "本段主题（短）",',
  '  "goal": "本段要达成的目标",',
  '  "what_changed": ["相对此前发生的变化"],',
  '  "confirmed_decisions": ["用户或工具明确确认的决定"],',
  '  "constraints_added_or_changed": ["新增或变化的约束，含精确数值/标识符"],',
  '  "rejected_options": ["明确被否决的方案"],',
  '  "open_questions": ["尚未解决或仅属推测的问题"],',
  '  "artifacts_touched": ["涉及的文件或产物名"],',
  '  "important_numbers_or_identifiers": ["必须逐字保留的数字与标识符"],',
  '  "source_event_range": {"start_event": "evt_...", "end_event": "evt_..."},',
  '  "search_keywords": ["便于以后检索的关键词"]',
  '}',
].join('\n');

/**
 * 构造 episode 摘要的输入消息。
 * @param {{events: Array<{eventId: string, eventType: string, content: string}>}} p
 * @returns {Array<{role: 'user', content: string}>}
 */
export function episodeUserMessage({ events }) {
  const body = events
    .map((e) => `[${e.eventType} ${e.eventId}] ${e.content}`)
    .join('\n');
  return [
    {
      role: 'user',
      content: [
        `本段共 ${events.length} 条事件，起止：${events[0]?.eventId ?? '-'} .. ${events.at(-1)?.eventId ?? '-'}`,
        '',
        '## 原始事件',
        body,
        '',
        '请输出导航摘要 JSON。',
      ].join('\n'),
    },
  ];
}

/**
 * 构造 delta 抽取的输入消息（§5.2：只含本轮 query、answer 与最小的当前状态）。
 * @param {{query: string, answer: string, stateSummary: string, eventIds: string[]}} p
 * @returns {Array<{role: 'user', content: string}>}
 */
export function deltaUserMessage({ query, answer, stateSummary, eventIds }) {
  return [
    {
      role: 'user',
      content: [
        `本轮可用的事件 id：${eventIds.join(', ') || '（无）'}`,
        '',
        '## 当前 active 状态摘要',
        stateSummary || '（空）',
        '',
        '## 本轮用户查询',
        query,
        '',
        '## 本轮助手回答',
        answer,
        '',
        '请输出状态增量 JSON。',
      ].join('\n'),
    },
  ];
}
