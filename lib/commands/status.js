/**
 * 人读状态入口（`/contextvm`）。
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
 * @returns {{registered: boolean, reason?: string, dispose?: Function}}
 */
export function registerStatusCommand(ctx, vm) {
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
        'ContextVM 状态：本会话窗口与预算、索引与状态规模、待处理增量、语义索引状态、容量拒绝计数',
      handler: (invocation) => {
        try {
          return { kind: 'success', text: renderStatus(vm, invocation) };
        } catch (err) {
          // 状态命令自身出错时也要给人可读信息，而不是让 UI 抛栈
          return { kind: 'error', text: `ContextVM 状态读取失败：${String(err?.message ?? err)}` };
        }
      },
    });
    return { registered: true, dispose };
  } catch (err) {
    return { registered: false, reason: String(err?.message ?? err) };
  }
}
