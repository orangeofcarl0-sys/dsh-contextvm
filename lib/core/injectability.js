/**
 * 事件能否作为"对话内容"注入（§4.1 / §7.1 / §9.2）。
 *
 * 背景（真机实测）：宿主会把**自己管理的上下文**写进 session surface ——
 * `Current runtime context` 快照（实测单条最大 5499 token）与技能目录
 * （`<system-reminder>`，483 token）。§4.1 的判定已把它们正确归类为 `system_note`
 * （不再冒充用户消息、authority 正确），但**归类不等于不注入**：它们照样原样进入
 * recent verbatim、照样参与证据打分。实测某个会话镜像内容的 **98%** 是它们，
 * 于是注入的 5860 token 里只有 31 token 是真正的权威状态，榜首证据甚至是
 * 「技能目录 + 运行时快照 + 我们自己的记账事件」这种完全不含对话内容的组合。
 *
 * 宿主自己每轮都会发这些（同一次会话里出现多份快照即是证据），我们再注入一遍
 * 只是重复占用稀缺窗口，并稀释真正的证据。
 *
 * 判定方向是**黑名单**（已知的宿主托管形态不注入，其余照常注入），与 §4.1 的
 * 反转判定方向相反 —— 因为这里两种错的代价不对称：
 *   - 误把宿主样板当内容注入：浪费预算，有界且可见；
 *   - 误把真实内容当样板丢掉：静默丢失内容，不可接受。
 * 故未知形态一律按"可注入"处理。
 *
 * @module dsh-contextvm/core/injectability
 */

/**
 * 宿主托管的上下文形态（ContextForm）。这两个是实测到的：
 * 运行时上下文快照与技能目录。
 */
export const HOST_MANAGED_FORMS = Object.freeze(['snapshot', 'catalog']);

/**
 * 宿主托管的来源 kind（MessageSourceMap）。`skill-catalog` 是宿主为技能目录登记的
 * kind（merge-extensible 词汇表里的一个），`plugin` 是插件注入的上下文。
 * 与 `HOST_MANAGED_FORMS` 取并集判定：任一命中即视为宿主托管。
 */
export const HOST_MANAGED_KINDS = Object.freeze(['plugin', 'skill-catalog']);

/**
 * 我们自己的记账事件类型：`state_delta` 只记录"哪些 state id 被写入"，
 * 供 raw 层可追溯（§4.1）。它是给审计看的元数据，对模型毫无意义，
 * 却被当成 assistant 消息注入并参与打分 —— 故排除。
 */
export const BOOKKEEPING_EVENT_TYPES = Object.freeze(['state_delta']);

/** 安全解析 metadata（库里存的是 JSON 文本，损坏时按"无元数据"处理）。 */
export function parseEventMetadata(raw) {
  const asObject = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  if (!raw) return {};
  if (typeof raw === 'object') return asObject(raw);
  try {
    return asObject(JSON.parse(raw));
  } catch {
    return {};
  }
}

/**
 * 判定一个事件的可注入性。
 *
 * @param {string} eventType
 * @param {object|string|null} [metadata] metadata 对象或其 JSON 文本
 * @returns {'content'|'host_managed'|'bookkeeping'} content 表示可作为对话内容注入
 */
export function injectability(eventType, metadata) {
  if (BOOKKEEPING_EVENT_TYPES.includes(eventType)) return 'bookkeeping';
  const meta = parseEventMetadata(metadata);
  if (eventType === 'system_note') {
    if (HOST_MANAGED_FORMS.includes(meta.contextForm)) return 'host_managed';
    if (HOST_MANAGED_KINDS.includes(meta.sourceKind)) return 'host_managed';
  }
  return 'content';
}

/** 便捷判定：是否可作为对话内容注入。 */
export function isInjectableContent(eventType, metadata) {
  return injectability(eventType, metadata) === 'content';
}
