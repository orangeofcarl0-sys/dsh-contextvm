/**
 * Context Mode 分类（§8）。
 *
 * §8.3 的语义标记 MUST 强制或高概率进入 GLOBAL —— 命中即 GLOBAL，
 * 不设阈值、不做二次判断，以免"全部/无遗漏"类请求被降级成 top-k RAG。
 *
 * @module dsh-contextvm/context/classifier
 */
import { GLOBAL_MARKERS, BROAD_MARKERS } from '../core/enums.js';

/**
 * @param {string} query
 * @returns {string[]} 命中的 GLOBAL 标记
 */
export function globalMarkersIn(query) {
  const s = String(query ?? '').toLowerCase();
  return GLOBAL_MARKERS.filter((m) => s.includes(m.toLowerCase()));
}

/**
 * @param {string} query
 * @returns {string[]} 命中的 BROAD 标记
 */
export function broadMarkersIn(query) {
  const s = String(query ?? '').toLowerCase();
  return BROAD_MARKERS.filter((m) => s.includes(m.toLowerCase()));
}

/**
 * 选择读取模式。
 * @param {string} query
 * @param {{retrievalConfidence?: number|null}} [opts] 0..1；低置信度倾向 BROAD（§8.2）
 * @returns {{mode: 'LOCAL'|'BROAD'|'GLOBAL', reasons: string[]}}
 */
export function classify(query, opts = {}) {
  const g = globalMarkersIn(query);
  if (g.length > 0) {
    return { mode: 'GLOBAL', reasons: ['global_marker:' + g.join('|')] };
  }
  const b = broadMarkersIn(query);
  if (b.length > 0) {
    return { mode: 'BROAD', reasons: ['broad_marker:' + b.join('|')] };
  }
  const conf = opts.retrievalConfidence;
  if (typeof conf === 'number' && conf < 0.35) {
    return { mode: 'BROAD', reasons: ['low_retrieval_confidence'] };
  }
  return { mode: 'LOCAL', reasons: [] };
}
