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
import { isSessionActive } from '../app/session_mode.js';
import { deriveBudgets } from '../app/config.js';

/** 余量低于这个值就整段不注入（几百 token 的注入没有意义，还会把请求推向失败）。 */
const MIN_INJECT_TOKENS = 512;
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
        // 块类型以宿主 ContentBlockMap 为准：**`tool-call` / `tool-result`**（连字符），
        // 不是 `tool_use` / `tool_result`。写错名字会落进 default → 返回空 →
        // 工具活动整段丢失（真机实测：长跑库里 0 条 tool 事件，agent 的"我干了什么"全没了）。
        case 'tool-call':
          // arguments 是模型产出的原始 JSON 字符串
          return `[tool-call ${b.name ?? ''}] ${b.arguments ?? ''}`;
        case 'tool-result':
          return `[tool-result${b.isError ? ' error' : ''}] ${blocksToText(b.content)}`;
        case 'file':
          // FileBlock 只带附件引用；本插件不读工作区文件（§4.4），如实标注即可
          return '[file]';
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
  // 负载位置以宿主类型声明为准：`assistant/message` 与 **`tool/result`** 都在 `data.message`
  // （ToolResultMessage / AssistantMessage），其余在 `data.content`。
  // 真机缺陷：tool/result 曾按 `data.content` 读 → undefined → 空 → 镜像直接跳过，
  // 于是**工具活动一条都进不了记忆**（长跑实测：整个库 0 条 tool 事件）。
  // 对编码类长任务，这等于把"我干了什么"整段丢掉。
  const content =
    event?.type === 'assistant/message' || event?.type === 'tool/result'
      ? blocksToText(data.message?.content)
      : blocksToText(data.content);
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
  // 只有**真实用户输入**才算"本轮查询"：宿主会把自身注入的合成上下文（运行时快照、
  // 技能目录）也写成 `user/message`，§4.1 的分类此前只用在镜像上，这里漏掉了。
  // 真机实测（web 长对话实验）：query 取到的是 `Current runtime context. This snapshot
  // supersedes …` —— 增量抽取被喂了宿主样板，直接导致 unparseable、单次输出 2500 token
  // 的畸形推理、状态项始终为 0。判定与 §4.1 同向：缺 kind 按用户处理，其余一律排除。
  const isUserInput = (e) => {
    if (e?.type !== 'user/message') return false;
    const kind = e.data?.message?.source?.kind ?? e.data?.source?.kind ?? null;
    return kind === null || kind === 'user';
  };
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (isUserInput(events[i])) {
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
    /**
     * 工具定义器（宿主包异步解析后由 index.js 注入）。会话级注册时按需取用。
     * @type {Function|null}
     */
    defineTool: null,
    /** @type {Map<string, {disposers: Function[], names: string[]}>} sessionId → 该会话已注册的工具 */
    agentTools: new Map(),
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
  logRouteInfo(seam, key, info, W);
  return W;
}

/**
 * 每个路由首次解析成功时，把"这条路由到底提供了什么"记一行。
 *
 * 放在这里而不是挂载时：挂载时只知道配置里的**回退**路由，真机实测它甚至可能
 * 在该 profile 未注册（`no adapter registered for provider ...`）；真正决定预算的
 * 是会话头的路由。推理档位与适配器默认输出上限都直接影响辅助调用的开销，用户需要看得到。
 *
 * @param {any} seam
 * @param {string} key `provider/model`
 * @param {any} info LlmResolvedModelInfo
 * @param {number} W
 */
function logRouteInfo(seam, key, info, W) {
  const bits = [`声明窗口 ${W.toLocaleString('en-US')}`];
  if (Number.isFinite(info?.defaultMaxTokens)) bits.push(`适配器默认输出上限 ${info.defaultMaxTokens}`);
  const efforts = info?.reasoning?.efforts ?? [];
  if (efforts.length) {
    bits.push(
      `推理档位 ${efforts.map((e) => `${e.name}(${e.id})`).join(' / ')}` +
        `，默认 ${info.reasoning.defaultEffort ?? '提供方默认'}`,
    );
  }
  seam.logger('info', `路由 ${key}: ${bits.join('；')}`);
}

/**
 * 宿主自身已用的 token 量（`ctx.tokenMeter.measure(session).totalTokens`）。
 *
 * 只读、失败即返回 null（拿不到就退回"没有主动检查"的旧行为，绝不因此中断注入）。
 * auto-compact 用的是同一个服务，语义一致。
 *
 * @param {any} seam
 * @param {any} session
 * @returns {number|null}
 */
export function measureHostPressure(seam, session) {
  try {
    const meter = seam.ctx.get?.('tokenMeter');
    if (!meter || typeof meter.measure !== 'function') return null;
    const m = meter.measure(session);
    const total = m?.totalTokens;
    return Number.isFinite(total) && total >= 0 ? total : null;
  } catch (err) {
    seam.logger('debug', `tokenMeter 不可用（跳过主动余量检查）：${String(err?.message ?? err)}`);
    return null;
  }
}

