/**
 * 工具执行上下文的读取（§13.2 / §14）。
 *
 * 实机核对（tools/host-contract-audit.mjs）：宿主的 `ToolExecutionInput` 只有
 * `agent?: Agent`，**没有 `session` 字段**；会话必须经 `agent.session` 取。
 *
 * 因此这个访问器只有一处实现 —— 早期三个工具模块各写了一份
 * `exec?.session?.id ?? exec?.agent?.session?.id`，其中前半段永远取不到值，
 * 是靠后半段兜底才"碰巧能用"；这种写法在假宿主测试里看不出问题
 * （测试喂的正是宿主不会产生的形状）。
 *
 * @module dsh-contextvm/tools/exec
 */

/**
 * 从工具执行上下文里取会话 id。
 * @param {{agent?: {session?: {id?: string}}}} [exec] 宿主的 ToolRunContext
 * @returns {string|null} 取不到时返回 null，由调用方明确报错而不是静默兜底
 */
export function sessionIdOf(exec) {
  return exec?.agent?.session?.id ?? null;
}
