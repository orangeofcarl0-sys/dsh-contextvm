/**
 * 宿主缝适配 —— 事件→运行时的唯一转发处（§21.6）。
 *
 * 纪律：本模块只做三件事——取会话、解析 W、把结果交给 Runtime。
 * MUST NOT 在这里重写编译/检索/校验流程，否则与 Runtime 形成两套顺序。
 *
 * 已知宿主约束（实测，2026-09-17）：
 *   - `llm/stream` 的 loop 请求 deep-frozen，只读不可改写，故本插件不改写请求，
 *     只经 `system-prompt/assemble` 注入；
 *   - 历史缩减的唯一持久手段是 session surface 或 ctx.compaction，
 *     Phase A 不触碰（见规范 §21.6）；
 *   - `agent/request-error` 是唯一能"收缩后重试"的钩子（§9.1.1）。
 *
 * @module dsh-contextvm/host/seams
 */
import { parsePreflightError } from '../llm/client.js';
import { commitStateTool } from '../tools/commit_state.js';
import { exhaustiveScanTool } from '../tools/exhaustive_scan.js';
import { memoryTools } from '../tools/memory_tools.js';

/**
 * ContentBlock[] → 文本。不回传/不使用 CoT（§1.3）：reasoning 块一律丢弃。
 * @param {any} content
 * @returns {string}
 */
export function blocksToText(content) {
  if (typeof content === 'string') return content;
  if (content == null) return '';
  if (!Array.isArray(content)) return JSON.stringify(content);
  return content
    .map((b) => {
      if (typeof b === 'string') return b;
      switch (b?.type) {
        case 'text':
          return b.text ?? '';
        case 'reasoning':
          return ''; // 显式丢弃：本系统不依赖隐藏推理状态（§1.3 / §27.4）
        case 'image':
          return '[image]';
        case 'tool_use':
          return `[tool_use ${b.name ?? ''}] ${JSON.stringify(b.input ?? {})}`;
        case 'tool_result':
          return `[tool_result] ${blocksToText(b.content)}`;
        default:
          return '';
      }
    })
    .filter((s) => s.length > 0)
    .join('\n');
}

/**
 * 宿主 SessionEvent → 索引事件。非 surface 事件返回 null（不入索引）。
 * 只有这一处做映射；不得在别处再写一份。
 * @param {object} event
 * @returns {{role: string, eventType: string, content: string}|null}
 */
/**
 * 一条宿主消息的来源分类（实机核对：`MessageSourceMap` 的 kind 为
 * `user` / `plugin` / `model` / `tool`，其中 plugin 还带 `form`）。
 *
 * 为什么必须区分：真机跑下来发现宿主会把**自己注入的合成上下文**也以 user 角色
 * 写进 surface。实测到的三例：`Current runtime context` 快照（单条 361 → 28,000+ token
 * 不等）、以及 `<system-reminder>` 技能目录（`kind: 'skill-catalog'`，845 token）。
 * 若一律记成 `user_message`，这些样板会：
 *   1) 以最高 authority（§16.1 的用户指令）参与检索打分；
 *   2) 挤占 recent verbatim 预算（§9.2 仅 0.135W）；
 *   3) 让"用户到底说过什么"变得不可信。
 *
 * **判定方向很关键**：用白名单（只认 plugin/model/tool）是错的 —— 宿主文档写明
 * `kind` 是 merge-extensible 的，插件可自行登记新 kind（`skill-catalog` 就是这样冒出来的），
 * 白名单注定落后。故反过来判定：**只有 `kind === 'user'` 才是用户消息，其余一律算注入上下文**。
 * 缺 `kind` 时按用户消息处理（手搓/旧版事件的兼容面）。
 *
 * @param {{type?: string, data?: any}} event
 * @returns {{role: string, eventType: string, form: string|null, kind: string|null}|null}
 */
export function classifyEvent(event) {
  const source = event?.data?.message?.source ?? event?.data?.source ?? null;
  const kind = source?.kind ?? null;
  const form = source?.form ?? null;

  switch (event?.type) {
    case 'tool/result':
      return { role: 'user', eventType: 'tool_result', form: null, kind };
    case 'system/message':
      return { role: 'system', eventType: 'system_note', form: null, kind };
    case 'assistant/message':
      return { role: 'assistant', eventType: 'assistant_message', form: null, kind };
    case 'user/message':
      if (kind !== null && kind !== 'user') {
        return { role: 'system', eventType: 'system_note', form, kind };
      }
      return { role: 'user', eventType: 'user_message', form: null, kind };
    default:
      return null;
  }
}

export function mapSessionEvent(event) {
  const classified = classifyEvent(event);
  if (!classified) return null;
  const data = event?.data ?? {};
  const content =
    event?.type === 'assistant/message' ? blocksToText(data.message?.content) : blocksToText(data.content);
  return {
    role: classified.role,
    eventType: classified.eventType,
    content,
    metadata: { sourceKind: classified.kind ?? null, ...(classified.form ? { contextForm: classified.form } : {}) },
  };
}

/** 稳定的事件 id：同一 seq 反复读到只会索引一次（幂等）。 */
export function hostEventId(sessionId, seq) {
  return `host:${sessionId}:${seq}`;
}

