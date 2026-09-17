/**
 * Phase A 验收（规范 §26 Phase A / §24.2 / §24.3）。
 *
 * 通过条件：0.19W–0.38W 历史下连续工作稳定。
 * 覆盖：早期精确召回、supersession、负向记忆、provenance 100%、预算不越界、
 *       崩溃后恢复、delta 失败不丢回答。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createContextVm } from '../lib/app/create.js';
import { deriveBudgets } from '../lib/app/config.js';
import { fakeLlm } from './helpers.mjs';

const W = 262144;
const S = 'accept-a';

/** 造一段合成历史，返回关键事实所在的事件 id。 */
function buildHistory(vm, { targetTokens }) {
  const fillerLine = '这是一段用于填充历史的普通叙述，不含关键信息，仅用于把上下文推到目标长度。';
  const perEvent = vm.tokenizer.estimate(fillerLine);
  const events = Math.ceil(targetTokens / perEvent);
  const ids = {};

  // 早期埋入精确事实（§24.2 Exact Recall）
  ids.secret = vm.raw.append({
    sessionId: S, role: 'user', eventType: 'user_message',
    content: '早期约定：标定基准波长是 1064.37nm，验收编号 CAL-7F3A-91。这两项后面不会再重复说明。',
  }).eventId;
  ids.decisionV1 = vm.raw.append({
    sessionId: S, role: 'user', eventType: 'user_message',
    content: '先按 A 方案实现（决策键 arch）。',
  }).eventId;

  for (let i = 0; i < events; i += 1) {
    vm.raw.append({
      sessionId: S,
      role: i % 2 === 0 ? 'user' : 'assistant',
      eventType: i % 2 === 0 ? 'user_message' : 'assistant_message',
      content: `${fillerLine}（第 ${i} 段）`,
    });
  }

  // 后期取代该决策（§24.2 Supersession）与一个明确否决项（§24.2 Negative Memory）
  ids.decisionV2 = vm.raw.append({
    sessionId: S, role: 'user', eventType: 'user_message',
    content: '改主意了：架构改用 B 方案（决策键 arch）。',
  }).eventId;
  ids.rejected = vm.raw.append({
    sessionId: S, role: 'user', eventType: 'user_message',
    content: '不要用 rolling summary 做长期记忆，这个方案已否决。',
  }).eventId;

  return { ids, eventCount: events + 4 };
}

