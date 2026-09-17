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

/** 需要 source 才能 active 的类型（与 state_store 一致）。 */
const NEEDS_SOURCE = new Set(['fact', 'decision', 'constraint', 'rejected_option', 'artifact_state']);

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
export function applyDelta({ state, raw, sessionId, delta, now }) {
  const ctx = {
    state,
    raw,
    sessionId,
    now,
    delta,
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
  if (item.status === 'active' && item.sourceEventIds.length === 0 && NEEDS_SOURCE.has(item.type)) {
    return ctx.rejected.push({ reason: 'active_without_source', detail: { item } });
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
  try {
    const { item: stored, superseded } = ctx.state.upsert({
      sessionId: ctx.sessionId,
      itemType: 'next_action',
      key: null,
      value: ctx.delta.next_action,
      status: 'active',
      sourceEventIds: [],
      now: ctx.now,
    });
    ctx.applied.upserts.push(stored);
    if (superseded.length) ctx.applied.superseded.push(...superseded);
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