/**
 * 取本轮的 query 与 answer（最后一条 user 消息及其后的最后一条 assistant 消息）。
 * @param {Array<object>} events
 * @returns {{query: string, answer: string, eventIds: string[]}}
 */
export function lastTurn(events) {
  let query = '';
  let answer = '';
  let lastUserIdx = -1;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i].type === 'user/message') {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx >= 0) {
    query = blocksToText(events[lastUserIdx].data?.content);
    for (let i = events.length - 1; i > lastUserIdx; i -= 1) {
      if (events[i].type === 'assistant/message') {
        answer = blocksToText(events[i].data?.message?.content);
        break;
      }
    }
  }
  return { query, answer, eventIds: [] };
}

/**
 * 缝之间共享的状态。
 *
 * 五条缝各自需要"记录警告 + 读写每会话缓存"，把这份状态集中在一个对象里，
 * 使每条缝成为独立可读的工厂函数，而不是共享一堆闭包变量。
 */
function createSeamContext(ctx, vm, deps) {
  return {
    ctx,
    vm,
    runtime: vm.runtime,
    logger: deps.logger ?? (() => {}),
    warnings: [],
    registered: [],
    /** @type {Map<string, number>} `${provider}/${model}` → contextWindow */
    windowCache: new Map(),
    /** @type {Map<string, number>} `${sessionId}:${turn}` → 已收缩重试次数 */
    shrinkAttempts: new Map(),
  };
}

/** 把一条宿主 surface 事件镜像进索引（幂等：同一 seq 只写一次）。 */
export function mirrorHostEvent(ctx, vm, session, event) {
  const mapped = mapSessionEvent(event);
  if (!mapped || mapped.content.length === 0) return;
  const sessionId = session.id;
  const eventId = hostEventId(sessionId, event.seq);
  if (vm.raw.has(eventId)) return;
  vm.raw.append({
    sessionId,
    eventId,
    role: mapped.role,
    eventType: mapped.eventType,
    content: mapped.content,
    createdAt: new Date(event.time ?? Date.now()).toISOString(),
    // 一并留下来源 kind/form：宿主注入的上下文与真实用户输入在日志里同为 user 角色，
    // 只有这两个字段能区分（真机实测：`Current runtime context` 快照单条可达 27k token）。
    metadata: { hostSeq: event.seq, hostType: event.type, ...(mapped.metadata ?? {}) },
  });
}

// ---------------- 1. 镜像宿主事件（§4.1 / §18.3） ----------------

function makeMirrorHandler(seam) {
  return (session, event) => {
    try {
      mirrorHostEvent(seam.ctx, seam.vm, session, event);
    } catch (err) {
      seam.logger('warn', `contextvm: 镜像事件失败 ${String(err?.message ?? err)}`);
    }
  };
}

// ---------------- 2. 注入编译产物（§9.5 / §21.6） ----------------

async function resolveWindow(seam, session, signal) {
  const llm = seam.ctx.get?.('llm');
  if (!llm) return null;
  // W 按当次路由解析；会话中途换模型也能跟上（§2.1 MUST）
  // 注意：EpochHeader 的形状是 `{ config: { provider, model, ... }, tools? }`，
  // provider/model **不在顶层**。早期实现直接读 header.provider，永远取到 undefined，
  // 于是静默回退到插件配置的路由 —— 会话实际跑在别的模型上时预算就算错了。
  const header = session.requestHeader?.();
  const provider = header?.config?.provider ?? seam.vm.config.route.provider;
  const model = header?.config?.model ?? seam.vm.config.route.model;
  const key = `${provider}/${model}`;
  const cached = seam.windowCache.get(key);
  if (cached) return cached;
  const info = await llm.resolveModelInfo(provider, model, signal);
  const W = info?.contextWindow ?? info?.context?.contextWindow;
  if (!Number.isFinite(W) || W <= 0) return null;
  seam.windowCache.set(key, W);
  return W;
}

function makeAssembleHandler(seam) {
  return async (assembly, context, next) => {
    const out = await next();
    const session = context?.agent?.session;
    if (!session) return out; // 诊断路径无 agent：MUST 直接放行（宿主契约）
    try {
      const W = await resolveWindow(seam, session, context?.signal);
      if (!W) {
        seam.warnings.push('无法解析路由窗口（llm 服务缺失或 modelInfo 无 contextWindow）：本轮不注入');
        return out;
      }
      const sessionId = session.id;
      seam.runtime.setWindow(sessionId, W);

      const compiled = seam.runtime.compile({
        sessionId,
        query: seam.runtime.lastUserQuery(sessionId),
        requestedMaxTokens: seam.vm.config.output.default_max_output_tokens,
      });
      // 动态上下文走 contexts 通道（宿主把 sections 视为静态策略，顺序在注册期已定）
      const injected = compiled.renderedSections.map((s) => ({
        name: `contextvm:${s.id}`,
        text: `${s.title}
${s.content}`,
      }));
      if (injected.length === 0) return out;
      return { ...out, contexts: [...out.contexts, ...injected] };
    } catch (err) {
      // 注入失败 MUST NOT 破坏本轮请求：放行原始装配，并明确记录原因
      seam.warnings.push(`注入失败（已放行原始装配）：${String(err?.message ?? err)}`);
      seam.logger('warn', `contextvm: ${seam.warnings.at(-1)}`);
      return out;
    }
  };
}

