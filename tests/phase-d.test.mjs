/**
 * Phase D 审计与验收：维护队列 / 一致性审计 / 重建工具 / 遥测
 * （§15.2 / §16.3 / §22.4 / 附录 B）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createContextVm } from '../lib/app/create.js';
import { deriveBudgets } from '../lib/app/config.js';
import { auditState } from '../lib/memory/audit.js';
import { MaintenanceQueue, createStandardQueue } from '../lib/maintenance/queue.js';
import { rebuildSearchIndex, verifyRebuildability } from '../lib/maintenance/rebuild.js';
import { Telemetry, REQUEST_FIELDS } from '../lib/app/telemetry.js';
import { fakeLlm } from './helpers.mjs';

const W = 262144;
const S = 'sess-d';

const DELTA_EMPTY = '{"upsert":[],"supersede":[],"resolve":[],"open":[],"next_action":null}';
const SUMMARY_JSON = JSON.stringify({
  topic: 't', goal: 'g', what_changed: [], confirmed_decisions: [], constraints_added_or_changed: [],
  rejected_options: [], open_questions: [], artifacts_touched: [],
  important_numbers_or_identifiers: [], source_event_range: { start_event: 'a', end_event: 'b' }, search_keywords: [],
});

function setup({ llm } = {}) {
  const vm = createContextVm({
    rawConfig: {},
    dbPath: ':memory:',
    llm: llm ?? fakeLlm([{ text: DELTA_EMPTY }, { text: SUMMARY_JSON }, { text: SUMMARY_JSON }]),
  });
  vm.runtime.setWindow(S, W);
  return { vm, budgets: deriveBudgets(vm.config, W) };
}

test('审计：dangling source 被检出并只标 uncertain，不删除（§16.3 / §22.4）', () => {
  const { vm } = setup();
  try {
    const e = vm.raw.append({ sessionId: S, role: 'user', eventType: 'user_message', content: '约束 1064nm' });
    const ok = vm.state.upsert({ sessionId: S, itemType: 'constraint', key: 'wl', value: '1064nm', sourceEventIds: [e.eventId] });
    // 人为制造一条引用不存在事件的项
    const bad = vm.state.upsert({ sessionId: S, itemType: 'fact', key: 'phantom', value: 'x', sourceEventIds: ['evt_不存在'] });

    const res = auditState({ state: vm.state, raw: vm.raw, sessionId: S });
    const dangling = res.findings.find((f) => f.kind === 'dangling_source_refs');
    assert.ok(dangling, '应检出 dangling source');
    assert.deepEqual(dangling.stateIds, [bad.item.stateId]);
    assert.equal(res.applied.length, 0, '未开启 applySafeFixes 时不得改动');

    const applied = auditState({ state: vm.state, raw: vm.raw, sessionId: S, applySafeFixes: true });
    assert.equal(applied.applied.length, 1);
    assert.equal(vm.state.get(ok.item.stateId).status, 'active', '正常项不受影响');
    assert.equal(vm.state.get(bad.item.stateId).status, 'uncertain', '可疑项只降级不删除');
    assert.equal(vm.state.all(S).length, 2, 'MUST NOT 删除任何项');
  } finally {
    vm.close();
  }
});

test('审计：已解决的开问题被检出并可安全迁移为 resolved（§16.3）', () => {
  const { vm } = setup();
  try {
    const e = vm.raw.append({ sessionId: S, role: 'user', eventType: 'user_message', content: 'q' });
    const q = vm.state.upsert({ sessionId: S, itemType: 'open_question', key: 'q1', value: '要不要缓存？', sourceEventIds: [e.eventId] });
    const r = vm.state.upsert({ sessionId: S, itemType: 'resolved_question', key: 'q1', value: '要不要缓存？', sourceEventIds: [e.eventId] });
    vm.state.setStatus(r.item.stateId, 'resolved');

    const res = auditState({ state: vm.state, raw: vm.raw, sessionId: S });
    assert.ok(res.findings.some((f) => f.kind === 'open_question_already_resolved'));

    auditState({ state: vm.state, raw: vm.raw, sessionId: S, applySafeFixes: true });
    assert.equal(vm.state.get(q.item.stateId).status, 'resolved');
    assert.equal(vm.state.all(S).length, 2, '保留全部历史项');
  } finally {
    vm.close();
  }
});

test('审计：无问题时 findings 为空，不制造噪音', () => {
  const { vm } = setup();
  try {
    const e = vm.raw.append({ sessionId: S, role: 'user', eventType: 'user_message', content: 'x' });
    vm.state.upsert({ sessionId: S, itemType: 'constraint', key: 'a', value: '1', sourceEventIds: [e.eventId] });
    vm.state.upsert({ sessionId: S, itemType: 'goal', value: '做某事', sourceEventIds: [e.eventId] });
    const res = auditState({ state: vm.state, raw: vm.raw, sessionId: S });
    assert.deepEqual(res.findings, []);
  } finally {
    vm.close();
  }
});

test('重建：FTS 索引可从 raw 重建，且重建后可自我检索（§22.4）', () => {
  const { vm } = setup();
  try {
    for (let i = 0; i < 8; i += 1) {
      vm.raw.append({ sessionId: S, role: 'user', eventType: 'user_message', content: `事件 ${i} 编号 CAL-${i} 约束 波长 1064nm` });
    }
    // 破坏索引（模拟索引丢失/损坏）
    vm.db.exec('DELETE FROM raw_fts');
    assert.equal(vm.lexical.search(S, '波长', { limit: 5 }).length, 0, '前置条件：索引已空');

    const res = rebuildSearchIndex({ db: vm.db, sessionId: S });
    assert.equal(res.rebuilt, 8);
    assert.ok(vm.lexical.search(S, '波长', { limit: 5 }).length > 0, '重建后应可检索');

    const v = verifyRebuildability({ db: vm.db, lexical: vm.lexical, sessionId: S, sampleSize: 8 });
    assert.equal(v.ok, true, `校验失败：${JSON.stringify(v)}`);
    assert.equal(v.rawCount, 8);
    assert.equal(v.ftsCount, 8);
  } finally {
    vm.close();
  }
});

test('重建：raw 与 FTS 数量不一致时校验失败（不谎报 ok）', () => {
  const { vm } = setup();
  try {
    vm.raw.append({ sessionId: S, role: 'user', eventType: 'user_message', content: '仅一条' });
    vm.db.exec("DELETE FROM raw_fts WHERE event_id = (SELECT event_id FROM raw_fts LIMIT 1)");
    const v = verifyRebuildability({ db: vm.db, lexical: vm.lexical, sessionId: S, sampleSize: 5 });
    assert.equal(v.ok, false);
    assert.equal(v.rawCount, 1);
    assert.equal(v.ftsCount, 0);
    // 样本取自 raw，故仍会尝试检索并报告 miss —— 这是"索引缺行"的直接证据
    assert.equal(v.misses.length, 1);
  } finally {
    vm.close();
  }
});

test('维护队列：只运行到期作业，且受总时间预算约束（§15.2）', async () => {
  let t = 1_000_000;
  const ran = [];
  const q = new MaintenanceQueue(
    [
      { name: 'a', intervalMs: 100, run: async () => { ran.push('a'); return {}; } },
      { name: 'b', intervalMs: 100_000, run: async () => { ran.push('b'); return {}; } },
    ],
    { now: () => t },
  );
  const first = await q.runDue({}, { maxMs: 1000 });
  assert.deepEqual(first.ran.sort(), ['a', 'b'], '首次全部到期');
  ran.length = 0;

  t += 200;
  const second = await q.runDue({}, { maxMs: 1000 });
  assert.deepEqual(second.ran, ['a'], '仅 a 到期');

  // 时间预算：now 推进使所有作业都到期，但 maxMs=0 时不得开跑
  t += 10_000_000;
  const third = await q.runDue({}, { maxMs: 0 });
  assert.deepEqual(third.ran, []);
  assert.equal(third.deadlineHit, true);
});

test('维护队列：作业抛错被隔离，其它作业照常运行（§15.2/§22）', async () => {
  const q = new MaintenanceQueue(
    [
      { name: 'bad', intervalMs: 0, run: async () => { throw new Error('boom'); } },
      { name: 'good', intervalMs: 0, run: async () => ({ ok: 1 }) },
    ],
    {},
  );
  const res = await q.runDue({}, { maxMs: 5000 });
  assert.deepEqual(res.failed.map((f) => f.name), ['bad']);
  assert.deepEqual(res.ok, ['good']);
  assert.equal(q.list().find((x) => x.name === 'bad').failures, 1);
});

test('标准作业集：flush / summarize / audit / verify 全部可跑通', async () => {
  const { vm } = setup();
  try {
    const e = vm.raw.append({ sessionId: S, role: 'user', eventType: 'user_message', content: '约束 1064nm' });
    vm.state.upsert({ sessionId: S, itemType: 'constraint', key: 'wl', value: '1064nm', sourceEventIds: [e.eventId] });
    const res = await vm.maintenance.runAll({ sessionId: S, runtime: vm.runtime });
    assert.deepEqual(res.failed, [], `作业不应失败：${JSON.stringify(res.failed)}`);
    assert.equal(res.ok.length, 4);
  } finally {
    vm.close();
  }
});

test('遥测：记录请求字段，缺失项为 null 而非臆造（附录 B）', () => {
  const t = new Telemetry();
  const row = t.record({ session_id: S, context_mode: 'LOCAL', input_tokens: 100 });
  assert.equal(row.session_id, S);
  assert.equal(row.input_tokens, 100);
  assert.equal(row.ttft_ms, null);
  assert.equal(row.artifact_token_count, null);
  for (const f of REQUEST_FIELDS) assert.ok(f in row, `缺字段 ${f}`);
});

test('遥测：报告汇总真实发生的编译/扫描/episode/delta 事件（附录 B）', async () => {
  const { vm } = setup();
  try {
    const e = vm.raw.append({ sessionId: S, role: 'user', eventType: 'user_message', content: '问题' });
    vm.state.upsert({ sessionId: S, itemType: 'constraint', key: 'k', value: 'v', sourceEventIds: [e.eventId] });
    vm.runtime.compile({ sessionId: S, query: '问题' });
    await vm.runtime.extractDelta({ sessionId: S, query: 'q', answer: 'a', eventIds: [e.eventId] });

    const rep = vm.telemetry.report();
    assert.equal(rep.context.compiles, 1);
    assert.equal(rep.context.by_mode.LOCAL, 1);
    assert.ok(rep.context.avg_token_count > 0);
    assert.equal(rep.state_delta.applied, 1);
    assert.ok(rep.notes.length > 0, '必须声明哪些字段不可得');
  } finally {
    vm.close();
  }
});

test('Phase D 验收：崩溃后索引可重建、状态可恢复、审计无 dangling（§22.4 / §29）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'contextvm-d-'));
  const dbPath = path.join(dir, 'contextvm.db');
  const llm = fakeLlm([{ text: DELTA_EMPTY }]);

  const vm1 = createContextVm({ rawConfig: {}, dbPath, llm });
  const e = vm1.raw.append({ sessionId: S, role: 'user', eventType: 'user_message', content: '关键约束 1064.37nm' });
  vm1.state.upsert({ sessionId: S, itemType: 'constraint', key: 'wl', value: '1064.37nm', sourceEventIds: [e.eventId] });
  // 模拟索引损坏后关闭
  vm1.db.exec('DELETE FROM raw_fts');
  vm1.close();

  const vm2 = createContextVm({ rawConfig: {}, dbPath, llm });
  try {
    assert.equal(vm2.state.active(S).length, 1, '状态应恢复');
    assert.equal(vm2.lexical.search(S, '约束', { limit: 5 }).length, 0, 'FTS 索引确实丢了');

    const rebuilt = vm2.rebuildSearchIndex(S);
    assert.equal(rebuilt.rebuilt, 1);
    assert.equal(vm2.verifyRebuildability(5).ok, true);

    const audit = vm2.audit(S, false);
    assert.deepEqual(audit.findings, [], '重建后不应有 dangling source');
  } finally {
    vm2.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
