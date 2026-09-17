/**
 * 人读状态入口与**会话级开关**（`/contextvm`）。
 *
 * 三种用法：
 *   - `/contextvm`       —— 状态报告（无副作用，保持既有语义）
 *   - `/contextvm on`    —— 为本会话**显式开启**：把工具注册进该会话自己的 agent 作用域，
 *                           并启用注入与轮末抽取。从下一轮起生效。
 *   - `/contextvm off`   —— 关闭本会话：释放工具注册，停止注入与后台抽取（请求零足迹）。
 *
 * 为什么需要显式开关：默认注册 8 个全局工具会让它们的 schema（实测约 1433 token）随每个
 * 会话的请求发送，与用户是否用 ContextVM 无关 —— 这比插件注入的上下文贵一个量级。
 * 改为按会话开启后，污染隔离是结构性的；代价只是这一次显式操作（有意的取舍）。
 *
 * 为什么需要：在此之前 ContextVM 对**人**是完全不可见的 —— 8 个工具都面向模型，
 * 遥测只存在内存里、进程退出即消失，挂载日志在 headless 下也看不到。于是用户无法回答
 * "它到底在工作吗""它记住了什么""为什么这轮没注入"这类问题，只能去问模型，而模型可能编。
 * 这个命令把这些事实直接摆给人看。
 *
 * 纪律：渲染 MUST NOT 抛错（任何一项取不到就如实写"未知"），因为它是排障入口，
 * 一个会抛的状态命令比没有更糟。
 *
 * @module dsh-contextvm/commands/status
 */

import { isSessionActive, setSessionActive, parseSubcommand, MODE_ACTIVE, MODE_DORMANT } from '../app/session_mode.js';

/** 命令名（不含前导斜杠）。 */
export const CONTEXTVM_COMMAND = 'contextvm';

/**
 * 渲染状态报告（纯函数，便于测试）。
 * @param {ReturnType<import('../app/create.js').createContextVm>} vm
 * @param {{agent?: {session?: {id?: string}}}} [invocation]
 * @returns {string}
 */
