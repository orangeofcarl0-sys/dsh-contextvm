/**
 * 检索用文本归一化（索引与查询共用的唯一实现）。
 *
 * 背景：FTS5 的 `unicode61` 不切分中文（实测中文查询全部落空），`trigram`
 * 虽能查中文但对**两字词**失效（预检 / 中文 / 分词 这类极常见词查不到）。
 * 故采用"CJK 逐字切分 + 整串短语查询"：
 *   - 索引侧：CJK 连续段按单字用空格分开，其余原样 → unicode61 正常分词；
 *   - 查询侧：同一函数归一化后整体加引号作为短语，既保证相邻性，
 *     又避免 `.`/`-` 等被 FTS5 当作查询语法（实测 `1.693` 不加引号会报语法错）。
 *
 * 两处 MUST 调用同一函数；MUST NOT 在查询侧另写一套转义。
 *
 * @module dsh-contextvm/core/text
 */

const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;

/**
 * 归一化为可索引、可匹配的形态。
 * @param {string} s
 * @returns {string}
 */
export function normalizeSearchText(s) {
  const out = [];
  let buf = '';
  const flush = () => {
    if (buf) {
      out.push(buf);
      buf = '';
    }
  };
  for (const ch of String(s ?? '')) {
    if (CJK_RE.test(ch)) {
      flush();
      out.push(ch);
    } else {
      buf += ch;
    }
  }
  flush();
  return out.join(' ');
}

/**
 * 从查询中抽取可检索项。**唯一实现**：FTS 的 MATCH 表达式与摘要检索共用，
 * MUST NOT 在别处再写一套分词/切词逻辑。
 *
 * 规则：
 *   - CJK 段按**二元组**切（`"波 长"`）——索引逐字切分，故二元组短语可精确匹配，
 *     既保住 2 字词语义（预检/分词），又不要求整句连续；
 *   - 单字 CJK 段退化为单字项；
 *   - 非 CJK 段按标点/空白切词。
 *
 * @param {string} query
 * @returns {string[]} 去重后的项（CJK 项内部含空格，供短语匹配）
 */
export function extractTerms(query) {
  const s = String(query ?? '');
  const terms = [];
  let buf = '';
  let bufIsCjk = null;
  const flush = () => {
    if (!buf) return;
    if (bufIsCjk) {
      const chars = [...buf];
      if (chars.length === 1) terms.push(chars[0]);
      else for (let i = 0; i + 1 < chars.length; i += 1) terms.push(`${chars[i]} ${chars[i + 1]}`);
    } else {
      for (const w of buf.split(/[^\p{L}\p{N}_.-]+/u)) {
        if (w) terms.push(w);
      }
    }
    buf = '';
  };
  for (const ch of s) {
    const isCjk = CJK_RE.test(ch);
    if (buf && isCjk !== bufIsCjk) flush();
    buf += ch;
    bufIsCjk = isCjk;
  }
  flush();
  return [...new Set(terms)].filter((t) => t.replace(/\s/g, '').length > 0);
}

/**
 * 构造 FTS5 MATCH 表达式。
 *
 * 关键点：**不得把整条查询当成一个连续短语**。实测踩坑：把
 * "当前架构方案是什么？波长多少？" 整体加引号后，MATCH 要求该字面连续出现，
 * 任何文档都不满足 → 长历史下检索恒为空。
 *
 * @param {string} query
 * @returns {string|null} MATCH 表达式；无可检索项时返回 null
 */
export function toMatchExpression(query) {
  const terms = extractTerms(query);
  if (terms.length === 0) return null;
  return terms.map((t) => '"' + t.replace(/"/g, '""') + '"').join(' OR ');
}