function makeAssembleHandler(seam) {
  return async (assembly, context, next) => {
    const out = await next();
    const session = context?.agent?.session;
    if (!session) return out; // 诊断路径无 agent：MUST 直接放行（宿主契约）
    // 默认休眠：未显式开启的会话**零请求足迹**（不注入、不注册工具）—— 污染隔离的关键。
    if (!isSessionActive(seam.vm.db, session.id, seam.vm.config.sessionMode)) return out;
    try {
      // 已开启但工具尚未注册（例如宿主重启后）：补注册。
      // 工具没就绪就不注入输出契约 —— 否则等于让模型去调用一个不存在的工具。
      const toolsReady = ensureActivated(seam, context.agent);
      const W = await resolveWindow(seam, session, context?.signal);
      if (!W) {
        seam.warnings.push('无法解析路由窗口（llm 服务缺失或 modelInfo 无 contextWindow）：本轮不注入');
        return out;
      }
      const sessionId = session.id;
      seam.runtime.setWindow(sessionId, W);

      const requestedMaxTokens = seam.vm.config.output.default_max_output_tokens;
      let compiled = seam.runtime.compile({
        sessionId,
        query: seam.runtime.lastUserQuery(sessionId),
        requestedMaxTokens,
        includeOutputContract: toolsReady,
      });

      // ---- 主动余量检查（真机事故驱动）----
      //
      // 事故现场：注入涨到 49,030 token 后请求撞网关预检上限（网关计数 262,144 / 上限 270,828），
      // 自适应收缩把注入降到 0.7 → 0.49 仍然被拒，因为**宿主自身上下文已接近上限，我们缩不动**，
      // 于是整轮失败、长跑终止。
      //
      // 教训：只靠"被拒后收缩"不够 —— 收缩只作用于我们这部分。必须**先量出宿主已用多少**，
      // 把注入限制在真实余量之内；余量为零时**整段不注入**（让宿主自己的压缩去处理），
      // 而不是让请求死掉。
      const hostPressure = measureHostPressure(seam, session);
      if (hostPressure !== null) {
        const headroom = deriveBudgets(seam.vm.config, W).hardInputCap - hostPressure - requestedMaxTokens;
        if (compiled.tokenCount > headroom) {
          if (headroom < MIN_INJECT_TOKENS) {
            seam.runtime.onTelemetry({
              event: 'injection_skipped_no_headroom',
              session_id: sessionId,
              host_pressure: hostPressure,
              would_inject: compiled.tokenCount,
              note: '宿主自身上下文已占满可用余量，本轮整段不注入（否则请求会撞上游容量上限而整轮失败）',
            });
            seam.logger(
              'warn',
              `contextvm: 宿主上下文已占满余量（宿主 ${hostPressure} + 预留 ${requestedMaxTokens} ≥ 上限），本轮不注入`,
            );
            return out;
          }
          const scale = Math.max(0.15, headroom / Math.max(1, compiled.tokenCount));
          const applied = seam.runtime.clampInjectionScale(sessionId, scale);
          compiled = seam.runtime.compile({
            sessionId,
            query: seam.runtime.lastUserQuery(sessionId),
            requestedMaxTokens,
            includeOutputContract: toolsReady,
          });
          seam.runtime.onTelemetry({
            event: 'injection_capped_by_headroom',
            session_id: sessionId,
            host_pressure: hostPressure,
            headroom,
            scale: applied,
            token_count: compiled.tokenCount,
          });
          if (compiled.tokenCount > headroom) {
            seam.logger('warn', `contextvm: 缩到 ${applied} 仍超出余量，本轮不注入`);
            return out;
          }
        }
      }
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

      // 默认休眠：不做任何后台模型调用（抽取与摘要都要花免费模型的产能）
      if (!isSessionActive(seam.vm.db, sessionId, seam.vm.config.sessionMode)) return;

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

// ---------------- 5. 会话级工具生命周期（§13.2 / §8.3 / §14） ----------------

/**
 * 为一个会话注册工具 —— 注册进**该 agent 自己的作用域**（`agent.ctx.tools`），不是全局。
 *
 * 为什么不全局注册：工具 schema 随注册进入该 profile 下**每一个会话**的请求，实测 8 个
 * 合计约 1433 token，比插件注入的上下文（82–257）贵一个量级，且与用户是否用 ContextVM
 * 无关。改为按会话注册后，没开启的会话**看不到也付不起**这些 schema —— 污染隔离是结构性的。
 *
 * MUST NOT 在拿不到 agent 作用域时退化为全局注册：那会悄悄破坏隔离，宁可不注册并如实上报。
 *
 * @param {any} seam
 * @param {any} agent 宿主 agent（来自命令 invocation 或 system-prompt/assemble 的 context）
 * @returns {{ok: boolean, registered: string[], reason?: string}}
 */
export function activateTools(seam, agent) {
  const sessionId = agent?.session?.id ?? null;
  if (!sessionId) return { ok: false, registered: [], reason: '无法确定会话' };
  const existing = seam.agentTools.get(sessionId);
  if (existing) return { ok: true, registered: existing.names };

  const defineTool = seam.defineTool;
  if (typeof defineTool !== 'function') {
    return { ok: false, registered: [], reason: '工具定义器尚未就绪（宿主包解析中）' };
  }
  const tools = agent?.ctx?.tools;
  if (!tools || typeof tools.register !== 'function') {
    return { ok: false, registered: [], reason: '该 agent 未提供 tools 作用域（不做全局兜底）' };
  }

  const disposers = [];
  const names = [];
  try {
    for (const t of [
      commitStateTool(seam.runtime, { defineTool }),
      exhaustiveScanTool(seam.runtime, { defineTool }),
      ...memoryTools(seam.runtime, { defineTool }),
    ]) {
      disposers.push(tools.register(t));
      names.push(t.name);
    }
  } catch (err) {
    // 任一步失败即整体回滚：注册一半的工具集会给出"看起来能用"的假象
    for (const d of disposers) {
      try {
        d?.();
      } catch {
        /* 回滚失败不影响主流程 */
      }
    }
    return { ok: false, registered: [], reason: `注册失败：${String(err?.message ?? err)}` };
  }
  seam.agentTools.set(sessionId, { disposers, names });
  // 成功也 MUST 记一行：否则"工具到底注册上没有"只能靠猜（本轮审计就因此误判过一次 ——
  // 我 grep 的是一行已被删除的日志，于是把成功当成了失败）
  seam.logger('info', `已为会话 ${sessionId.slice(0, 20)} 注册 ${names.length} 个工具（仅本会话可见）`);
  return { ok: true, registered: names };
}

/**
 * 关闭一个会话的工具（释放该 agent 作用域的注册）。幂等。
 * @param {any} seam
 * @param {string} sessionId
 */
export function deactivateTools(seam, sessionId) {
  const entry = seam.agentTools.get(sessionId);
  if (!entry) return { ok: true, released: 0 };
  for (const d of entry.disposers) {
    try {
      d?.();
    } catch (err) {
      seam.logger('warn', `释放工具注册失败（不影响运行）：${String(err?.message ?? err)}`);
    }
  }
  seam.agentTools.delete(sessionId);
  return { ok: true, released: entry.names.length };
}

/** 该会话的工具是否已注册（注入输出契约的前提）。 */
export function toolsActiveFor(seam, sessionId) {
  return seam.agentTools.has(sessionId);
}

/**
 * 懒激活：会话已开启但（例如宿主重启后）工具尚未注册时补注册。
 * 在 system-prompt/assemble 里调用 —— 那里是唯一能同时拿到 agent 与 session 的时机。
 */
export function ensureActivated(seam, agent) {
  const sessionId = agent?.session?.id ?? null;
  if (!sessionId) return false;
  if (!isSessionActive(seam.vm.db, sessionId, seam.vm.config.sessionMode)) return false;
  if (seam.agentTools.has(sessionId)) return true;
  const res = activateTools(seam, agent);
  if (!res.ok) seam.logger('debug', `本轮未能注册工具（${res.reason}）：暂不注入输出契约`);
  return res.ok;
}

/**
 * 把插件接到宿主上。只做注册与状态构造，每条缝的实现见上方各自的工厂函数。
 *
 * 注意：**不注册任何全局工具**。工具由 `/contextvm on` 按会话注册进该 agent 的作用域
 * （见 activateTools），未开启的会话请求零足迹。
 *
 * @param {any} ctx Cordis 上下文
 * @param {ReturnType<import('../app/create.js').createContextVm>} vm
 * @param {{logger?: Function}} [deps]
 * @returns {{warnings: string[], setDefineTool: Function, activate: Function, deactivate: Function, toolsActive: Function}}
 */
export function applySeams(ctx, vm, deps = {}) {
  const seam = createSeamContext(ctx, vm, deps);
  ctx.on('session/event', makeMirrorHandler(seam));
  ctx.on('system-prompt/assemble', makeAssembleHandler(seam));
  ctx.on('agent/request-error', makeRequestErrorHandler(seam));
  ctx.on('agent/turn-stopping', makeTurnStoppingHandler(seam));
  return {
    warnings: seam.warnings,
    /** 宿主包异步解析出 defineTool 后注入（会话级注册时取用）。 */
    setDefineTool: (fn) => {
      seam.defineTool = typeof fn === 'function' ? fn : null;
    },
    /** 供命令与测试使用：为某会话开启工具。 */
    activate: (agent) => activateTools(seam, agent),
    /** 供命令使用：关闭某会话的工具。 */
    deactivate: (sessionId) => deactivateTools(seam, sessionId),
    toolsActive: (sessionId) => toolsActiveFor(seam, sessionId),
  };
}
