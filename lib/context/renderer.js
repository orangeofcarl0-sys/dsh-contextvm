/**
 * 渲染（§9.5 固定顺序 / §5.1 状态块形态）。
 *
 * 本模块只负责"把结构渲染成文本"，不做取舍与预算判断（那是 budget.js 的职责）。
 * 顺序常量与 §9.5 的段落名一一对应；宿主自有段落（[SYSTEM]、[USER QUERY]）
 * 不在这里渲染，但 order 值留出间隔以便与之交错。
 *
 * @module dsh-contextvm/context/renderer
 */

/** §9.5 段落顺序。数值即插入位置，间隔 100 便于宿主段落穿插。 */
export const SECTION_ORDER = Object.freeze({
  current_task: 100,
  authoritative_state: 200,
  current_artifact: 300,
  recent_verbatim: 400,
  retrieved_evidence: 500,
  episode_navigator: 600,
  output_contract: 900,
});

/**
 * 渲染当前任务段。
 * @param {{objective?: string|null, nextAction?: string|null, taskId?: string|null}} t
 * @returns {string}
 */
export function renderTask({ objective, nextAction, taskId }) {
  const lines = [];
  if (taskId) lines.push(`task_id: ${taskId}`);
  if (objective) lines.push(`objective: ${objective}`);
  if (nextAction) lines.push(`next_action: ${nextAction}`);
  return lines.length ? lines.join('\n') : '';
}

/**
 * 渲染权威状态块（§5.1）。只渲染 active 项；superseded/rejected 仅在明确需要时另列。
 * @param {Array<{stateId: string, itemType: string, key: string|null, value: any, sourceEventIds: string[]}>} items
 * @returns {string}
 */
export function renderStateBlock(items) {
  if (!items || items.length === 0) return '';
  const groups = new Map();
  for (const it of items) {
    if (!groups.has(it.itemType)) groups.set(it.itemType, []);
    groups.get(it.itemType).push(it);
  }
  const out = [];
  for (const [type, arr] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    out.push(`${type}:`);
    for (const it of arr) {
      const val = typeof it.value === 'string' ? it.value : JSON.stringify(it.value);
      const src = it.sourceEventIds.length ? ` source: ${it.sourceEventIds.join(',')}` : '';
      out.push(`  - ${it.key ? `[${it.key}] ` : ''}${val}${src}`);
    }
  }
  return out.join('\n');
}

/**
 * 渲染被取代/被否决项（供 §8.3 的"否决项不得重新推荐"与审计使用）。
 * @param {Array<object>} items status 为 superseded / rejected / resolved 的项
 * @returns {string}
 */
export function renderInactiveState(items) {
  if (!items || items.length === 0) return '';
  return items
    .map((it) => {
      const val = typeof it.value === 'string' ? it.value : JSON.stringify(it.value);
      const by = it.supersededBy ? ` superseded_by: ${it.supersededBy}` : '';
      return `- [${it.status}] ${it.itemType}${it.key ? ` ${it.key}` : ''}: ${val}${by}`;
    })
    .join('\n');
}

/**
 * 渲染 recent verbatim 段。保持原始顺序与角色，便于模型理解对话流。
 * @param {Array<{eventId: string, eventType: string, role: string, content: string}>} events
 * @returns {string}
 */
export function renderRecent(events) {
  if (!events || events.length === 0) return '';
  return events.map((e) => `[${e.eventType} ${e.eventId}] ${e.content}`).join('\n');
}

/**
 * 渲染检索证据段（§7.4：必须带 source id）。
 * @param {Array<{sourceEventIds: string[], content: string, score: number, reason: string[]}>} bundles
 * @returns {string}
 */
export function renderEvidence(bundles) {
  if (!bundles || bundles.length === 0) return '';
  return bundles
    .map(
      (b, i) =>
        `<evidence #${i + 1} score=${b.score.toFixed(3)} why=${b.reason.join('+') || 'n/a'} src=${b.sourceEventIds.join(',')}>\n${b.content}\n</evidence>`,
    )
    .join('\n');
}

/**
 * 渲染 episode 导航段（Phase B 起有内容；Phase A 传空数组即得空串）。
 * @param {Array<{episodeId: string, topic?: string, summary?: string}>} episodes
 * @returns {string}
 */
export function renderNavigator(episodes) {
  if (!episodes || episodes.length === 0) return '';
  return episodes.map((e) => `- ${e.episodeId}${e.topic ? ` [${e.topic}]` : ''}: ${e.summary ?? ''}`).join('\n');
}

