/**
 * 去重（§9.4 / §10）。
 *
 * 三种必须识别的情形，各只有一处实现：
 *   1. 完全相同的 content hash —— 已在 retriever 内处理；
 *   2. 证据被更大的已选证据完全包含（neighborhood 片段会嵌套）；
 *   3. 仅由某个 state 项重复陈述、且无额外信息的证据。
 *
 * @module dsh-contextvm/context/dedup
 */

/**
 * 折叠嵌套/重复的证据束。
 * @param {Array<{sourceEventIds: string[], content: string, score: number, tokenCount: number}>} bundles
 *        MUST 已按 score 降序（强者优先保留）
 * @returns {{kept: Array<object>, dropped: Array<{keptBy: string, reason: string}>}}
 */
export function dedupeEvidence(bundles) {
  const kept = [];
  const dropped = [];
  const seenSets = [];
  for (const b of bundles) {
    const ids = new Set(b.sourceEventIds);
    let dupOf = null;
    for (let i = 0; i < kept.length; i += 1) {
      const prev = kept[i];
      const prevIds = seenSets[i];
      // 完全同集，或本束被前一束完全包含
      if (ids.size === prevIds.size && [...ids].every((id) => prevIds.has(id))) {
        dupOf = prev;
        break;
      }
      if (ids.size < prevIds.size && [...ids].every((id) => prevIds.has(id))) {
        dupOf = prev;
        break;
      }
    }
    if (dupOf) {
      dropped.push({ keptBy: dupOf.sourceEventIds[0], reason: 'contained_in_stronger_evidence' });
      continue;
    }
    kept.push(b);
    seenSets.push(ids);
  }
  return { kept, dropped };
}

/**
 * 去掉"仅重复 state 已陈述内容且无额外信息"的证据（§9.4）。
 *
 * 判据保守：仅当证据内容去掉标签后与某个 active state 项的取值完全相同，
 * 才认为它不含额外信息。宁多留一条证据，不少留。
 *
 * @param {Array<{content: string, tokenCount: number, sourceEventIds: string[]}>} bundles
 * @param {Array<{value: any, itemType: string}>} stateItems
 * @returns {{kept: Array<object>, dropped: Array<{reason: string}>}}
 */
export function dedupeAgainstState(bundles, stateItems) {
  const values = new Set(
    stateItems
      .map((i) => (typeof i.value === 'string' ? i.value.trim() : null))
      .filter((v) => v && v.length > 0),
  );
  const kept = [];
  const dropped = [];
  for (const b of bundles) {
    const stripped = b.content
      .split('\n')
      .map((l) => l.replace(/^\[[a-z_]+\]\s*/i, '').trim())
      .join('\n')
      .trim();
    if (values.has(stripped)) {
      dropped.push({ reason: 'fully_restated_by_state' });
      continue;
    }
    kept.push(b);
  }
  return { kept, dropped };
}