test('Phase A 验收：0.19W–0.38W 历史下稳定工作', async () => {
  // next_action 给非 null 值：真机上它曾以 key:null + 无来源落成 active，
  // 使 §24.3 的 provenance 断言失效。语料不含它时该断言是空转的。
  const llm = fakeLlm([{ text: '{"upsert":[],"supersede":[],"resolve":[],"open":[],"next_action":"先复核 B 方案"}' }]);
  const vm = createContextVm({ rawConfig: {}, dbPath: ':memory:', llm });
  const budgets = deriveBudgets(vm.config, W);
  vm.runtime.setWindow(S, W);

  const targetRaw = Math.round(0.28 * W); // 落在 0.19W–0.38W 区间中部
  const { ids } = buildHistory(vm, { targetTokens: targetRaw });
  const rawTokens = vm.raw.totalTokens(S);
  assert.ok(
    rawTokens >= 0.19 * W && rawTokens <= 0.38 * W,
    `原始历史 ${rawTokens} 应落在 [${Math.round(0.19 * W)}, ${Math.round(0.38 * W)}]`,
  );

  // ---- 状态：写入并检验 supersession ----
  vm.state.upsert({ sessionId: S, itemType: 'decision', key: 'arch', value: 'A 方案', sourceEventIds: [ids.decisionV1] });
  vm.state.upsert({ sessionId: S, itemType: 'decision', key: 'arch', value: 'B 方案', sourceEventIds: [ids.decisionV2] });
  const rej = vm.state.upsert({
    sessionId: S, itemType: 'rejected_option', key: 'memory', value: 'rolling summary', sourceEventIds: [ids.rejected],
  });
  vm.state.setStatus(rej.item.stateId, 'rejected');
  vm.state.upsert({
    sessionId: S, itemType: 'constraint', key: 'wavelength',
    value: '1064.37nm', sourceEventIds: [ids.secret],
  });

  // ---- §24.2 Supersession：当前有效决定是 B，A 不得作为当前结论 ----
  const active = vm.state.active(S);
  const arch = active.filter((i) => i.itemType === 'decision' && i.key === 'arch');
  assert.equal(arch.length, 1);
  assert.equal(arch[0].value, 'B 方案');
  const history = vm.state.history(S, 'decision', 'arch');
  assert.deepEqual(history.map((h) => [h.version, h.value, h.status]), [
    [1, 'A 方案', 'superseded'],
    [2, 'B 方案', 'active'],
  ]);
  assert.equal(history[0].supersededBy, history[1].stateId);

  // ---- §24.2 Negative Memory：否决项不得是 active ----
  assert.ok(!active.some((i) => String(i.value).includes('rolling summary')), '否决项不得出现在 active 状态');
  assert.ok(vm.state.byStatus(S, 'rejected').some((i) => String(i.value).includes('rolling summary')));

  // ---- §24.2 Exact Recall：早期精确值可经原始证据追溯 ----
  const hit = vm.retriever.retrieve(S, '标定基准波长 1064.37nm', { tokenBudget: 8000 });
  assert.ok(hit.bundles.length > 0, '应命中早期事实');
  const manifestIds = hit.bundles.flatMap((b) => b.sourceEventIds);
  assert.ok(manifestIds.includes(ids.secret), '命中必须能追溯到埋入的那条原始事件');
  const text = hit.bundles.map((b) => b.content).join('\n');
  assert.ok(text.includes('1064.37nm'), '精确数值必须出现在证据里');
  assert.ok(text.includes('CAL-7F3A-91'), '精确编号必须出现在证据里');

  // ---- 跨长距离召回（早期 vs 后期互不覆盖） ----
  const late = vm.retriever.retrieve(S, '架构改用 B 方案 决策键', { tokenBudget: 8000 });
  assert.ok(late.bundles.some((b) => b.sourceEventIds.includes(ids.decisionV2)));

  // ---- 编译：预算与硬上限 ----
  const ctx = vm.runtime.compile({ sessionId: S, query: '当前架构方案是什么？波长多少？' });
  assert.ok(ctx.tokenCount <= budgets.hardInputCap, `编译 ${ctx.tokenCount} 应 <= hard cap ${budgets.hardInputCap}`);
  assert.ok(ctx.tokenCount > 0);
  const joined = ctx.renderedSections.map((s) => s.content).join('\n');
  assert.ok(joined.includes('B 方案'), '权威状态必须进入上下文');
  assert.ok(ctx.evidenceManifest.length > 0, '应有证据清单');
  for (const e of ctx.evidenceManifest) {
    assert.ok(e.sourceEventIds.length > 0, '§7.4 每条证据必须带 source_event_ids');
    assert.ok(typeof e.score === 'number');
  }

  // ---- delta 流水线闭环 ----
  // 这一轮的 delta **必须包含 next_action**：真机上 next_action 曾以 key:null + 无来源落成
  // active，使下面的 §24.3 provenance 断言在真机上失效（实测 countWithoutProvenance = 2）。
  // 语料不含 next_action 时该断言是空转的，故此处显式覆盖。
  const deltaRes = await vm.runtime.extractDelta({
    sessionId: S,
    query: '下一步做什么？',
    answer: '先复核 b 方案。',
    eventIds: [ids.secret],
  });
  assert.equal(deltaRes.ok, true);
  assert.ok(
    vm.state.active(S).some((i) => i.itemType === 'next_action'),
    '本轮 delta 应写入 next_action（否则下面的 provenance 断言覆盖不到该路径）',
  );

  // ---- §24.3 provenance：active 项 100% 有来源（含 next_action 路径） ----
  assert.equal(vm.state.countWithoutProvenance(S), 0);

  // ---- §24.3 上下文不超硬上限 ----
  assert.ok(ctx.tokenCount <= budgets.hardInputCap);

  vm.close();
});

