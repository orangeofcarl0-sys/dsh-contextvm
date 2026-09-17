/**
 * LLM 输出 schema 与校验（§5.3 / §11.2 / §6.2 / §27.3）。
 *
 * §27.3：所有 LLM 输出都是不可信输入，MUST 校验。§13.1 的结论是
 * 宿主缝不暴露 `response_format`，服务端不提供任何结构保证，
 * 因此**本地校验是唯一防线**，且必须覆盖四类失败：
 * 字段缺失、类型错误、幻觉字段、JSON 语法错误。
 *
 * @module dsh-contextvm/llm/schemas
 */
import { ITEM_STATUS_SET, ITEM_TYPE_SET } from '../core/enums.js';

/**
 * 从可能夹带说明文字的响应中提取 JSON 对象（覆盖"JSON 语法错误"这一类）。
 * 策略：先整体解析；失败则取第一个平衡的 `{...}` 块；再失败则返回 null。
 * @param {string} text
 * @returns {{value: any|null, error: string|null}}
 */
export function parseJsonLoose(text) {
  const s = String(text ?? '').trim();
  if (!s) return { value: null, error: 'empty' };
  try {
    return { value: JSON.parse(s), error: null };
  } catch {
    /* 继续尝试提取 */
  }
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [];
  if (fenced) candidates.push(fenced[1]);
  const balanced = scanBalancedJson(s);
  if (balanced) candidates.push(balanced);

  for (const c of candidates) {
    try {
      return { value: JSON.parse(c), error: null };
    } catch {
      /* 试下一个 */
    }
  }
  return { value: null, error: 'no_parseable_json' };
}

/**
 * 从首个 `{` 起扫描出一个**括号配平**的 JSON 对象子串。
 *
 * 单独成函数的原因：这是字符级状态机（要正确处理字符串内的括号与转义），
 * 是本模块唯一有深控制流的地方；抽出来后可单独测试，`parseJsonLoose` 也只剩编排。
 *
 * @param {string} s 已 trim 的文本
 * @returns {string|null} 配平的子串；不存在或未闭合时返回 null
 */