/**
 * 渲染穷举扫描的 findings（§11.2 / §11.3）。冲突双方都要出现，不得只留一方。
 * @param {Array<object>} findings
 * @param {Array<{a: object, b: object, key: string}>} conflicts
 * @returns {string}
 */
export function renderFindings(findings, conflicts = []) {
  if (!findings || findings.length === 0) return '';
  const lines = findings.map(
    (f, i) => `${i + 1}. [${f.category}] ${f.claim} (src=${f.sourceEventIds.join(',')}, rel=${Number(f.relevance).toFixed(2)})`,
  );
  if (conflicts.length) {
    lines.push('');
    lines.push('检测到的矛盾（双方均保留，不得以多数决覆盖用户明确约束）：');
    for (const c of conflicts) {
      lines.push(`- A: ${c.a.claim} (src=${c.a.sourceEventIds.join(',')})`);
      lines.push(`  B: ${c.b.claim} (src=${c.b.sourceEventIds.join(',')})`);
    }
  }
  return lines.join('\n');
}

/**
 * 渲染扫描覆盖声明（§11.3 / §23.3）。
 * 覆盖不完整时 MUST 明确写出"未覆盖全部"，不得给出"已检查全部"的措辞。
 * @param {{complete: boolean, reason: string, chunks: number, coveredChunks: number, gaps?: any[], failedChunks?: any[]}} coverage
 * @returns {string}
 */
export function renderCoverage(coverage) {
  const lines = [
    `scope: ${coverage.scope ? `${coverage.scope.firstSeq}..${coverage.scope.lastSeq}` : 'unknown'}`,
    `chunks: ${coverage.coveredChunks}/${coverage.chunks}`,
    `complete: ${coverage.complete}`,
  ];
  if (coverage.complete) {
    lines.push('本轮的"全部/无遗漏"结论有覆盖依据。');
  } else {
    lines.push(
      `覆盖不完整（原因：${coverage.reason}）。你必须明确说明本次结论未覆盖全部历史，` +
        '不得使用"已检查全部""没有遗漏"这类表述。',
    );
  }
  const failed = coverage.failedChunks ?? [];
  const gaps = coverage.gaps ?? [];
  if (failed.length) lines.push(`未完成的块：${failed.map((f) => `#${f.chunkIndex}(${f.reason})`).join(', ')}`);
  if (gaps.length) lines.push(`覆盖缺口：${gaps.map((g) => `#${g.chunkIndex}`).join(', ')}`);
  return lines.join('\n');
}

/**
 * 渲染当前产物段（§9.5 CURRENT ARTIFACT / §4.4）。
 * 只给引用与摘要 —— 正文经 uri 或 raw event 按需取（JIT），
 * MUST NOT 把整个对象塞进上下文。
 * @param {Array<{logicalName: string, version: number, uri: string|null, summary: string|null}>} artifacts
 * @returns {string}
 */
export function renderArtifacts(artifacts) {
  if (!artifacts || artifacts.length === 0) return '';
  return artifacts
    .map((a) => `- ${a.logicalName}@v${a.version}${a.uri ? ` uri=${a.uri}` : ''}${a.summary ? `: ${a.summary}` : ''}`)
    .join('\n');
}

/** 输出契约（§13.2 / §20.2）。与提交工具和 §13.1 的辅助调用契约一致。 */
export const OUTPUT_CONTRACT = [
  '回答用户问题；不要复述本段规则。',
  '若本轮产生了新的结论、约束、决定或未决问题，调用 contextvm_commit_state 提交**一次**增量 delta。',
  '每轮最多提交一次：提交过之后就不要再调用它，MUST NOT 反复提交空 delta。',
  'delta 只写本轮新增或变化项；已存在且未变化的信息不要重复提交。',
  '只有明确被取代时才使用 supersede；推断必须标为 assumption，不得标为 fact。',
  'next_action 只写一条最直接的下一步。',
  '没有变化就不必提交 —— 空 delta 不是必须的；不要为了提交 delta 而打断回答。',
].join('\n');

/**
 * 组装段落数组（供 system-prompt/assemble 使用）。
 * @param {Array<{id: string, order: number, title: string, content: string}>} sections
 * @returns {Array<{id: string, order: number, title: string, content: string}>} 过滤空段并按 order 升序
 */
export function assembleSections(sections) {
  return sections
    .filter((s) => s.content && s.content.length > 0)
    .sort((a, b) => a.order - b.order)
    .map((s) => ({ ...s, content: s.content }));
}