// ---------------- 3. 容量拒绝 → 收缩注入并重试（§9.1.1 MUST） ----------------

function makeRequestErrorHandler(seam) {
  return async (payload, next) => {
    const pf = parsePreflightError(payload?.failure?.message ?? '');
    const sessionId = payload?.agent?.session?.id;
    if (!pf || !sessionId) return next();

    const key = `${sessionId}:${payload?.turn ?? '?'}`;
    const used = seam.shrinkAttempts.get(key) ?? 0;
    if (used >= seam.vm.config.ratios.preflight_max_retries) {
      seam.logger('warn', `contextvm: 已达收缩重试上限(${used})，交还宿主处理`);
      return next();
    }
    seam.shrinkAttempts.set(key, used + 1);
    const scale = seam.runtime.shrinkInjection(sessionId);
    seam.logger(
      'warn',
      `contextvm: 上游容量拒绝（网关计数 ${pf.gatekeeperTokens ?? '?'} / 上限 ${pf.limit ?? '?'}），` +
        `注入缩放降至 ${scale}，第 ${used + 1} 次重试`,
    );
    return { kind: 'retry' };
  };
}

// ---------------- 4. 轮末：delta / episode / 维护（§15.1 / §15.2 / §22.1） ----------------

function makeTurnStoppingHandler(seam) {
  const { logger, runtime } = seam;
  return (payload) => {
    const session = payload?.agent?.session;
    if (!session) return;
    try {
      const sessionId = session.id;
      const events = session.snapshotEvents?.() ?? [];
      for (const e of events) mirrorHostEvent(seam.ctx, seam.vm, session, e); // 补齐可能漏掉的镜像

      const { query, answer } = lastTurn(events);
      if (answer.trim()) runtime.scheduleDelta({ sessionId, query, answer });

      // episode 推进与摘要是非关键路径（§15.2）：fire-and-forget，
      // 失败只记警告，绝不影响已经产出的回答（§22.2）
      runtime.syncEpisodes({ sessionId }).catch((err) => {
        logger('warn', `contextvm: episode 同步失败（不影响回答）：${String(err?.message ?? err)}`);
      });
      // 维护队列同样非关键路径，且受时间预算约束（§15.2）
      runtime.maintenance
        ?.runDue({ sessionId, runtime }, { maxMs: 1500 })
        .catch((err) => logger('warn', `contextvm: 维护作业失败（不影响回答）：${String(err?.message ?? err)}`));
    } catch (err) {
      logger('warn', `contextvm: 轮末调度失败 ${String(err?.message ?? err)}`);
    }
  };
}

// ---------------- 5. 工具注册（§13.2 / §8.3 / §14） ----------------

/**
 * 注册全部工具。defineTool 来自宿主包、需异步解析，故由调用方在本函数返回后触发。
 * 任一步失败即整体回滚计数，使 registered 始终等于"真正注册成功的工具"。
 */
function registerTools(seam, defineTool) {
  if (typeof defineTool !== 'function') {
    seam.warnings.push('defineTool 不可用：delta 走文本 JSON 路径');
    return { registered: seam.registered };
  }
  if (!seam.ctx.tools || typeof seam.ctx.tools.register !== 'function') {
    seam.warnings.push('ctx.tools 不可用：delta 走文本 JSON 路径');
    return { registered: seam.registered };
  }
  try {
    const tools = [
      commitStateTool(seam.runtime, { defineTool }),
      exhaustiveScanTool(seam.runtime, { defineTool }),
      ...memoryTools(seam.runtime, { defineTool }),
    ];
    for (const t of tools) {
      seam.ctx.tools.register(t);
      seam.registered.push(t.name);
    }
  } catch (err) {
    seam.warnings.push(`工具注册失败（delta 将走文本 JSON 路径）：${String(err?.message ?? err)}`);
    seam.registered.length = 0;
  }
  return { registered: seam.registered };
}

/**
 * 把插件接到宿主上。只做注册与状态构造，每条缝的实现见上方各自的工厂函数。
 *
 * @param {any} ctx Cordis 上下文
 * @param {ReturnType<import('../app/create.js').createContextVm>} vm
 * @param {{logger?: Function}} [deps]
 * @returns {{registered: string[], warnings: string[], registerTool: Function}}
 */
export function applySeams(ctx, vm, deps = {}) {
  const seam = createSeamContext(ctx, vm, deps);
  ctx.on('session/event', makeMirrorHandler(seam));
  ctx.on('system-prompt/assemble', makeAssembleHandler(seam));
  ctx.on('agent/request-error', makeRequestErrorHandler(seam));
  ctx.on('agent/turn-stopping', makeTurnStoppingHandler(seam));
  return {
    registered: seam.registered,
    warnings: seam.warnings,
    registerTool: (defineTool) => registerTools(seam, defineTool),
  };
}
