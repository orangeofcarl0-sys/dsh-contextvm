/**
 * 检索策略审计：关键词为主 / embedding 为辅 / 摘要桥接
 * （§7.1 / §7.1.1 / §7.1.2）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createContextVm } from '../lib/app/create.js';
import { deriveBudgets } from '../lib/app/config.js';
import { WEIGHTS } from '../lib/retrieval/hybrid.js';
import { extractTerms, toMatchExpression } from '../lib/core/text.js';
import { fakeLlm } from './helpers.mjs';

const W = 262144;
const S = 'sess-r7';

const SUMMARY_JSON = JSON.stringify({
  topic: '波长标定与温漂补偿',
  goal: '固定基准波长并评估温漂',
  what_changed: ['基准波长定为 1064.37nm'],
  confirmed_decisions: ['采用 B 方案'],
  constraints_added_or_changed: ['基准波长 1064.37nm 不得更改'],
  rejected_options: [], open_questions: [], artifacts_touched: [],
  important_numbers_or_identifiers: ['1064.37nm'],
  source_event_range: { start_event: 'x', end_event: 'y' },
  search_keywords: ['波长', '温漂', '标定'],
});

function setup({ llm } = {}) {
  const vm = createContextVm({
    rawConfig: {},
    dbPath: ':memory:',
    llm: llm ?? fakeLlm([{ text: SUMMARY_JSON }, { text: SUMMARY_JSON }, { text: SUMMARY_JSON }]),
  });
  vm.runtime.setWindow(S, W);
  return { vm, budgets: deriveBudgets(vm.config, W) };
}

test('权重：lexical 排首位，semantic 降为与其它辅助分量同级（§7.1.1）', () => {
  assert.ok(WEIGHTS.lexical > WEIGHTS.semantic, `lexical ${WEIGHTS.lexical} 应高于 semantic ${WEIGHTS.semantic}`);
  assert.ok(WEIGHTS.lexical > WEIGHTS.summary);
  assert.ok(WEIGHTS.summary > WEIGHTS.semantic, '摘要桥接应比 embedding 更重要（它是主要召回路径）');
  const sum = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, `权重和应为 1，实际 ${sum}`);
});

test('术语抽取：FTS 与摘要检索共用同一实现（两字词/多字短语/ASCII 均可）', () => {
  assert.deepEqual(extractTerms('预检'), ['预 检']);
  assert.deepEqual(extractTerms('波长'), ['波 长']);
  assert.deepEqual(extractTerms('CAL-7F3A-91'), ['CAL-7F3A-91']);
  assert.ok(extractTerms('波长标定').includes('波 长'));
  assert.ok(extractTerms('波长标定').includes('标 定'));
  assert.equal(extractTerms('   ').length, 0);
  // MATCH 表达式由同一抽取结果构造
  assert.equal(toMatchExpression('预检'), '"预 检"');
});

test('embedding 缺失是默认状态：权重重归一化，不新增分支、不降功能', () => {
  const { vm } = setup();
  try {
    const e = vm.raw.append({ sessionId: S, role: 'user', eventType: 'user_message', content: '约束 波长 1064.37nm' });
    vm.state.upsert({ sessionId: S, itemType: 'constraint', key: 'wl', value: '1064.37nm', sourceEventIds: [e.eventId] });
    const c = vm.retriever.candidates(S, '波长')[0];
    assert.equal(c.components.semantic, undefined, '未接 embedding 时该分量不存在');
    const avail = Object.entries(WEIGHTS).filter(([k]) => c.components[k] !== undefined && c.components[k] !== null);
    // 无 episode 摘要时 summary 也不可用 → 5 个分量参与
    assert.equal(avail.length, 5);
    assert.ok(c.score > 0 && c.score <= 1.001, `归一化后得分应落在 (0,1]，实际 ${c.score}`);
  } finally {
    vm.close();
  }
});

test('embedding 可接入且会自动参与打分（可选分量，不需改调用方）', () => {
  const vm = createContextVm({
    rawConfig: {},
    dbPath: ':memory:',
    llm: fakeLlm([{ text: SUMMARY_JSON }]),
    semantic: { search: () => [] },
  });
  vm.runtime.setWindow(S, W);
  try {
    const e = vm.raw.append({ sessionId: S, role: 'user', eventType: 'user_message', content: '约束 波长' });
    const withPort = new (Object.getPrototypeOf(vm.retriever).constructor)({
      db: vm.db, raw: vm.raw, tokenizer: vm.tokenizer, lexical: vm.lexical, state: vm.state,
      config: vm.config, semantic: { search: () => [{ eventId: e.eventId, relevance: 1 }] },
    });
    const c = withPort.candidates(S, '波长')[0];
    assert.equal(c.components.semantic, 1);
    assert.ok(c.reasons.includes('semantic'));
  } finally {
    vm.close();
  }
});

test('摘要桥接：措辞与原始事件不同的查询仍能召回（embedding 原本的收益）', async () => {
  const { vm, budgets } = setup();
  try {
    // 原始事件里**不含**"温漂"二字，只在摘要里出现
    vm.raw.append({ sessionId: S, role: 'user', eventType: 'user_message', content: '环境温度变化会不会影响读数' });
    for (let i = 0; i < 300; i += 1) {
      vm.raw.append({ sessionId: S, role: 'user', eventType: 'user_message', content: `普通叙述内容用于填充历史长度。第 ${i} 条` });
    }
    // 造一个已摘要 episode，其摘要含"温漂补偿"
    const first = vm.raw.range(S)[0];
    const ep = vm.episodes.episodes.createOpen({ sessionId: S, startEventId: first.eventId });
    vm.episodes.episodes.close(ep.episodeId, { endEventId: first.eventId, rawTokenCount: 10 });
    vm.episodes.episodes.setSummary(ep.episodeId, { summary: 'topic: 波长标定与温漂补偿\nconstraints_added_or_changed: 基准波长 1064.37nm', summaryTokenCount: 20 });

    // 关键词直接检索："温漂"不在原始事件里 → 原始命中为空
    const rawOnly = vm.lexical.search(S, '温漂', { limit: 10 });
    assert.equal(rawOnly.length, 0, '前置条件：原始事件中不含该词');

    // 但摘要命中，且作为导航证据进入证据束
    const got = vm.retriever.retrieve(S, '温漂补偿', { tokenBudget: 4000 });
    const summaryBundle = got.bundles.find((b) => b.kind === 'episode_summary');
    assert.ok(summaryBundle, '应通过摘要召回');
    assert.equal(summaryBundle.episodeId, ep.episodeId);
    assert.ok(summaryBundle.content.includes('<episode_summary'));
    assert.ok(summaryBundle.content.includes('range='), '必须标注原始范围，便于模型按需取原文');
    assert.ok(summaryBundle.reason.includes('episode_summary'));
  } finally {
    vm.close();
  }
});

test('摘要证据不得挤掉原始证据，且分值低于原始命中（§6.3 / §7.1.2）', async () => {
  const { vm } = setup();
  try {
    const e = vm.raw.append({ sessionId: S, role: 'user', eventType: 'user_message', content: '约束 波长 1064.37nm 必须保持' });
    const ep = vm.episodes.episodes.createOpen({ sessionId: S, startEventId: e.eventId });
    vm.episodes.episodes.close(ep.episodeId, { endEventId: e.eventId, rawTokenCount: 10 });
    vm.episodes.episodes.setSummary(ep.episodeId, { summary: 'topic: 波长\nconstraints_added_or_changed: 波长 1064.37nm', summaryTokenCount: 15 });

    const got = vm.retriever.retrieve(S, '波长', { tokenBudget: 8000 });
    const idxRaw = got.bundles.findIndex((b) => b.kind === 'raw');
    const idxSummary = got.bundles.findIndex((b) => b.kind === 'episode_summary');
    assert.ok(idxRaw >= 0 && idxSummary >= 0, '两类证据都应存在');
    assert.ok(idxRaw < idxSummary, '原始证据必须排在摘要之前');
    assert.ok(got.bundles[idxSummary].score < got.bundles[idxRaw].score, '摘要分值应低于原始命中');
  } finally {
    vm.close();
  }
});

test('摘要证据也受预算约束，不漏标（§9.3 + §7.3）', () => {
  const { vm } = setup();
  try {
    const e = vm.raw.append({ sessionId: S, role: 'user', eventType: 'user_message', content: '温漂 波长' });
    const ep = vm.episodes.episodes.createOpen({ sessionId: S, startEventId: e.eventId });
    vm.episodes.episodes.close(ep.episodeId, { endEventId: e.eventId, rawTokenCount: 10 });
    vm.episodes.episodes.setSummary(ep.episodeId, { summary: `topic: 温漂\n${'细节'.repeat(500)}`, summaryTokenCount: 1000 });

    const tiny = vm.retriever.retrieve(S, '温漂', { tokenBudget: 5 });
    assert.equal(tiny.tokens, 0);
    assert.ok(tiny.dropped.summary >= 1, '装不下的摘要必须计入 dropped.summary');
  } finally {
    vm.close();
  }
});

test('摘要检索：未摘要的 episode 不参与（不拿半成品当导航）', () => {
  const { vm } = setup();
  try {
    const e = vm.raw.append({ sessionId: S, role: 'user', eventType: 'user_message', content: '温漂 内容' });
    const ep = vm.episodes.episodes.createOpen({ sessionId: S, startEventId: e.eventId });
    vm.episodes.episodes.close(ep.episodeId, { endEventId: e.eventId, rawTokenCount: 10 }); // 保持 summary_pending
    assert.deepEqual(vm.episodes.episodes.searchSummaries(S, '温漂'), []);
  } finally {
    vm.close();
  }
});