export function renderStatus(vm, invocation) {
  const lines = ['ContextVM 状态'];
  const sessionId = invocation?.agent?.session?.id ?? null;
  const safe = (fn, fallback = '未知') => {
    try {
      const v = fn();
      return v === null || v === undefined ? fallback : v;
    } catch {
      return fallback;
    }
  };

  // 取不到会话或读库失败时一律写"未知"（排障入口 MUST NOT 把失败说成一种正常模式）
  const active = sessionId ? safe(() => isSessionActive(vm.db, sessionId), '未知') : '未知';
  lines.push(
    active === '未知'
      ? '模式: 未知（取不到会话或读库失败）'
      : active
        ? '模式: 已开启（工具已注册进本会话；注入与轮末抽取生效）—— `/contextvm off` 可关闭'
        : '模式: 休眠（默认）—— 不注册工具、不注入、不做后台抽取；`/contextvm on` 开启',
  );

  // ---- 路由与预算 ----
  const W = sessionId ? safe(() => vm.runtime.window(sessionId), null) : null;
  if (W) {
    const b = safe(() => {
      // 与编译期同源：不重新实现一遍预算算法
      vm.runtime.setWindow(sessionId, W);
      return vm.runtime.compile({ sessionId, query: '__status__' }).tokenCount;
    }, null);
    lines.push(`本会话窗口 W: ${W.toLocaleString()} token`);
    lines.push(`上次编译产物: ${b === null ? '未知' : `${b.toLocaleString()} token`}`);
  } else {
    lines.push('本会话窗口 W: 尚未解析（该会话还没发生过模型调用）');
  }
  lines.push(`插件配置路由（仅作 W 解析失败时的回退）: ${vm.config.route.provider}/${vm.config.route.model}`);

  // ---- 库与规模 ----
  const dbPath = safe(() => vm.db.prepare('PRAGMA database_list').get()?.file, null);
  lines.push(`库文件: ${dbPath || '（内存库 —— 重启即丢失）'}`);
  if (!dbPath) {
    lines.push('  ⚠ 当前未持久化。默认配置应为 <dshHome>/contextvm/contextvm.db；');
    lines.push('    若这里显示内存库，说明 dbPath 被显式设成了 :memory:。');
  }
  if (sessionId) {
    const events = safe(() => vm.raw.count(sessionId), null);
    const tokens = safe(() => vm.raw.totalTokens(sessionId), null);
    lines.push(`索引: 事件 ${events ?? '未知'} 条 / ${tokens === null ? '未知' : tokens.toLocaleString()} token`);
    const st = safe(() => vm.state.stats(sessionId), null);
    if (st) {
      lines.push(
        `状态: active ${st.active} / superseded ${st.superseded} / rejected ${st.rejected} / ` +
          `uncertain ${st.uncertain} / resolved ${st.resolved}`,
      );
    }
    const ep = safe(() => vm.episodes.episodes.stats(sessionId), null);
    if (ep) lines.push(`episode: ${ep.summarized} 已摘要 / ${ep.summary_pending} 待摘要 / ${ep.open} 进行中`);
    const art = safe(() => vm.artifacts.stats(sessionId), null);
    if (art) lines.push(`artifact: ${art.active} 个有效版本`);
    // 队列是全局的、且会跨进程持久化：里面可能躺着已结束会话的残留。
    // 直接报一个非零数字会让用户以为有东西卡住了，故说明其中多少条会在下次维护时清掉。
    const pending = safe(() => vm.runtime.pendingDeltas(), null);
    if (Array.isArray(pending)) {
      const stale = safe(() => pending.filter((e) => !vm.runtime.hasWindow(e.sessionId)).length, 0);
      lines.push(
        `待处理状态增量: ${pending.length} 条` +
          (stale ? `（其中 ${stale} 条属于已结束的会话，下次维护时清理；其 raw 事件仍可检索）` : ''),
      );
    } else {
      lines.push('待处理状态增量: 未知');
    }
  } else {
    lines.push('索引/状态规模: 未知（该命令必须在会话内使用）');
  }

  // ---- 语义索引（§22.3）----
  const sem = safe(() => vm.runtime.semanticStatus(), null);
  lines.push(`语义索引: ${sem ? `${sem.status} —— ${sem.note}` : '未知'}`);

  // ---- 降级与拒绝留痕 ----
  const injectScale = sessionId ? safe(() => vm.runtime.injectionScale(sessionId), null) : null;
  if (injectScale !== null && injectScale < 1) {
    lines.push(`⚠ 注入已收缩到 ${injectScale}（上游曾以容量为由拒绝，见「容量拒绝」计数）`);
  }
  const pf = safe(() => vm.llmClient.preflightLog ?? [], []);
  lines.push(`容量拒绝: 本次进程累计 ${Array.isArray(pf) ? pf.length : '未知'} 次`);

  // ---- 最近一次编译摘要 ----
  const rep = safe(() => vm.telemetry.report(), null);
  if (rep?.context) {
    const byMode = Object.entries(rep.context.by_mode ?? {});
    lines.push(
      `编译统计: ${rep.context.compiles} 次` +
        (byMode.length ? `（${byMode.map(([k, v]) => `${k} ${v}`).join(' / ')}）` : '') +
        `，平均 ${rep.context.avg_token_count === null ? '未知' : Math.round(rep.context.avg_token_count)} token`,
    );
  }

  lines.push('');
  lines.push('提示：普通追问无需干预；要求「全部/无遗漏/查矛盾」时模型会调用穷举扫描工具。');
  return lines.join('\n');
}

/**
 * 注册命令。
 * @param {any} ctx
 * @param {ReturnType<import('../app/create.js').createContextVm>} vm
 * @param {{activate?: Function, deactivate?: Function, toolsActive?: Function}} [deps]
 *   会话级工具生命周期（来自 applySeams）。缺失时开关仍会改模式，但会如实说明工具未注册。
 * @returns {{registered: boolean, reason?: string, dispose?: Function}}
 */
