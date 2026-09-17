/**
 * State Delta 应用与验证审计（§5.3 / §16.2 / §23.5）。
 * 覆盖：来源校验、禁止无依据取代 active 约束、冲突转 uncertain、next_action 落库、拒绝项回报。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeBackend } from './helpers.mjs';
import { applyDelta } from '../lib/memory/delta.js';

const S = 'sess-delta';

function setup() {
  const be = makeBackend();
  const e1 = be.raw.append({ sessionId: S, role: 'user', eventType: 'user_message', content: '约束波长 1064nm' });
  const e2 = be.raw.append({ sessionId: S, role: 'user', eventType: 'user_message', content: '改为 1065nm' });
  return { be, e1: e1.eventId, e2: e2.eventId };
}

test('来源不存在时整条被拒，且明确回报（§5.3）', () => {
  const { be, e1 } = setup();
  try {
    const res = applyDelta({
      state: be.state, raw: be.raw, sessionId: S,
      delta: {
        upsert: [
          { type: 'fact', key: 'ok', value: '有来源', sourceEventIds: [e1] },
          { type: 'fact', key: 'bad', value: '无来源', sourceEventIds: ['evt_不存在'] },
        ],
        supersede: [], resolve: [], open: [], next_action: null,
      },
    });
    assert.equal(res.applied.upserts.length, 1);
    assert.equal(res.applied.upserts[0].key, 'ok');
    assert.deepEqual(res.rejected.map((r) => r.reason), ['source_event_not_found']);
    assert.equal(be.state.all(S).length, 1, '被拒项 MUST NOT 落库');
  } finally {
    be.close();
  }
});

test('无 source 的 active 项被拒（§4.2/§23.2）', () => {
  const { be } = setup();
  try {
    const res = applyDelta({
      state: be.state, raw: be.raw, sessionId: S,
      delta: { upsert: [{ type: 'constraint', key: 'k', value: 'v', status: 'active', sourceEventIds: [] }], supersede: [], resolve: [], open: [], next_action: null },
    });
    assert.deepEqual(res.rejected.map((r) => r.reason), ['active_without_source']);
  } finally {
    be.close();
  }
});

test('禁止无依据取代 active 约束（§5.3 / §23.5）', () => {
  const { be, e1, e2 } = setup();
  try {
    const first = be.state.upsert({ sessionId: S, itemType: 'constraint', key: 'wl', value: '1064nm', sourceEventIds: [e1] });

    // 只 supersede，不给同 key 的新值 → 拒绝
    const noBasis = applyDelta({
      state: be.state, raw: be.raw, sessionId: S,
      delta: { upsert: [], supersede: [{ stateId: first.item.stateId, reason: '没依据' }], resolve: [], open: [], next_action: null },
    });
    assert.deepEqual(noBasis.rejected.map((r) => r.reason), ['no_basis_to_supersede_active_constraint']);
    assert.equal(be.state.get(first.item.stateId).status, 'active', '原约束必须保持 active');

    // 给出同 key 新值 → 允许
    const withBasis = applyDelta({
      state: be.state, raw: be.raw, sessionId: S,
      delta: {
        upsert: [{ type: 'constraint', key: 'wl', value: '1065nm', status: 'active', sourceEventIds: [e2] }],
        supersede: [{ stateId: first.item.stateId, reason: '用户改了值' }], resolve: [], open: [], next_action: null,
      },
    });
    assert.deepEqual(withBasis.rejected, []);
    assert.equal(be.state.get(first.item.stateId).status, 'superseded');
    assert.equal(be.state.latest(S, 'constraint', 'wl').value, '1065nm');
  } finally {
    be.close();
  }
});

test('同 key 冲突且未显式取代时，新项以 uncertain 落库而非静默覆盖（§5.3/§16.2）', () => {
  const { be, e1, e2 } = setup();
  try {
    be.state.upsert({ sessionId: S, itemType: 'constraint', key: 'wl', value: '1064nm', sourceEventIds: [e1] });
    const res = applyDelta({
      state: be.state, raw: be.raw, sessionId: S,
      delta: {
        upsert: [{ type: 'constraint', key: 'wl', value: '9999nm', status: 'active', sourceEventIds: [e2] }],
        supersede: [], resolve: [], open: [], next_action: null,
      },
    });
    const stored = res.applied.upserts[0];
    assert.equal(stored.status, 'uncertain', '冲突项必须转 uncertain');
    assert.equal(res.applied.uncertain.length, 1);
    assert.equal(res.applied.uncertain[0].reason, 'unresolved_conflict_with_active_constraint');
    // 旧值仍可查（版本链完整，未静默覆盖）
    assert.equal(be.state.history(S, 'constraint', 'wl').length, 2);
  } finally {
    be.close();
  }
});

test('next_action 由顶层字段落库，且不重复出现在 open 中', () => {
  const { be, e1 } = setup();
  try {
    const res = applyDelta({
      state: be.state, raw: be.raw, sessionId: S, turnEventIds: [e1],
      delta: { upsert: [], supersede: [], resolve: [], open: [], next_action: '先复核波长' },
    });
    assert.deepEqual(res.rejected, []);
    const active = be.state.active(S);
    assert.equal(active.length, 1);
    assert.equal(active[0].itemType, 'next_action');
    assert.equal(active[0].value, '先复核波长');
    assert.equal(active[0].key, 'current', 'next_action MUST 用稳定 key，否则 null key 不参与版本链');
    assert.deepEqual(active[0].sourceEventIds, [e1], 'next_action MUST 带 provenance（§4.2/§24.3）');
  } finally {
    be.close();
  }
});

// ---- next_action 的真机缺陷回归（§4.1.1 / §4.2 / §24.3）----
//
// 真机实测两件事：
//   1) key: null → 不参与版本链 → 每轮新增一条 active，同一句话累积两条；
//   2) sourceEventIds: [] → active 却无来源，使 §24.3 的"active 100% 有来源"被打破
//      （实测 countWithoutProvenance = 2，而验收语料从不含 next_action，故一直没暴露）。

test('next_action：无来源时拒收，MUST NOT 写一条无据的 active（§24.3）', () => {
  const { be } = setup();
  try {
    const res = applyDelta({
      state: be.state, raw: be.raw, sessionId: S,
      delta: { upsert: [], supersede: [], resolve: [], open: [], next_action: '无据的下一步' },
    });
    assert.deepEqual(res.rejected.map((r) => r.reason), ['next_action_without_source']);
    assert.equal(be.state.active(S).length, 0, '无来源 MUST NOT 落成 active');
    assert.equal(be.state.countWithoutProvenance(S), 0);
  } finally {
    be.close();
  }
});

test('next_action：新一版取代旧一版，且自愈清理历史遗留的 null key 项', () => {
  const { be, e1, e2 } = setup();
  try {
    // 先直接写库造出"修复前遗留"的 active 项：null key + 无来源。
    // 不能经 StateStore 造 —— 它现在会拒绝（next_action 已纳入 NEEDS_SOURCE_TYPES），
    // 而遗留行只存在于修复前的库里（真机上就有两条）。
    const now = new Date().toISOString();
    be.db
      .prepare(
        `INSERT INTO state_items (state_id, session_id, item_type, key, value_json, status, confidence,
          source_event_ids_json, superseded_by, created_at, updated_at, version)
         VALUES (?, ?, 'next_action', NULL, ?, 'active', NULL, '[]', NULL, ?, ?, 1)`,
      )
      .run('st_legacy_next', S, JSON.stringify('旧版遗留的下一步'), now, now);
    assert.equal(be.state.active(S).length, 1, '遗留项应为 active（模拟修复前的库）');

    const r1 = applyDelta({
      state: be.state, raw: be.raw, sessionId: S, turnEventIds: [e1],
      delta: { upsert: [], supersede: [], resolve: [], open: [], next_action: '第一步' },
    });
    assert.deepEqual(r1.rejected, []);
    // 自愈：旧版 null key 项被取代，而不是留着重复注入
    assert.ok(
      r1.applied.superseded.some((x) => x.stateId === 'st_legacy_next' && x.reason === 'next_action_replaced'),
      '遗留的 null key active 项 MUST 被取代',
    );
    assert.equal(be.state.active(S).filter((i) => i.itemType === 'next_action').length, 1);

    // 第二次写入：稳定 key 让版本链取代上一版
    const r2 = applyDelta({
      state: be.state, raw: be.raw, sessionId: S, turnEventIds: [e2],
      delta: { upsert: [], supersede: [], resolve: [], open: [], next_action: '第二步' },
    });
    assert.deepEqual(r2.rejected, []);
    const live = be.state.active(S).filter((i) => i.itemType === 'next_action');
    assert.equal(live.length, 1, '任何时刻只应有一条 active next_action');
    assert.equal(live[0].value, '第二步');
    assert.deepEqual(live[0].sourceEventIds, [e2]);
    assert.equal(be.state.countWithoutProvenance(S), 0, '§24.3：active 项 MUST 全部有来源');
  } finally {
    be.close();
  }
});

test('upsert：来源全部是宿主托管上下文时被拒（真机：宿主样板被记成项目事实）', () => {
  const { be, e1 } = setup();
  try {
    const host = be.raw.append({
      sessionId: S, role: 'system', eventType: 'system_note',
      content: 'Current runtime context. This snapshot supersedes ...',
      metadata: { sourceKind: 'plugin', contextForm: 'snapshot' },
    }).eventId;
    const bookkeeping = be.raw.append({
      sessionId: S, role: 'assistant', eventType: 'state_delta', content: '{"upserted":["st_1"]}',
    }).eventId;

    const res = applyDelta({
      state: be.state, raw: be.raw, sessionId: S, turnEventIds: [e1],
      delta: {
        upsert: [
          { type: 'fact', key: 'file-policy', value: '沙箱策略 workspace-write', sourceEventIds: [host] },
          { type: 'fact', key: 'from-bookkeeping', value: 'x', sourceEventIds: [bookkeeping] },
          { type: 'fact', key: 'mixed', value: '混引时以内容为准', sourceEventIds: [host, e1] },
          { type: 'fact', key: 'real', value: '真实内容来源', sourceEventIds: [e1] },
        ],
        supersede: [], resolve: [], open: [], next_action: null,
      },
    });
    assert.deepEqual(
      res.rejected.map((r) => r.reason),
      ['source_is_host_context', 'source_is_host_context'],
      '来源全是宿主托管上下文/记账事件的两条 MUST 被拒',
    );
    assert.deepEqual(res.applied.upserts.map((u) => u.key), ['mixed', 'real']);
    assert.equal(
      be.state.active(S).some((i) => i.key === 'file-policy'),
      false,
      '宿主样板 MUST NOT 变成项目事实',
    );
  } finally {
    be.close();
  }
});

test('resolve：目标不存在或已不是开放态时被拒', () => {
  const { be, e1 } = setup();
  try {
    const q = be.state.upsert({ sessionId: S, itemType: 'open_question', key: 'q', value: '?', sourceEventIds: [e1] });
    be.state.setStatus(q.item.stateId, 'resolved');

    const res = applyDelta({
      state: be.state, raw: be.raw, sessionId: S,
      delta: { upsert: [], supersede: [], resolve: [q.item.stateId, 'st_不存在'], open: [], next_action: null },
    });
    assert.deepEqual(res.rejected.map((r) => r.reason).sort(), ['resolve_target_not_found', 'resolve_target_not_open']);
    assert.deepEqual(res.applied.resolved, []);
  } finally {
    be.close();
  }
});

test('supersede：目标不存在时被拒，不产生悬挂引用', () => {
  const { be } = setup();
  try {
    const res = applyDelta({
      state: be.state, raw: be.raw, sessionId: S,
      delta: { upsert: [], supersede: [{ stateId: 'st_不存在', reason: 'x' }], resolve: [], open: [], next_action: null },
    });
    assert.deepEqual(res.rejected.map((r) => r.reason), ['supersede_target_not_found']);
  } finally {
    be.close();
  }
});

test('任何落库变更都在 raw 日志留下 state_delta 事件（可追溯）', () => {
  const { be, e1 } = setup();
  try {
    const before = be.raw.count(S);
    const res = applyDelta({
      state: be.state, raw: be.raw, sessionId: S,
      delta: {
        upsert: [{ type: 'fact', key: 'f', value: 'x', sourceEventIds: [e1] }],
        supersede: [], resolve: [], open: [], next_action: null,
      },
    });
    assert.ok(res.applied.upserts.length >= 1);
    // applyDelta 本身不写日志（那是 Runtime 的职责），故此处只断言它不改写 raw
    assert.equal(be.raw.count(S), before, 'applyDelta MUST NOT 自行追加事件，避免两处写日志');
  } finally {
    be.close();
  }
});

test('审计：既有库里的"宿主样板来源"active 项能被发现并安全降级（§4.1.1 / §16.3）', async () => {
  const { be, e1 } = setup();
  const { auditState } = await import('../lib/memory/audit.js');
  try {
    const host = be.raw.append({
      sessionId: S, role: 'system', eventType: 'system_note',
      content: 'Current runtime context. 文件沙箱策略 workspace-write',
      metadata: { sourceKind: 'plugin', contextForm: 'snapshot' },
    }).eventId;
    // 直接写库造出"修复前遗留"：来源全是宿主托管上下文，却是 active
    be.state.upsert({
      sessionId: S, itemType: 'fact', key: 'dsh-file-policy', value: '沙箱策略 workspace-write',
      sourceEventIds: [host], status: 'uncertain',
    });
    be.db.prepare("UPDATE state_items SET status = 'active' WHERE session_id = ? AND key = 'dsh-file-policy'").run(S);
    be.state.upsert({ sessionId: S, itemType: 'fact', key: 'real', value: '真实内容', sourceEventIds: [e1] });

    // 只审计不修：应报出这一项
    const dry = auditState({ state: be.state, raw: be.raw, sessionId: S });
    const hit = dry.findings.find((f) => f.kind === 'source_is_host_context');
    assert.ok(hit, '应报出 source_is_host_context');
    assert.equal(hit.stateIds.length, 1);
    assert.equal(dry.applied.length, 0, '未开启修复时 MUST NOT 改动状态');

    // 开启安全修复：标 uncertain（不删除），真实内容项不受影响
    const fixed = auditState({ state: be.state, raw: be.raw, sessionId: S, applySafeFixes: true });
    assert.equal(fixed.applied.length, 1);
    assert.equal(be.state.get(hit.stateIds[0]).status, 'uncertain', '只降级为 uncertain，MUST NOT 删除');
    assert.equal(be.state.active(S).some((i) => i.key === 'real'), true, '真实内容项不受影响');
    assert.equal(be.state.all(S).length, 2, 'MUST NOT 删除任何项');
  } finally {
    be.close();
  }
});
