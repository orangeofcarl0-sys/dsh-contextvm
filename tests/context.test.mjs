/**
 * Phase A 审计：模式分类 / 预算装箱 / 去重 / ContextCompiler（§8 / §9 / §7.4）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeBackend } from './helpers.mjs';
import { classify, globalMarkersIn, broadMarkersIn } from '../lib/context/classifier.js';
import { packByPriority, PRIORITY, componentCaps } from '../lib/context/budget.js';
import { dedupeEvidence, dedupeAgainstState } from '../lib/context/dedup.js';
import { Compiler, NON_EXHAUSTIVE_NOTICE } from '../lib/context/compiler.js';
import { LexicalIndex } from '../lib/indexing/lexical.js';
import { Retriever } from '../lib/retrieval/hybrid.js';
import { resolveConfig, deriveBudgets } from '../lib/app/config.js';

const S = 'sess-c';
const W = 262144;

function setup(raw = {}) {
  const be = makeBackend();
  const cfg = resolveConfig(raw);
  const lexical = new LexicalIndex(be.db);
  const retriever = new Retriever({ db: be.db, raw: be.raw, tokenizer: be.tokenizer, lexical, state: be.state, config: cfg });
  const compiler = new Compiler({ raw: be.raw, state: be.state, retriever, tokenizer: be.tokenizer, config: cfg });
  return { be, cfg, budgets: deriveBudgets(cfg, W), retriever, compiler };
}

test('分类：GLOBAL 语义标记强制进入 GLOBAL（§8.3）', () => {
  for (const q of ['列出全部约束', '有没有遗漏任何一项', '检查所有历史是否矛盾', '不要漏任何一项', 'list every constraint']) {
    assert.equal(classify(q).mode, 'GLOBAL', `「${q}」应判为 GLOBAL`);
  }
  assert.ok(globalMarkersIn('完整检查一下').length >= 1);
});

test('分类：BROAD 标记与低检索置信度进入 BROAD（§8.2）', () => {
  assert.equal(classify('以前讨论过哪些方案').mode, 'BROAD');
  assert.ok(broadMarkersIn('回顾一下之前的决定').length >= 1);
  assert.equal(classify('普通问题', { retrievalConfidence: 0.1 }).mode, 'BROAD');
  assert.equal(classify('普通问题', { retrievalConfidence: 0.9 }).mode, 'LOCAL');
});

test('装箱：按 §9.3 优先级，低优先级先被删除', () => {
  const items = [
    { id: 'low', priority: PRIORITY.secondary_evidence, tokenCount: 100 },
    { id: 'proto', priority: PRIORITY.system_protocol, tokenCount: 30 },
    { id: 'constraint', priority: PRIORITY.active_hard_constraint, tokenCount: 40 },
    { id: 'recent', priority: PRIORITY.recent_verbatim, tokenCount: 60 },
  ];
  const { included, dropped, tokens } = packByPriority(items, { budget: 130 });
  assert.deepEqual(included.map((i) => i.id), ['proto', 'constraint', 'recent']);
  assert.deepEqual(dropped.map((d) => d.id), ['low']);
  assert.equal(tokens, 130);
});

test('装箱：协议段永不因预算被删除（§9.3）', () => {
  const items = [
    { id: 'proto', priority: PRIORITY.system_protocol, tokenCount: 1000 },
    { id: 'recent', priority: PRIORITY.recent_verbatim, tokenCount: 10 },
  ];
  const { included } = packByPriority(items, { budget: 0 });
  assert.deepEqual(included.map((i) => i.id), ['proto']);
});

test('去重：嵌套与同集证据被更强证据吸收（§9.4）', () => {
  const bundles = [
    { sourceEventIds: ['a', 'b', 'c'], content: '大片段', score: 0.9, tokenCount: 10 },
    { sourceEventIds: ['b', 'c'], content: '子片段', score: 0.8, tokenCount: 6 },
    { sourceEventIds: ['a', 'b', 'c'], content: '同集', score: 0.7, tokenCount: 10 },
    { sourceEventIds: ['z'], content: '另一处', score: 0.5, tokenCount: 4 },
  ];
  const { kept, dropped } = dedupeEvidence(bundles);
  assert.deepEqual(kept.map((b) => b.content), ['大片段', '另一处']);
  assert.equal(dropped.length, 2);
});

test('去重：仅复述 state 内容的证据被丢弃，其余保留（§9.4）', () => {
  const bundles = [
    { content: '[user_message] 波长 1064nm', sourceEventIds: ['a'], tokenCount: 5 },
    { content: '[user_message] 波长 1064nm，且必须用 A 方案实现', sourceEventIds: ['b'], tokenCount: 9 },
  ];
  const { kept, dropped } = dedupeAgainstState(bundles, [{ itemType: 'constraint', value: '波长 1064nm' }]);
  assert.equal(dropped.length, 1);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].sourceEventIds[0], 'b', '含额外信息的证据必须保留');
});

test('编译：LOCAL 产物含各段落、预算合规、证据带 provenance', () => {
  const { be, compiler, budgets } = setup();
  try {
    const e1 = be.raw.append({ sessionId: S, role: 'user', eventType: 'user_message', content: '约束：波长必须是 1064nm' });
    be.raw.append({ sessionId: S, role: 'assistant', eventType: 'assistant_message', content: '明白，记下了' });
    be.state.upsert({ sessionId: S, itemType: 'constraint', key: 'wavelength', value: '1064nm', sourceEventIds: [e1.eventId] });
    be.state.upsert({ sessionId: S, itemType: 'goal', value: '完成标定', sourceEventIds: [e1.eventId] });
    be.state.upsert({ sessionId: S, itemType: 'next_action', value: '先测波长', sourceEventIds: [e1.eventId] });

    const ctx = compiler.compile({ sessionId: S, query: '波长是多少', budgets });
    assert.equal(ctx.mode, 'LOCAL');
    assert.ok(ctx.tokenCount > 0 && ctx.tokenCount <= budgets.normalTargetInput);
    assert.equal(ctx.coverage.complete, false);

    const byOrder = ctx.renderedSections.map((s) => s.order);
    assert.deepEqual(byOrder, [...byOrder].sort((a, b) => a - b), '段落必须按 §9.5 顺序');

    const titles = ctx.renderedSections.map((s) => s.title).join('|');
    assert.ok(titles.includes('Active constraints'), '约束段必须存在');
    assert.ok(titles.includes('Current task'), '任务段必须存在');
    assert.ok(ctx.renderedSections.some((s) => s.content.includes('1064nm')));
    assert.ok(ctx.includedStateIds.length >= 3);
    assert.deepEqual(ctx.admittedMessages, [], 'Phase A 不改写历史');
  } finally {
    be.close();
  }
});

test('编译：命中 GLOBAL 时给出非穷举提示且 coverage 不为 complete（§8.3/§23.3）', () => {
  const { be, compiler, budgets } = setup();
  try {
    be.raw.append({ sessionId: S, role: 'user', eventType: 'user_message', content: '约束 A' });
    const ctx = compiler.compile({ sessionId: S, query: '列出全部约束，不要遗漏', budgets });
    assert.equal(ctx.mode, 'GLOBAL');
    assert.equal(ctx.coverage.complete, false);
    assert.equal(ctx.coverage.reason, 'no_exhaustive_scan');
    assert.ok(ctx.notes.degraded.includes('global_scan_unavailable'));
    const notice = ctx.renderedSections.find((s) => s.title === 'Coverage notice');
    assert.ok(notice, '必须渲染非穷举提示段');
    assert.equal(notice.content, NON_EXHAUSTIVE_NOTICE);
    assert.ok(/不得使用/.test(notice.content));
  } finally {
    be.close();
  }
});

test('编译：LOCAL 不渲染非穷举提示段（避免无谓占预算）', () => {
  const { be, compiler, budgets } = setup();
  try {
    be.raw.append({ sessionId: S, role: 'user', eventType: 'user_message', content: '普通提问' });
    const ctx = compiler.compile({ sessionId: S, query: '继续说', budgets });
    assert.equal(ctx.mode, 'LOCAL');
    assert.ok(!ctx.renderedSections.some((s) => s.title === 'Coverage notice'));
  } finally {
    be.close();
  }
});

test('编译：估计输入超硬上限时抛错，不产出越界上下文（§9.6）', () => {
  const { be, compiler, budgets } = setup();
  try {
    be.raw.append({ sessionId: S, role: 'user', eventType: 'user_message', content: 'x' });
    assert.throws(
      () => compiler.compile({ sessionId: S, query: 'q', budgets, requestedMaxTokens: 400000 }),
      /约束①/,
    );
  } finally {
    be.close();
  }
});

test('编译：组件上限取自 budgets，且总和不超过 hard cap（§9.2）', () => {
  const { be, budgets } = setup();
  try {
    const caps = componentCaps(budgets);
    const sum = Object.values(caps).reduce((a, b) => a + b, 0);
    assert.ok(sum <= budgets.hardInputCap, `组件上限和 ${sum} 应 <= hard cap ${budgets.hardInputCap}`);
    assert.equal(caps.retrieved_evidence, Math.floor(0.16 * W));
  } finally {
    be.close();
  }
});

test('编译：空会话不崩且产出仅含协议段', () => {
  const { be, compiler, budgets } = setup();
  try {
    const ctx = compiler.compile({ sessionId: 'empty', query: '你好', budgets });
    assert.equal(ctx.mode, 'LOCAL');
    assert.ok(ctx.tokenCount > 0);
    assert.deepEqual(ctx.includedEventIds, []);
    assert.deepEqual(ctx.evidenceManifest, []);
  } finally {
    be.close();
  }
});

test('非 active 清单进入上下文：否决项与已取代项可见，防止重新推荐（§8.3/§10.2）', () => {
  const { be, compiler, budgets } = setup();
  try {
    const e1 = be.raw.append({ sessionId: S, role: 'user', eventType: 'user_message', content: '先按 A 方案' });
    const e2 = be.raw.append({ sessionId: S, role: 'user', eventType: 'user_message', content: '改用 B 方案' });
    const e3 = be.raw.append({ sessionId: S, role: 'user', eventType: 'user_message', content: '不要用滚动摘要' });

    // 一个被取代的决定链
    const v1 = be.state.upsert({ sessionId: S, itemType: 'decision', key: 'arch', value: 'A 方案', sourceEventIds: [e1.eventId] });
    be.state.upsert({ sessionId: S, itemType: 'decision', key: 'arch', value: 'B 方案', sourceEventIds: [e2.eventId] });
    // 一个明确否决项
    const rej = be.state.upsert({ sessionId: S, itemType: 'rejected_option', key: 'mem', value: '滚动摘要', sourceEventIds: [e3.eventId] });
    be.state.setStatus(rej.item.stateId, 'rejected');

    const ctx = compiler.compile({ sessionId: S, query: '架构用什么方案', budgets });
    const sec = ctx.renderedSections.find((s) => s.title.includes('do not re-propose'));
    assert.ok(sec, '必须有非 active 清单段，否则模型会重新推荐已否决方案');
    assert.ok(sec.content.includes('滚动摘要'), '否决项必须在清单里');
    assert.ok(sec.content.includes('A 方案'), '被取代的决定必须在清单里');
    assert.ok(sec.content.includes('rejected'), '应标注状态');
    // 清单只列最新一次 superseded，不列全部历史版本
    assert.ok(!/A 方案[\s\S]*A 方案/.test(sec.content), '同一键的多个历史版本不应重复列出');
    assert.ok(ctx.includedStateIds.includes(rej.item.stateId));
    assert.ok(ctx.includedStateIds.includes(v1.item.stateId), '被取代项的 id 也应可追溯');
  } finally {
    be.close();
  }
});

test('非 active 清单受预算限幅，不挤掉 active 约束（§9.3）', () => {
  const { be, compiler, budgets } = setup();
  try {
    const e = be.raw.append({ sessionId: S, role: 'user', eventType: 'user_message', content: '基线' });
    be.state.upsert({ sessionId: S, itemType: 'constraint', key: 'wl', value: '1064.37nm', sourceEventIds: [e.eventId] });
    // 造 20 条否决项，远超清单上限
    for (let i = 0; i < 20; i += 1) {
      const r = be.state.upsert({
        sessionId: S, itemType: 'rejected_option', key: `r${i}`, value: `被否决的方案 ${i}`, sourceEventIds: [e.eventId],
      });
      be.state.setStatus(r.item.stateId, 'rejected');
    }
    const ctx = compiler.compile({ sessionId: S, query: 'q', budgets });
    const sec = ctx.renderedSections.find((s) => s.title.includes('do not re-propose'));
    const listed = (sec.content.match(/^- /gm) ?? []).length;
    assert.ok(listed <= 12, `清单条数应受限，实际 ${listed}`);
    assert.ok(sec.content.length < 4000, '清单体积应受限');
    // active 约束仍在
    assert.ok(ctx.renderedSections.some((s) => s.content.includes('1064.37nm')));
  } finally {
    be.close();
  }
});

test('强制的 mode 非法时抛错，不静默流穿（§8）', () => {
  const { be, compiler, budgets } = setup();
  try {
    be.raw.append({ sessionId: S, role: 'user', eventType: 'user_message', content: 'x' });
    assert.throws(() => compiler.compile({ sessionId: S, query: 'q', mode: 'BOGUS', budgets }), /未知的 context mode/);
    for (const m of ['LOCAL', 'BROAD', 'GLOBAL']) {
      assert.equal(compiler.compile({ sessionId: S, query: 'q', mode: m, budgets }).mode, m);
    }
  } finally {
    be.close();
  }
});

// ---------------- 输出契约：每轮最多提交一次 ----------------
//
// 真机缺陷（web 长对话审计发现）：一轮里模型调用了 5 次 contextvm_commit_state ——
// 1 次因缺 source_event_ids 被拒、1 次成功、之后又连发 3 次空 delta。
// 宿主自己都注入了提示「You are repeating the exact same tool call with id...」。
// 在目标模型（免费、慢）上，每次多余往返就是几十秒。
//
// 成因是契约与工具描述里都写着"没有变化就提交空增量"，而契约**每步都会重新注入**，
// 于是一个听话的模型会反复提交。现改为"每轮最多一次 + 空 delta 不是必须"。

test('输出契约：必须写明"每轮最多提交一次"，且不得再把空 delta 写成要求', async () => {
  const { OUTPUT_CONTRACT } = await import('../lib/context/renderer.js');
  const { DELTA_TOOL } = await import('../lib/llm/prompts.js');

  assert.ok(OUTPUT_CONTRACT.includes('每轮最多提交一次'), '契约必须明确每轮最多一次');
  assert.ok(/MUST NOT 反复提交空 delta/.test(OUTPUT_CONTRACT), '必须显式禁止反复提交空 delta');
  assert.ok(
    /没有变化就不必提交/.test(OUTPUT_CONTRACT),
    '空 delta 必须写成"不必"（许可），而不是"要提交"（要求）',
  );
  assert.ok(
    !/没有变化就调用一次空 delta/.test(OUTPUT_CONTRACT),
    'MUST NOT 再出现"没有变化就调用一次空 delta"这种把空提交写成要求的措辞',
  );

  // 工具描述同样要带上这条，因为模型读的是它
  assert.ok(/每轮最多提交一次/.test(DELTA_TOOL.description), '工具描述必须写明每轮最多一次');
  assert.ok(
    !/没有变化就提交空增量/.test(DELTA_TOOL.description),
    'MUST NOT 再出现"没有变化就提交空增量"',
  );
});