export function registerStatusCommand(ctx, vm, deps = {}) {
  // MUST 经 **root ctx 的 `ctx.commands`** 注册，才进入全局命令列表。
  // 生态既有约定：dsh-fresh-start 的源码注释即写明"命令须在 root ctx 用 ctx.commands.register
  // 注册才进入全局命令列表"，它也是这么做的。
  //
  // 真机缺陷（web 交互审计发现）：此前用的是 `ctx.get('commands')` —— 拿到的是远程代理，
  // `register` **不抛错却注册不进全局表**。于是挂载日志写着"命令 /contextvm"，
  // 而 web 的指令菜单里根本没有它；输入 `/contextvm` 回车会被当成普通消息发给模型。
  // 又一次印证：**不抛错 ≠ 生效**，判定成功必须依据"对方真的拿到了"。
  const commands = ctx?.commands;
  if (!commands || typeof commands.register !== 'function') {
    return { registered: false, reason: '宿主未提供 commands 服务（ctx.commands）' };
  }
  try {
    const dispose = commands.register({
      name: CONTEXTVM_COMMAND,
      description:
        'ContextVM 状态与开关：裸命令看状态；`on` 为本会话开启（注册工具并启用注入/抽取）；`off` 关闭',
      handler: (invocation) => {
        try {
          const sub = parseSubcommand(invocation?.rawInput);
          if (sub === 'invalid') {
            return {
              kind: 'error',
              text: '用法：`/contextvm`（状态）、`/contextvm on`（本会话开启）、`/contextvm off`（关闭）',
            };
          }
          if (sub === 'status') return { kind: 'success', text: renderStatus(vm, invocation) };
          return { kind: 'success', text: toggleSession(vm, invocation, sub === 'on', deps) };
        } catch (err) {
          // 命令自身出错时也要给人可读信息，而不是让 UI 抛栈
          return { kind: 'error', text: `ContextVM 命令执行失败：${String(err?.message ?? err)}` };
        }
      },
    });
    return { registered: true, dispose };
  } catch (err) {
    return { registered: false, reason: String(err?.message ?? err) };
  }
}

/**
 * 开启/关闭某会话。
 *
 * 开启 MUST 真的把工具注册进该会话的 agent 作用域才算成功 —— 只改模式标记而工具没注册，
 * 会出现"模式说已开启、模型却调不到工具"的假象。故以注册结果为准，失败即如实回报。
 *
 * @param {ReturnType<import('../app/create.js').createContextVm>} vm
 * @param {{agent?: any, rawInput?: string}} invocation
 * @param {boolean} on
 * @param {{activate?: Function, deactivate?: Function}} deps
 * @returns {string}
 */
export function toggleSession(vm, invocation, on, deps = {}) {
  const sessionId = invocation?.agent?.session?.id ?? null;
  if (!sessionId) return '无法确定会话：请在本会话内执行该命令。';

  if (!on) {
    const released = deps.deactivate?.(sessionId)?.released ?? 0;
    setSessionActive(vm.db, sessionId, false);
    return `已关闭本会话的 ContextVM：释放 ${released} 个工具注册，停止注入与后台抽取。\n` +
      '（索引与状态仍在库中，可随时用 `/contextvm on` 重新开启。）';
  }

  const res = deps.activate?.(invocation.agent) ?? { ok: false, registered: [], reason: '宿主未提供工具生命周期' };
  if (!res.ok) {
    // 不写"已开启"：工具没注册上，开了也只是假象
    return `未能开启：${res.reason ?? '未知原因'}。\n` +
      '工具 MUST 注册进本会话的 agent 作用域；未注册时不注入输出契约（否则模型会去调用不存在的工具）。';
  }
  setSessionActive(vm.db, sessionId, true);
  return (
    `已开启本会话的 ContextVM：注册 ${res.registered.length} 个工具（仅本会话可见）。\n` +
    '从下一轮起注入权威状态与证据，并在轮末做状态抽取。\n' +
    '工具：' + res.registered.join(', ')
  );
}