export function scanBalancedJson(s) {
  const start = s.indexOf('{');
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i += 1) {
    const ch = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null; // 未闭合：调用方会落到 no_parseable_json
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * 校验并规范化 State Delta（§5.2）。
 *
 * 返回规范化后的对象（丢掉幻觉字段，保证后续代码只见到已知形状），
 * 以及错误列表。**有错即拒**，不做"尽力而为"的部分采纳：
 * 部分采纳会让状态与模型意图不一致，比直接重试更危险。
 *
 * @param {any} raw
 * @returns {{ok: boolean, errors: string[], delta: object|null}}
 */
export function validateDelta(raw) {
  const errors = [];
  if (!isPlainObject(raw)) return { ok: false, errors: ['not_an_object'], delta: null };

  const out = { upsert: [], supersede: [], resolve: [], open: [], next_action: null };

  const asArray = (v, field) => {
    if (v === undefined || v === null) return [];
    if (Array.isArray(v)) return v;
    errors.push(`${field}_not_array`);
    return [];
  };

  for (const [i, item] of asArray(raw.upsert ?? raw.upserts, 'upsert').entries()) {
    if (!isPlainObject(item)) {
      errors.push(`upsert[${i}]_not_object`);
      continue;
    }
    if (!ITEM_TYPE_SET.has(item.type)) {
      errors.push(`upsert[${i}]_bad_type:${item.type}`);
      continue;
    }
    if (item.value === undefined) {
      errors.push(`upsert[${i}]_missing_value`);
      continue;
    }
    const status = item.status ?? 'active';
    if (!ITEM_STATUS_SET.has(status)) {
      errors.push(`upsert[${i}]_bad_status:${status}`);
      continue;
    }
    const src = item.source_event_ids ?? item.sourceEventIds;
    if (src !== undefined && !Array.isArray(src)) {
      errors.push(`upsert[${i}]_source_not_array`);
      continue;
    }
    out.upsert.push({
      type: item.type,
      key: typeof item.key === 'string' && item.key.length > 0 ? item.key : null,
      value: item.value,
      status,
      confidence: typeof item.confidence === 'number' ? item.confidence : null,
      sourceEventIds: (src ?? []).filter((s) => typeof s === 'string'),
    });
  }

  for (const [i, item] of asArray(raw.supersede, 'supersede').entries()) {
    const stateId = typeof item === 'string' ? item : item?.state_id ?? item?.stateId;
    if (typeof stateId !== 'string' || !stateId) {
      errors.push(`supersede[${i}]_missing_state_id`);
      continue;
    }
    out.supersede.push({ stateId, reason: (isPlainObject(item) && item.reason) || 'unspecified' });
  }

  for (const [i, item] of asArray(raw.resolve, 'resolve').entries()) {
    const stateId = typeof item === 'string' ? item : item?.state_id ?? item?.stateId;
    if (typeof stateId !== 'string' || !stateId) {
      errors.push(`resolve[${i}]_missing_state_id`);
      continue;
    }
    out.resolve.push(stateId);
  }

  for (const [i, item] of asArray(raw.open, 'open').entries()) {
    if (!isPlainObject(item) || item.value === undefined) {
      errors.push(`open[${i}]_invalid`);
      continue;
    }
    const type = item.type ?? 'open_question';
    if (!ITEM_TYPE_SET.has(type)) {
      errors.push(`open[${i}]_bad_type:${type}`);
      continue;
    }
    const src = item.source_event_ids ?? item.sourceEventIds;
    out.open.push({
      type,
      key: typeof item.key === 'string' ? item.key : null,
      value: item.value,
      sourceEventIds: Array.isArray(src) ? src.filter((s) => typeof s === 'string') : [],
    });
  }

  const na = raw.next_action ?? raw.nextAction;
  if (na !== undefined && na !== null) {
    if (typeof na !== 'string') errors.push('next_action_not_string');
    else out.next_action = na.trim().slice(0, 500);
  }

  // 幻觉字段检测：顶层只允许已知键
  const known = new Set(['upsert', 'upserts', 'supersede', 'resolve', 'open', 'next_action', 'nextAction']);
  for (const k of Object.keys(raw)) {
    if (!known.has(k)) errors.push(`unknown_field:${k}`);
  }

  // next_action 保持为顶层字段，MUST NOT 同时合成进 open：
  // 同一信息两处表示会让"谁负责落库"变得含糊。落库由 applyDelta 显式处理。
  return { ok: errors.length === 0, errors, delta: out };
}

/**
 * Episode Summary 契约（§6.2 / §6.3）。
 *
 * MUST NOT 把 assumption 升格为 fact：故 confirmed_decisions 与 open_questions
 * 分开，且没有"事实"字段 —— 事实只存在于 raw 与 state 里，摘要只做导航。
 *
 * @param {any} raw
 * @returns {{ok: boolean, errors: string[], summary: object|null}}
 */
export function validateEpisodeSummary(raw) {
  const errors = [];
  if (!isPlainObject(raw)) return { ok: false, errors: ['not_an_object'], summary: null };

  const strArrays = {};
  for (const f of [
    'what_changed',
    'confirmed_decisions',
    'constraints_added_or_changed',
    'rejected_options',
    'open_questions',
    'artifacts_touched',
    'important_numbers_or_identifiers',
    'search_keywords',
  ]) {
    const v = raw[f];
    if (v === undefined || v === null) {
      strArrays[f] = [];
      continue;
    }
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' && typeof x !== 'number')) {
      errors.push(`${f}_not_string_array`);
      continue;
    }
    strArrays[f] = v.map((x) => String(x));
  }

  for (const f of ['topic', 'goal']) {
    if (raw[f] !== undefined && raw[f] !== null && typeof raw[f] !== 'string') errors.push(`${f}_not_string`);
  }

  const range = raw.source_event_range;
  if (range !== undefined && range !== null) {
    const ok = isPlainObject(range) && typeof range.start_event === 'string' && typeof range.end_event === 'string';
    if (!ok) errors.push('source_event_range_invalid');
  }

  if (errors.length) return { ok: false, errors, summary: null };
  return {
    ok: true,
    errors: [],
    summary: {
      topic: (raw.topic ?? '').toString().slice(0, 200),
      goal: (raw.goal ?? '').toString().slice(0, 300),
      whatChanged: strArrays.what_changed.slice(0, 8),
      confirmedDecisions: strArrays.confirmed_decisions.slice(0, 8),
      constraintsAddedOrChanged: strArrays.constraints_added_or_changed.slice(0, 8),
      rejectedOptions: strArrays.rejected_options.slice(0, 6),
      openQuestions: strArrays.open_questions.slice(0, 6),
      artifactsTouched: strArrays.artifacts_touched.slice(0, 6),
      importantNumbersOrIdentifiers: strArrays.important_numbers_or_identifiers.slice(0, 12),
      sourceEventRange:
        range === undefined || range === null
          ? null
          : { startEvent: range.start_event, endEvent: range.end_event },
      searchKeywords: strArrays.search_keywords.slice(0, 10),
    },
  };
}

