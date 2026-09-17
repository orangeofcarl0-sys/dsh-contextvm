/**
 * State Delta 应用与验证（§5.3 / §16.2 / §23.5）。
 *
 * 纪律：
 *   - 任何 source_event_id 必须真实存在，否则整条被拒（§5.3）；
 *   - 禁止无依据取代/删除 active constraint（§5.3 / §23.5）；
 *   - 冲突不得静默覆盖：同 key 的 active constraint 被换成不同值时，
 *     新项以 uncertain 落库并留待 reconciliation（§5.3 / §16.2）；
 *   - 被拒项 MUST 显式回报，MUST NOT 静默丢弃。
 *
 * 结构：`applyDelta` 只做编排，四类操作各自一个函数，共享同一个可变 `ctx`
 * （承担"已应用/被拒"的记账）。四者互不调用，顺序由 `applyDelta` 固定。
 *
 * @module dsh-contextvm/memory/delta
 */
import { isInjectableContent } from '../core/injectability.js';
import { NEEDS_SOURCE_TYPES } from '../storage/state_store.js';

/**
 * `next_action` 的稳定 key。
 *
 * 此前写的是 `key: null`，而 null key 的项**不参与版本链**（§4.2）——于是每一轮都新增
 * 一条 active next_action，旧版永不 supersede。真机实测同一句话已累积两条，
 * 且都以 `sourceEventIds: []` 落库，使 §24.3 的"active 项 100% 有来源"在真机上被打破
 * （实测 countWithoutProvenance = 2）。稳定 key 让版本链自动取代上一版。
 */
const NEXT_ACTION_KEY = 'current';

/**
 * 为 next_action 找来源时向后扫描的事件数。
 *
 * 必须比 `recent_events` 宽：宿主样板（运行时快照/技能目录）密度很高，真机实测
 * 8 条窗口里可能绝大多数是它们，真实用户消息会被挤出窗口。
 */
const TURN_SOURCE_SCAN = 20;

/**
 * 应用一份已通过 schema 校验的 delta。
 *
 * @param {{
 *   state: import('../storage/state_store.js').StateStore,
 *   raw: import('../storage/raw_events.js').RawEventStore,
 *   sessionId: string,
 *   delta: object,
 *   now?: string,
 * }} p
 * @returns {{applied: {upserts: object[], superseded: object[], resolved: object[], uncertain: object[]}, rejected: Array<{reason: string, detail: any}>}}
 */
export function applyDelta({ state, raw, sessionId, delta, now, turnEventIds }) {
  const ctx = {
    state,
    raw,
    sessionId,
    now,
    delta,
    /**
     * 本轮可作为依据的事件 id，**已排除宿主托管上下文与自身记账事件**（§4.1.1）。
     * 不过滤的话，next_action 的来源会指向宿主自己发的快照 —— 等于用宿主样板给自己背书。
     */
    turnSources: (turnEventIds ?? [])
      .map((id) => raw.get(id))
      .filter((ev) => ev && isInjectableContent(ev.eventType, ev.metadata))
      .map((ev) => ev.eventId),
    applied: { upserts: [], superseded: [], resolved: [], uncertain: [] },
    rejected: [],
    explicitSupersede: new Set((delta.supersede ?? []).map((s) => s.stateId)),
  };

  for (const item of [...(delta.upsert ?? []), ...(delta.open ?? [])]) applyUpsert(ctx, item);
  applyNextAction(ctx);
  for (const s of delta.supersede ?? []) applySupersede(ctx, s);
  for (const stateId of delta.resolve ?? []) applyResolve(ctx, stateId);

  return { applied: ctx.applied, rejected: ctx.rejected };
}

// ---------------------------------------------------------------- 四类操作

/**
 * upsert / open：校验来源 → 冲突检测 → 落库。
 * 冲突时降级为 uncertain，而不是静默覆盖（§5.3 / §16.2）。
 */
function applyUpsert(ctx, item) {
  const { state, raw, sessionId, now } = ctx;
  const missing = item.sourceEventIds.filter((id) => !raw.has(id));
  if (missing.length > 0) {
    return ctx.rejected.push({ reason: 'source_event_not_found', detail: { item, missing } });
  }
  if (item.status === 'active' && item.sourceEventIds.length === 0 && NEEDS_SOURCE_TYPES.has(item.type)) {
    return ctx.rejected.push({ reason: 'active_without_source', detail: { item } });
  }
  // 来源**全部**是宿主托管上下文或自身记账事件 → 拒绝（§4.1.1 / §4.2）。
  // 真机实测：模型把宿主注入的运行时上下文（文件沙箱策略、审批策略）当成项目事实记了下来，
  // 来源指向那份宿主快照，随后又被当作权威事实注入回去 —— 宿主样板绕成一个自指环。
  // 至少有一个真实内容来源才放行（混引时以内容为准）。
  const cited = item.sourceEventIds.map((id) => raw.get(id)).filter(Boolean);
  if (cited.length > 0 && cited.every((ev) => !isInjectableContent(ev.eventType, ev.metadata))) {
    return ctx.rejected.push({ reason: 'source_is_host_context', detail: { item } });
  }

  let status = item.status;
  if (item.type === 'constraint' && item.key) {
    const prev = state.latest(sessionId, 'constraint', item.key);
    const conflicts =
      prev && prev.status === 'active' && !ctx.explicitSupersede.has(prev.stateId) && String(prev.value) !== String(item.value);
    if (conflicts) status = 'uncertain';
  }

  try {
    const { item: stored, superseded } = state.upsert({
      sessionId,
      itemType: item.type,
      key: item.key,
      value: item.value,
      status,
      confidence: item.confidence ?? null,
      sourceEventIds: item.sourceEventIds,
      now,
    });
    ctx.applied.upserts.push(stored);
    if (superseded.length) ctx.applied.superseded.push(...superseded);
    if (status === 'uncertain' && item.status !== 'uncertain') {
      ctx.applied.uncertain.push({ stateId: stored.stateId, reason: 'unresolved_conflict_with_active_constraint' });
    }
  } catch (err) {
    ctx.rejected.push({ reason: 'state_upsert_failed', detail: { item, message: String(err.message) } });
  }
}

