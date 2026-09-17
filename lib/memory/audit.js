/**
 * 一致性审计（§16.3）。
 *
 * 输出**短 patch**，不重写整个 state（§16.3）。且只做安全迁移
 * （把可疑项标为 uncertain / 记录待人工复核），MUST NOT 删除任何项。
 *
 * 检查项：
 *   1. dangling source：active 项引用了不存在的事件（§22.4 可重建性受损的信号）；
 *   2. 同名 key 的 active 约束取值不一致（版本链本应阻止，出现即为异常）；
 *   3. 已解决的开问题仍以 active 形式存在；
 *   4. active 项的证据全部早于同 key 项的 supersede 时点（即基于过期证据）；
 *   5. active 项的证据**全部是宿主托管上下文或自身记账事件**（§4.1.1）—— 写入侧已拒收，
 *      出现即为修复前的遗留（真机上模型把宿主的文件沙箱/审批策略记成了项目事实）。
 *
 * @module dsh-contextvm/memory/audit
 */
import { isInjectableContent } from '../core/injectability.js';

/**
 * @param {{
 *   state: import('../storage/state_store.js').StateStore,
 *   raw: import('../storage/raw_events.js').RawEventStore,
 *   sessionId: string,
 *   applySafeFixes?: boolean,
 * }} p
 * @returns {{
 *   findings: Array<{kind: string, stateIds: string[], detail: any, suggestedAction: string}>,
 *   patch: {setUncertain: string[]},
 *   applied: string[],
 * }}
 */
export function auditState(p) {
  const { state, raw, sessionId } = p;
  const ctx = { state, raw, sessionId };
  const active = state.active(sessionId);

  // 四项检查的形状统一为 null 或 {finding, stateIds, ...}，便于无差别汇总
  const results = [
    checkDanglingSources(ctx, active),
    checkConstraintKeyConflict(active),
    checkAlreadyResolvedQuestions(ctx, active),
    checkEvidencePredatesSupersession(ctx, active),
    checkHostContextSourced(ctx, active),
  ].filter(Boolean);

  const findings = results.map((r) => r.finding);

  // 安全 patch：只标 uncertain，绝不删除。
  // dangling source 也必须进 patch —— 来源损坏的项不满足 §4.2 的 provenance 要求，
  // 不应继续作为 authoritative 状态使用。
  // "已解决的开问题"走 resolved 迁移，故不进 uncertain 集合。
  const patch = {
    setUncertain: [
      ...new Set(
        results
          .filter((r) => r.finding.kind !== 'open_question_already_resolved')
          .flatMap((r) => r.stateIds),
      ),
    ],
  };
  const staleOpen = results.find((r) => r.finding.kind === 'open_question_already_resolved')?.items ?? null;

  return { findings, patch, applied: applySafeFixes({ state, enabled: p.applySafeFixes === true, patch, staleOpen }) };
}

// ---------------------------------------------------------------- 各项检查
// 每项检查是独立函数：只读、无副作用，返回 null（无问题）或
// `{finding, stateIds, ...}` —— 形状统一，故汇总处无需分支处理。
// 检查与"是否修复"完全分离，每项都能被单独测试与审阅。

/**
 * 1. dangling source：active 项引用了不存在的事件（§22.4 可重建性受损的信号）。
 * @returns {{finding: object, stateIds: string[]}|null}
 */
export function checkDanglingSources({ raw }, active) {
  const dangling = [];
  for (const it of active) {
    const missing = it.sourceEventIds.filter((id) => !raw.has(id));
    if (missing.length > 0) dangling.push({ stateId: it.stateId, missing });
  }
  if (dangling.length === 0) return null;
  return {
    stateIds: dangling.map((d) => d.stateId),
    finding: {
      kind: 'dangling_source_refs',
      stateIds: dangling.map((d) => d.stateId),
      detail: dangling,
      suggestedAction: '确认来源事件是否被误删或来自其它会话；确认前不应作为权威状态使用',
    },
  };
}

/**
 * 2. 同名 key 的 active 约束取值不一致（版本链本应阻止，出现即为异常）。
 * @returns {{finding: object, ids: string[]}|null}
 */
export function checkConstraintKeyConflict(active) {
  const byKey = new Map();
  for (const it of active.filter((i) => i.itemType === 'constraint' && i.key)) {
    if (!byKey.has(it.key)) byKey.set(it.key, []);
    byKey.get(it.key).push(it);
  }
  const inconsistent = [...byKey.entries()]
    .filter(([, arr]) => new Set(arr.map((i) => String(i.value))).size > 1)
    .map(([key, arr]) => ({ key, stateIds: arr.map((i) => i.stateId), values: arr.map((i) => String(i.value)) }));
  if (inconsistent.length === 0) return null;
  return {
    stateIds: inconsistent.flatMap((x) => x.stateIds),
    finding: {
      kind: 'active_constraint_key_conflict',
      stateIds: inconsistent.flatMap((x) => x.stateIds),
      detail: inconsistent,
      suggestedAction: '同一 key 存在多个 active 取值：版本链异常，标为 uncertain 并等待 reconciliation',
    },
  };
}