/** 把结构化摘要渲染为导航文本（稳定、紧凑、供模型阅读）。 */
export function renderEpisodeSummary(s) {
  const lines = [];
  if (s.topic) lines.push(`topic: ${s.topic}`);
  if (s.goal) lines.push(`goal: ${s.goal}`);
  const add = (label, arr) => {
    if (arr.length) lines.push(`${label}: ${arr.join(' | ')}`);
  };
  add('what_changed', s.whatChanged);
  add('confirmed_decisions', s.confirmedDecisions);
  add('constraints_added_or_changed', s.constraintsAddedOrChanged);
  add('rejected_options', s.rejectedOptions);
  add('open_questions', s.openQuestions);
  add('artifacts_touched', s.artifactsTouched);
  add('important_numbers_or_identifiers', s.importantNumbersOrIdentifiers);
  add('search_keywords', s.searchKeywords);
  if (s.sourceEventRange) lines.push(`source_event_range: ${s.sourceEventRange.startEvent}..${s.sourceEventRange.endEvent}`);
  return lines.join('\n');
}

/**
 * Worker 输出契约（§11.2）。Phase C 使用；此处先提供同一套校验，
 * 以免 Phase C 另写一份形状不同的解析。
 * @param {any} raw
 * @returns {{ok: boolean, errors: string[], result: object|null}}
 */
export function validateWorkerResult(raw) {
  const errors = [];
  if (!isPlainObject(raw)) return { ok: false, errors: ['not_an_object'], result: null };
  const findings = [];
  for (const [i, f] of (Array.isArray(raw.findings) ? raw.findings : []).entries()) {
    if (!isPlainObject(f) || typeof f.claim !== 'string') {
      errors.push(`findings[${i}]_invalid`);
      continue;
    }
    const src = f.source_event_ids ?? f.sourceEventIds;
    if (!Array.isArray(src) || src.length === 0) {
      errors.push(`findings[${i}]_missing_source`);
      continue;
    }
    findings.push({
      claim: f.claim,
      sourceEventIds: src,
      category: ['constraint', 'decision', 'conflict', 'evidence', 'missing'].includes(f.category) ? f.category : 'evidence',
      relevance: typeof f.relevance === 'number' ? f.relevance : 0.5,
      conflictWith: Array.isArray(f.conflict_with) ? f.conflict_with : [],
    });
  }
  const cov = raw.coverage;
  if (!isPlainObject(cov) || typeof cov.start_event !== 'string' || typeof cov.end_event !== 'string') {
    errors.push('coverage_invalid');
    return { ok: false, errors, result: null };
  }
  return {
    ok: errors.length === 0,
    errors,
    result: {
      findings,
      coverage: { startEvent: cov.start_event, endEvent: cov.end_event, complete: cov.complete === true },
    },
  };
}
