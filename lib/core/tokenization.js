/**
 * 本地 token 估算（§9.6）。
 *
 * 三条口径必须分清，本模块只负责"本地估算"这一条：
 *   ① 真实分词器 —— 只能由上游 `usage` 读出，用 recordUsage() 回灌；
 *   ② 本地估算   —— 本模块；
 *   ③ 网关预检估算 —— 由路由属性决定，见 lib/context/budget.js。
 *
 * §9.6 MUST 3：无 ① 的历史时 MUST 取保守下界 2.0 chars/token（假设最坏情况），
 * 并在首次真实响应后用 ① 校正。故本模块只有一条路径：有标定值用标定值，
 * 没有就用下界。不做"按语种写死系数"的第二套逻辑，避免两套口径并存。
 *
 * @module dsh-contextvm/core/tokenization
 */

/** 无标定历史时的保守下界（§9.6 MUST 3）。chars/token。 */
export const FLOOR_CPT = 2.0;

/** 标定值的合理区间护栏，防止单次异常 usage 把系数带偏。 */
const MIN_CPT = 1.2;
const MAX_CPT = 10;

/**
 * 判定内容类型，用于分别标定（§25 要求按内容类型分别记录）。
 * @param {string} text
 * @returns {'cjk'|'ascii'|'mixed'}
 */
export function detectKind(text) {
  let cjk = 0;
  let other = 0;
  for (const ch of String(text)) {
    const cp = ch.codePointAt(0);
    if (
      (cp >= 0x3040 && cp <= 0x30ff) || // 假名
      (cp >= 0x3400 && cp <= 0x4dbf) || // 扩展 A
      (cp >= 0x4e00 && cp <= 0x9fff) || // 基本汉字
      (cp >= 0xf900 && cp <= 0xfaff) || // 兼容汉字
      (cp >= 0xac00 && cp <= 0xd7af) // 谚文
    ) {
      cjk += 1;
    } else if (cp > 0x20) {
      other += 1;
    }
  }
  if (cjk === 0) return 'ascii';
  if (other === 0) return 'cjk';
  return 'mixed';
}

/**
 * 本地 token 估算器。单条路径：已标定则用标定值，否则用保守下界。
 */
export class Tokenizer {
  /** @param {{cpt?: Record<string, number>}} [seed] 持久化恢复用。 */
  constructor(seed = {}) {
    /** @type {Map<string, {cpt: number, samples: number}>} */
    this.calibration = new Map();
    for (const [kind, cpt] of Object.entries(seed.cpt ?? {})) {
      this.calibration.set(kind, { cpt, samples: 0 });
    }
  }

  /**
   * 该内容类型当前生效的 chars/token。
   * @param {'cjk'|'ascii'|'mixed'} kind
   * @returns {number}
   */
  cpt(kind) {
    const hit = this.calibration.get(kind);
    return hit ? hit.cpt : FLOOR_CPT;
  }

  /**
   * 估算 token 数。
   * @param {string} text
   * @param {{kind?: 'cjk'|'ascii'|'mixed'}} [opts]
   * @returns {number} 向上取整的非负整数
   */
  estimate(text, opts = {}) {
    const s = String(text ?? '');
    if (s.length === 0) return 0;
    const kind = opts.kind ?? detectKind(s);
    return Math.max(1, Math.ceil(s.length / this.cpt(kind)));
  }

  /**
   * 估算一段多段文本的合计 token 数（逐段按其自身类型估算）。
   * @param {Iterable<string>} texts
   * @returns {number}
   */
  estimateAll(texts) {
    let n = 0;
    for (const t of texts) n += this.estimate(t);
    return n;
  }

  /**
   * 用上游真实 usage 回灌标定（§9.6 MUST 1：以 ① 为准）。
   * 采用滚动平均，避免单次异常值主导。
   * @param {{chars: number, actualTokens: number, kind?: 'cjk'|'ascii'|'mixed'}} sample
   * @returns {number} 更新后的 cpt
   */
  recordUsage({ chars, actualTokens, kind }) {
    if (!Number.isFinite(chars) || !Number.isFinite(actualTokens) || chars <= 0 || actualTokens <= 0) {
      throw new Error('recordUsage 需要正的 chars 与 actualTokens');
    }
    const k = kind ?? detectKind('x'.repeat(Math.min(chars, 1)));
    const observed = Math.min(MAX_CPT, Math.max(MIN_CPT, chars / actualTokens));
    const prev = this.calibration.get(k);
    if (!prev) {
      this.calibration.set(k, { cpt: observed, samples: 1 });
    } else {
      const w = 1 / Math.min(prev.samples + 1, 8); // 早期权重高，后期收敛
      const next = prev.cpt * (1 - w) + observed * w;
      this.calibration.set(k, { cpt: Math.min(MAX_CPT, Math.max(MIN_CPT, next)), samples: prev.samples + 1 });
    }
    return this.calibration.get(k).cpt;
  }

  /** @returns {{cpt: Record<string, number>}} 可持久化的快照。 */
  snapshot() {
    const cpt = {};
    for (const [kind, v] of this.calibration) cpt[kind] = v.cpt;
    return { cpt };
  }
}