/**
 * 3. 已解决的开问题仍以 active 形式存在。
 * @returns {{finding: object, items: object[]}|null}
 */
export function checkAlreadyResolvedQuestions({ state, sessionId }, active) {
  const resolved = new Set(
    state
      .all(sessionId)
      .filter((i) => i.itemType === 'resolved_question')
      .map((i) => String(i.value).trim()),
  );
  const stale = active
    .filter((i) => i.itemType === 'open_question')
    .filter((i) => resolved.has(String(i.value).trim()));
  if (stale.length === 0) return null;
  return {
    items: stale,
    finding: {
      kind: 'open_question_already_resolved',
      stateIds: stale.map((i) => i.stateId),
      detail: stale.map((i) => ({ stateId: i.stateId, value: i.value })),
      suggestedAction: '把该开问题标为 resolved（保留原项，不删除）',
    },
  };
}

/**
 * 4. active 项的证据全部早于其前身被取代的时点（即基于过期证据）。
 * @returns {{finding: object, stateIds: string[], detail: object[]}|null}
 */
export function checkEvidencePredatesSupersession({ state, raw, sessionId }, active) {
  const out = [];
  for (const it of active) {
    if (!it.key) continue;
    const history = state.history(sessionId, it.itemType, it.key);
    const supersededBefore = history.filter((h) => h.status === 'superseded' && h.createdAt < it.createdAt);
    if (supersededBefore.length === 0) continue;
    const newest = supersededBefore.at(-1);
    const srcTimes = it.sourceEventIds
      .map((id) => raw.get(id)?.createdAt)
      .filter(Boolean)
      .map((t) => Date.parse(t));
    if (srcTimes.length === 0) continue;
    if (srcTimes.every((t) => t <= Date.parse(newest.createdAt))) {
      out.push({ stateId: it.stateId, supersededStateId: newest.stateId, key: it.key });
    }
  }
  if (out.length === 0) return null;
  return {
    stateIds: out.map((s) => s.stateId),
    detail: out,
    finding: {
      kind: 'evidence_predates_supersession',
      stateIds: out.map((s) => s.stateId),
      detail: out,
      suggestedAction: '该 active 项的证据全部早于其前身被取代的时点，建议人工复核或标 uncertain',
    },
  };
}

/**
 * 5. active 项的证据全部是宿主托管上下文/自身记账事件（§4.1.1）。
 *
 * 写入侧（`delta.js`）已拒收这类项，故命中即为**修复前的遗留**：真机上模型把宿主注入的
 * 运行时上下文（文件沙箱策略、审批策略）记成了项目事实，来源指向宿主快照，随后又被当作
 * 权威事实注入回去。安全修复按既有规则标为 uncertain（不删除），使其退出 authoritative 状态。
 *
 * @returns {{finding: object, stateIds: string[]}|null}
 */
export function checkHostContextSourced({ raw }, active) {
  const out = active.filter((item) => {
    if (item.sourceEventIds.length === 0) return false; // 无来源由第 1 项与写入侧负责
    return item.sourceEventIds.every((id) => {
      const ev = raw.get(id);
      return ev && !isInjectableContent(ev.eventType, ev.metadata);
    });
  });
  if (out.length === 0) return null;
  return {
    finding: {
      kind: 'source_is_host_context',
      stateIds: out.map((i) => i.stateId),
      detail: out.map((i) => ({ stateId: i.stateId, itemType: i.itemType, key: i.key })),
      suggestedAction: '该 active 项的依据全是宿主注入的环境信息（非本轮对话内容），已标 uncertain',
    },
    stateIds: out.map((i) => i.stateId),
  };
}

/**
 * 应用安全修复：只做"不安全 → uncertain"与"未决 → resolved"两种迁移，绝不删除。
 * @param {{state: object, enabled: boolean, patch: object, staleOpen: object[]|null}} p
 * @returns {string[]} 实际被改动的 state id
 */
export function applySafeFixes({ state, enabled, patch, staleOpen }) {
  const applied = [];
  if (!enabled) return applied;
  for (const id of patch.setUncertain) {
    const cur = state.get(id);
    if (cur && cur.status === 'active') {
      state.setStatus(id, 'uncertain');
      applied.push(id);
    }
  }
  for (const it of staleOpen ?? []) {
    state.setStatus(it.stateId, 'resolved');
    applied.push(it.stateId);
  }
  return applied;
}

