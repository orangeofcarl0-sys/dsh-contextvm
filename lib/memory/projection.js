/**
 * 状态投影（§5.1 / 附录 A）。
 *
 * 供两处使用，共用同一实现：
 *   1. delta 抽取提示词里的"最小必要状态"（§5.2）；
 *   2. 审计与重建报告。
 *
 * @module dsh-contextvm/memory/projection
 */
import { ITEM_TYPES } from '../core/enums.js';

/**
 * 生成状态摘要文本。只列 active 项；按 §5.1 的分组顺序稳定输出。
 * @param {import('../storage/state_store.js').StateStore} state
 * @param {string} sessionId
 * @param {{maxTokens?: number, tokenizer?: import('../core/tokenization.js').Tokenizer}} [opts]
 * @returns {string}
 */
export function projectStateSummary(state, sessionId, opts = {}) {
  const active = state.active(sessionId);
  if (active.length === 0) return '';
  const lines = [];
  for (const type of ITEM_TYPES) {
    const group = active.filter((i) => i.itemType === type);
    if (group.length === 0) continue;
    for (const it of group) {
      const val = typeof it.value === 'string' ? it.value : JSON.stringify(it.value);
      lines.push(`${type}${it.key ? `[${it.key}]` : ''} (${it.stateId}): ${val}`);
    }
  }
  let text = lines.join('\n');
  const tok = opts.tokenizer;
  const max = opts.maxTokens;
  if (tok && max) {
    while (tok.estimate(text) > max && lines.length > 1) {
      lines.pop();
      text = lines.join('\n');
    }
  }
  return text;
}