/**
 * next_action：顶层字段自行落库。
 * 刻意**不**合成进 `open` —— 同一信息两处表示会让"谁负责落库"变得含糊。
 */
function applyNextAction(ctx) {
  if (!ctx.delta.next_action) return;
  if (ctx.turnSources.length === 0) {
    // §4.2/§23.2：无来源 MUST NOT 成为 active。此前这里以 sourceEventIds: [] 落库，
    // 使 §24.3 的 provenance 断言在真机上失效 —— 宁可拒收，也不写一条无据的 active。
    return ctx.rejected.push({
      reason: 'next_action_without_source',
      detail: { value: ctx.delta.next_action },
    });
  }
  try {
    const { item: stored, superseded } = ctx.state.upsert({
      sessionId: ctx.sessionId,
      itemType: 'next_action',
      key: NEXT_ACTION_KEY,
      value: ctx.delta.next_action,
      status: 'active',
      sourceEventIds: ctx.turnSources,
      now: ctx.now,
    });
    ctx.applied.upserts.push(stored);
    if (superseded.length) ctx.applied.superseded.push(...superseded);

    // 自愈：清掉"其它 key 的 active next_action"（旧版用 null key 写下的遗留项）。
    // 语义上"当前下一步"只能有一条，故这里显式取代，而不是留着它们被重复注入。
    for (const stale of ctx.state.active(ctx.sessionId)) {
      if (stale.itemType === 'next_action' && stale.stateId !== stored.stateId) {
        ctx.state.setStatus(stale.stateId, 'superseded', { now: ctx.now });
        ctx.applied.superseded.push({ stateId: stale.stateId, reason: 'next_action_replaced' });
      }
    }
  } catch (err) {
    ctx.rejected.push({ reason: 'next_action_upsert_failed', detail: { message: String(err.message) } });
  }
}

/**
 * supersede：目标是 active constraint 时，必须**同一次 delta** 里给出同 key 的新约束，
 * 否则视为"无依据取代"并拒绝（§5.3 / §23.5）。
 */
function applySupersede(ctx, s) {
  const target = ctx.state.get(s.stateId);
  if (!target) {
    return ctx.rejected.push({ reason: 'supersede_target_not_found', detail: s });
  }
  if (target.itemType === 'constraint' && target.status === 'active') {
    const replacement = (ctx.delta.upsert ?? []).some((u) => u.type === 'constraint' && u.key === target.key);
    if (!replacement) {
      return ctx.rejected.push({
        reason: 'no_basis_to_supersede_active_constraint',
        detail: { stateId: s.stateId, key: target.key },
      });
    }
  }
  ctx.state.setStatus(target.stateId, 'superseded', { now: ctx.now });
  ctx.applied.superseded.push({ stateId: target.stateId, reason: s.reason });
}

/** resolve：只接受仍处于开放态（active / uncertain）的目标。 */
function applyResolve(ctx, stateId) {
  const target = ctx.state.get(stateId);
  if (!target) {
    return ctx.rejected.push({ reason: 'resolve_target_not_found', detail: { stateId } });
  }
  if (!['active', 'uncertain'].includes(target.status)) {
    return ctx.rejected.push({ reason: 'resolve_target_not_open', detail: { stateId, status: target.status } });
  }
  ctx.state.setStatus(stateId, 'resolved', { now: ctx.now });
  ctx.applied.resolved.push({ stateId });
}

/**
 * 从本轮事件 id 推断可用来源，供提示词使用。
 * @param {import('../storage/raw_events.js').RawEventStore} raw
 * @param {string} sessionId
 * @param {number} limit
 * @returns {string[]}
 */
export function recentEventIds(raw, sessionId, limit) {
  return raw.recent(sessionId, limit).map((e) => e.eventId);
}

/**
 * 本轮候选事件 id（比 recentEventIds 更宽，且已剔除宿主托管上下文与自身记账事件）。
 * 工具路径未显式给出事件 id 时的默认来源（§4.1.1）。
 * @param {import('../storage/raw_events.js').RawEventStore} raw
 * @param {string} sessionId
 * @returns {string[]}
 */
export function turnSourceEventIds(raw, sessionId) {
  return raw
    .recent(sessionId, TURN_SOURCE_SCAN)
    .filter((e) => isInjectableContent(e.eventType, e.metadata))
    .map((e) => e.eventId);
}
