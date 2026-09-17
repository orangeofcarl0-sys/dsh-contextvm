/**
 * 预算装箱（§9.3 优先级 / §9.6 硬上限）。
 *
 * 纪律：低优先级内容超预算时**删除**，MUST NOT 截断高优先级内容。
 * 装箱顺序即 §9.3 的固定优先级，所有模式共用这一个实现（Phase C 的
 * GLOBAL 编排也复用它，不另写一套装箱逻辑）。
 *
 * @module dsh-contextvm/context/budget
 */

/**
 * §9.3 装箱优先级。数字越小越优先，永不删除。
 * @type {Readonly<Record<string, number>>}
 */
export const PRIORITY = Object.freeze({
  system_protocol: 1,
  current_user_message: 2,
  active_hard_constraint: 3,
  task_goal_next_action: 4,
  current_artifact: 5,
  recent_verbatim: 6,
  primary_evidence: 7,
  active_decisions_facts: 8,
  episode_navigator: 9,
  secondary_evidence: 10,
  stale_tool_output: 11,
});

/** 永不因预算被删除的优先级（§9.3 / §10.2）。 */
export const NEVER_DROP = Object.freeze(new Set([PRIORITY.system_protocol, PRIORITY.current_user_message]));

/**
 * 按优先级装箱。
 *
 * @param {Array<{id: string, priority: number, tokenCount: number, [k: string]: any}>} items
 * @param {{budget: number}} opts
 * @returns {{included: Array<object>, dropped: Array<{id: string, priority: number, tokenCount: number, reason: string}>, tokens: number}}
 */
export function packByPriority(items, opts) {
  const budget = opts.budget;
  if (!(Number.isFinite(budget) && budget >= 0)) throw new Error(`packByPriority 需要非负预算，收到 ${budget}`);

  const sorted = [...items].sort((a, b) => a.priority - b.priority || String(a.id).localeCompare(String(b.id)));
  const included = [];
  const dropped = [];
  let tokens = 0;

  for (const item of sorted) {
    const cost = item.tokenCount ?? 0;
    if (NEVER_DROP.has(item.priority)) {
      included.push(item);
      tokens += cost;
      continue;
    }
    if (tokens + cost > budget) {
      dropped.push({ id: item.id, priority: item.priority, tokenCount: cost, reason: 'budget' });
      continue;
    }
    included.push(item);
    tokens += cost;
  }
  return { included, dropped, tokens };
}

/**
 * 各组件预算占比切分（§9.2）。返回按组件名索引的 token 上限。
 * @param {object} budgets deriveBudgets() 的产物
 * @returns {Record<string, number>}
 */
export function componentCaps(budgets) {
  const c = budgets.components;
  return {
    system_protocol: c.systemProtocolMax,
    authoritative_state: c.authoritativeStateMax,
    recent_verbatim: c.recentVerbatimMax,
    episode_navigator: c.episodeNavigatorMax,
    retrieved_evidence: c.retrievedEvidenceMax,
    current_artifact: c.currentArtifactMax,
  };
}