test('Phase A 验收：崩溃后状态与原日志可恢复（§22.4 / §24.1）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'contextvm-a-'));
  const dbPath = path.join(dir, 'contextvm.db');
  const llm = fakeLlm([{ text: '{}' }]);

  const vm1 = createContextVm({ rawConfig: {}, dbPath, llm });
  const e1 = vm1.raw.append({ sessionId: S, role: 'user', eventType: 'user_message', content: '崩溃前写入的约束 1064nm' });
  vm1.state.upsert({ sessionId: S, itemType: 'constraint', key: 'wl', value: '1064nm', sourceEventIds: [e1.eventId] });
  vm1.tokenizer.recordUsage({ chars: 1000, actualTokens: 300, kind: 'ascii' });
  vm1.close(); // 触发持久化（含 token 标定）

  // 重新打开同一文件
  const vm2 = createContextVm({ rawConfig: {}, dbPath, llm });
  assert.equal(vm2.raw.count(S), 1, '原始事件应持久化');
  assert.equal(vm2.state.active(S).length, 1, '状态应持久化');
  assert.equal(vm2.state.active(S)[0].value, '1064nm');
  assert.ok(vm2.state.active(S)[0].sourceEventIds.includes(e1.eventId), 'provenance 应持久化');

  // FTS 索引同样可用（可重建派生物，此处验证未被破坏）
  const hits = vm2.lexical.search(S, '崩溃前写入', { limit: 5 });
  assert.equal(hits.length, 1);

  // token 标定已恢复（不再是保守下界 2.0）
  assert.ok(vm2.tokenizer.cpt('ascii') > 2.5, `标定应恢复，实际 ${vm2.tokenizer.cpt('ascii')}`);
  vm2.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Phase A 验收：delta 失败不丢回答，且入队可重试（§22.1）', async () => {
  const failing = {
    calls: 0,
    async complete() {
      this.calls += 1;
      throw new Error('upstream 502 provider_unavailable');
    },
  };
  const vm = createContextVm({ rawConfig: {}, dbPath: ':memory:', llm: failing });
  vm.runtime.setWindow(S, W);
  try {
    const e = vm.raw.append({ sessionId: S, role: 'user', eventType: 'user_message', content: '问题' });
    const res = await vm.runtime.extractDelta({ sessionId: S, query: '问题', answer: '已经产出的回答', eventIds: [e.eventId] });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'llm_call_failed');
    const pending = vm.runtime.pendingDeltas();
    assert.equal(pending.length, 1, '失败必须入队，不得静默丢弃');
    assert.equal(pending[0].answer, '已经产出的回答', '回答内容必须保留在待重试项里');

    // 重试仍失败：队列保留并累加 attempts
    const flush = await vm.runtime.flushPendingDeltas({ limit: 1 });
    assert.equal(flush.remaining, 1);
    assert.equal(vm.runtime.pendingDeltas()[0].attempts, 1);
  } finally {
    vm.close();
  }
});

test('Phase A 验收：非法 delta 被拒且不污染状态（§5.3 / §27.3）', async () => {
  const vm = createContextVm({
    rawConfig: {},
    dbPath: ':memory:',
    llm: fakeLlm([{
      text: JSON.stringify({
        upsert: [
          { type: 'fact', value: '来源不存在的断言', source_event_ids: ['evt_不存在'] },
          { type: 'nonsense_type', value: 'x' },
        ],
        bogus_field: 1,
      }),
    }]),
  });
  try {
    // W 必须由宿主缝解析后写入；未写入时 window() 会抛错（不静默用默认窗口）
    vm.runtime.setWindow(S, W);
    const e = vm.raw.append({ sessionId: S, role: 'user', eventType: 'user_message', content: 'q' });
    const res = await vm.runtime.extractDelta({ sessionId: S, query: 'q', answer: 'a', eventIds: [e.eventId] });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'invalid_delta');
    assert.equal(vm.state.all(S).length, 0, '非法 delta MUST NOT 写入任何状态');

    // 合法的部分仍然必须通过（同一入口）
    const ok = vm.runtime.applySubmittedDelta({
      sessionId: S,
      rawDelta: { upsert: [{ type: 'fact', key: 'k', value: '有效断言', source_event_ids: [e.eventId] }] },
    });
    assert.equal(ok.ok, true);
    assert.equal(vm.state.active(S).length, 1);
  } finally {
    vm.close();
  }
});

test('Phase A 验收：未解析窗口时不静默兜底，直接报错（§2.1）', () => {
  const vm = createContextVm({ rawConfig: {}, dbPath: ':memory:', llm: fakeLlm([{ text: '{}' }]) });
  try {
    assert.throws(() => vm.runtime.compile({ sessionId: 'never-seen', query: 'q' }), /W 尚未解析/);
  } finally {
    vm.close();
  }
});

