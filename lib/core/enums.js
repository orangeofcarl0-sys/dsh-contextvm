/**
 * 全部受控词表。一次定死，各阶段只读不改（§4.1 / §4.2 / §4.3 / §8）。
 * @module dsh-contextvm/core/enums
 */

/** raw event 类型（§4.1）。 */
export const EVENT_TYPES = Object.freeze([
  'user_message',
  'assistant_message',
  'tool_request',
  'tool_result',
  'artifact_created',
  'artifact_updated',
  'system_note',
  'state_delta',
]);

/** 状态项类型（§4.2）。 */
export const ITEM_TYPES = Object.freeze([
  'goal',
  'constraint',
  'fact',
  'decision',
  'assumption',
  'rejected_option',
  'open_question',
  'resolved_question',
  'artifact_state',
  'plan_step',
  'next_action',
  'preference',
]);

/** 状态项状态（§4.2）。 */
export const ITEM_STATUSES = Object.freeze([
  'active',
  'superseded',
  'resolved',
  'rejected',
  'uncertain',
  'archived',
]);

/** 上下文读取模式（§8）。 */
export const CONTEXT_MODES = Object.freeze(['LOCAL', 'BROAD', 'GLOBAL']);

/**
 * 触发 GLOBAL 的语义标记（§8.3）。命中即 MUST 走高概率 GLOBAL，
 * MUST NOT 仅用 top-k RAG 给出"完整"结论。
 */
export const GLOBAL_MARKERS = Object.freeze([
  '全部',
  '所有',
  '完整检查',
  '有没有遗漏',
  '是否遗漏',
  '不要漏',
  '不要遗漏',
  '逐一核对',
  '逐条核对',
  '检查所有',
  '列出所有',
  '遍历',
  '穷举',
  'any missing',
  'all of the',
  'list every',
  'exhaustive',
  'every single',
]);

/** 提示 BROAD 的语义标记（§8.2）。 */
export const BROAD_MARKERS = Object.freeze([
  '以前',
  '之前讨论',
  '回顾',
  '之前说',
  '历史上',
  '哪几个阶段',
  '哪些决定',
  'earlier',
  'previously',
  'recall',
]);

/** 命中即提高 lexical/exact 权重的元素（§7.2）。 */
export const EXACT_FIRST_PATTERNS = Object.freeze([
  /\d+(?:\.\d+)?\s*(?:k|m|hz|khz|mhz|ghz|nm|um|mm|ms|s|%|℃|°c)?/i, // 数字与频率/波长/单位
  /\b\d{4}-\d{2}-\d{2}\b/, // 日期
  /[\w./\\-]+\.(?:js|mjs|ts|py|md|json|yaml|yml|txt|csv|sql)\b/i, // 文件名
  /\b[a-z_][a-z0-9_]*\(\)/i, // 函数名
  /(?:\b[A-Z][a-zA-Z]*){2,}\b/, // CamelCase 标识符
  // 连字符/下划线 ID（如 union-alpha、hard_input_cap、dsh-contextvm）
  /\b[a-z][a-z0-9]*(?:[-_][a-z0-9]+)+\b/,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i, // UUID
  /["“”'][^"“”']{2,}["“”']/, // 引号原话
  /\b(?:ERR|ERROR|ENOENT|EACCES|EPERM|TypeError|ReferenceError)\b/, // error message
]);

export const EVENT_TYPE_SET = new Set(EVENT_TYPES);
export const ITEM_TYPE_SET = new Set(ITEM_TYPES);
export const ITEM_STATUS_SET = new Set(ITEM_STATUSES);
export const CONTEXT_MODE_SET = new Set(CONTEXT_MODES);
