/**
 * 工具输出的统一契约（§14 / §11.2 / §13.2）。
 *
 * 三个工具模块此前各写了一份 `{ok, result, ...}` 的 schema + render，措辞与字段
 * 略有差异（例如 `truncated` 有的写有的没写）。集中到这里，使"工具结果必须短、
 * 且必须能追溯到 source ids"成为一处定义。
 *
 * @module dsh-contextvm/tools/output
 */

/**
 * @param {object} [extra] 追加的输出字段（会与基础字段合并）
 * @returns {{schema: object, render: (args: any, value: any) => Array<object>}}
 */
export function toolOutput(extra = {}) {
  return {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean', required: true },
        result: { type: 'string', required: true },
        ...extra,
      },
    },
    render: (_args, value) => [{ type: 'text', text: value.result }],
  };
}

/**
 * 可追溯结果的公共字段：来源事件 id 列表 + 是否被截断。
 * 供读取类工具复用，保证三处语义一致（§14：只返回必要内容与 source IDs）。
 */
export const TRACEABLE_FIELDS = Object.freeze({
  source_event_ids: { type: 'array', items: { type: 'string' } },
  truncated: { type: 'boolean' },
});
