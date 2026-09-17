/**
 * 状态提交工具（§13.2 的工具路径）。
 *
 * 为什么不是"第二次短调用"：低 TPS 下每加一次串行 decode 都直接加关键路径延迟
 * （§2.2 / §13.2）。工具路径的参数即 §5.2 的 delta 结构，模型在回答的同时提交，
 * 零额外串行成本。
 *
 * 本模块只**收集**参数；校验与应用统一走 memory/delta.js 与 llm/schemas.js，
 * MUST NOT 在这里再写一遍校验。
 *
 * @module dsh-contextvm/tools/commit_state
 */
import { DELTA_TOOL } from '../llm/prompts.js';
import { toolOutput } from './output.js';

const ITEM_TYPE_ENUM = [
  'goal', 'constraint', 'fact', 'decision', 'assumption',
  'rejected_option', 'open_question', 'preference', 'artifact_state', 'plan_step',
];

/** 把 DELTA_TOOL 的 JSON-schema 转成宿主 defineTool 的 parameters 规格。 */
export function deltaParametersSpec() {
  const p = DELTA_TOOL.parameters.properties;
  const itemSpec = {
    type: 'object',
    additionalProperties: true,
    properties: {
      type: { type: 'string', enum: ITEM_TYPE_ENUM, required: true },
      key: { type: 'string' },
      value: { type: 'string', required: true },
      status: { type: 'string', enum: ['active', 'uncertain'] },
      source_event_ids: { type: 'array', items: { type: 'string' } },
    },
  };
  return {
    upsert: { type: 'array', items: itemSpec, description: p.upsert.items.description ?? '新增或变化的项' },
    supersede: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: true,
        properties: { state_id: { type: 'string', required: true }, reason: { type: 'string' } },
      },
    },
    resolve: { type: 'array', items: { type: 'string' } },
    open: { type: 'array', items: itemSpec },
    next_action: { type: 'string' },
  };
}

/**
 * 生成工具定义（供 ctx.tools.register 使用）。
 * @param {import('../app/runtime.js').Runtime} runtime
 * @param {{defineTool: Function}} deps 由宿主包注入的 defineTool
 */
export function commitStateTool(runtime, deps) {
  const { defineTool } = deps;
  return defineTool({
    name: DELTA_TOOL.name,
    description: DELTA_TOOL.description,
    parameters: deltaParametersSpec(),
    output: toolOutput({
      applied_upserts: { type: 'number' },
      applied_superseded: { type: 'number' },
      rejected: { type: 'number' },
    }),
    async execute(args, exec) {
      const sessionId = exec?.session?.id ?? exec?.agent?.session?.id;
      if (!sessionId) {
        return { ok: false, result: '无法确定会话，未应用增量。', applied_upserts: 0, applied_superseded: 0, rejected: 0 };
      }
      const res = await runtime.applySubmittedDelta({ sessionId, rawDelta: args });
      if (!res.ok) {
        return {
          ok: false,
          result: `增量未通过校验（${res.reason}），请修正后重试：${(res.rejected ?? []).map((r) => r.reason).join('; ')}`,
          applied_upserts: 0,
          applied_superseded: 0,
          rejected: (res.rejected ?? []).length,
        };
      }
      const a = res.applied;
      return {
        ok: true,
        result:
          `已记录状态增量：新增 ${a.upserts.length}，取代 ${a.superseded.length}，` +
          `已解决 ${a.resolved.length}，待确认 ${a.uncertain.length}` +
          (res.rejected.length ? `，被拒 ${res.rejected.length}（${res.rejected.map((r) => r.reason).join(';')}）` : ''),
        applied_upserts: a.upserts.length,
        applied_superseded: a.superseded.length,
        rejected: res.rejected.length,
      };
    },
  });
}