test('Phase A 验收：输出预算被推理耗尽时，如实上报且不排队空重试（真机发现）', async () => {
  // 真机实测：目标模型会回传推理，推理计入输出上限。上限不足时 finish=max-tokens、
  // 正文 0 字 —— 这不是"解析失败"，也不是瞬时故障，重试必然同样失败。
  const eaten = {
    calls: 0,
    async complete() {
      this.calls += 1;
      return { text: '', toolCalls: [], usage: { input_tokens: 700, output_tokens: 500 }, stopReason: { kind: 'max-tokens' } };
    },
  };
  const seen = [];
  const vm = createContextVm({
    rawConfig: {},
    dbPath: ':memory:',
    llm: eaten,
    onTelemetry: (r) => seen.push(r),
  });
  vm.runtime.setWindow(S, W);
  try {
    const res = await vm.runtime.extractDelta({ sessionId: S, query: 'q', answer: 'a', eventIds: [] });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'budget_exhausted', '必须与 unparseable 区分开');
    assert.equal(eaten.calls, 1, '不得重试（成因是配置，重试无用）');
    assert.equal(vm.runtime.pendingDeltas().length, 0, '不得入队，避免白烧慢调用');
    const ev = seen.find((r) => r.event === 'delta_budget_exhausted');
    assert.ok(ev, '必须发出专门的遥测事件');
    assert.ok(ev.note.includes('state_delta_soft_max_tokens'), '提示必须指向要调的具体配置项');
  } finally {
    vm.close();
  }
});

test('Phase A 验收：辅助调用的失败按 finish reason 分类上报（§21.7.1）', async () => {
  const cases = [
    {
      name: '上游报错 → provider_error，入队可重试',
      res: { text: '', toolCalls: [], usage: null, stopReason: { kind: 'error', failure: { code: 'rate_limited', status: 429, message: 'too many requests', providerRetryAfterMs: 3000 } } },
      expect: { reason: 'provider_error', event: 'delta_provider_error', queued: 1 },
    },
    {
      name: '被中止 → aborted，不入队（重试无意义）',
      res: { text: '', toolCalls: [], usage: null, stopReason: { kind: 'aborted', failure: { code: 'aborted', message: 'signal' } } },
      expect: { reason: 'aborted', event: 'delta_aborted', queued: 0 },
    },
    {
      name: '推理耗尽预算 → budget_exhausted，不入队（成因是配置）',
      res: { text: '', toolCalls: [], usage: null, stopReason: { kind: 'max-tokens' } },
      expect: { reason: 'budget_exhausted', event: 'delta_budget_exhausted', queued: 0 },
    },
    {
      name: '撞上限但正文非空 → 仍按 unparseable 处理（不是预算问题）',
      res: { text: '我分析了很久但没给出 JSON', toolCalls: [], usage: null, stopReason: { kind: 'max-tokens' } },
      expect: { reason: 'unparseable_delta', event: 'delta_unparseable', queued: 1 },
    },
  ];
  for (const c of cases) {
    const seen = [];
    const vm = createContextVm({
      rawConfig: {},
      dbPath: ':memory:',
      llm: { async complete() { return c.res; } },
      onTelemetry: (r) => seen.push(r),
    });
    vm.runtime.setWindow(S, W);
    try {
      const res = await vm.runtime.extractDelta({ sessionId: S, query: 'q', answer: 'a', eventIds: [] });
      assert.equal(res.reason, c.expect.reason, c.name);
      assert.ok(seen.some((r) => r.event === c.expect.event), `${c.name}：应发出 ${c.expect.event}`);
      assert.equal(vm.runtime.pendingDeltas().length, c.expect.queued, `${c.name}：入队数`);
    } finally {
      vm.close();
    }
  }

  // 上游报错的详情必须带出来（否则又是"只知道失败、不知道为什么"）
  const seen = [];
  const vm = createContextVm({
    rawConfig: {}, dbPath: ':memory:',
    llm: { async complete() { return cases[0].res; } },
    onTelemetry: (r) => seen.push(r),
  });
  vm.runtime.setWindow(S, W);
  try {
    await vm.runtime.extractDelta({ sessionId: S, query: 'q', answer: 'a', eventIds: [] });
    const ev = seen.find((r) => r.event === 'delta_provider_error');
    assert.equal(ev.failure_code, 'rate_limited');
    assert.equal(ev.failure_status, 429);
    assert.equal(ev.retry_after_ms, 3000, '上游建议的重试延迟应带出');
    assert.ok(ev.failure_message.includes('too many requests'));
  } finally {
    vm.close();
  }
});
