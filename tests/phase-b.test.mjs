/**
 * Phase B 审计与验收：Episode 管理 / 摘要 / BROAD 导航 / 分层摘要
 * （§4.3 / §6 / §8.2 / §22.2 / §24.2）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createContextVm } from '../lib/app/create.js';
import { deriveBudgets } from '../lib/app/config.js';
import { validateEpisodeSummary, renderEpisodeSummary } from '../lib/llm/schemas.js';
import { fakeLlm } from './helpers.mjs';

const W = 262144;
const S = 'sess-b';

const SUMMARY_JSON = JSON.stringify({
  topic: '波长标定',
  goal: '确定并固定基准波长',
  what_changed: ['基准波长从 1053nm 改为 1064.37nm'],
  confirmed_decisions: ['采用 B 方案实现'],
  constraints_added_or_changed: ['基准波长必须为 1064.37nm'],
  rejected_options: ['rolling summary 方案已否决'],
  open_questions: ['温度补偿是否需要'],
  artifacts_touched: ['calib.md'],
  important_numbers_or_identifiers: ['1064.37nm', 'CAL-7F3A-91'],
  source_event_range: { start_event: 'evt_x', end_event: 'evt_y' },
  search_keywords: ['波长', '标定', '1064'],
});

/** 前 failTimes 次抛错，之后返回合法摘要。 */
function flakyLlm(failTimes) {
  return {
    calls: 0,
    async complete() {
      this.calls += 1;
      if (this.calls <= failTimes) throw new Error('upstream 502 provider_unavailable');
      return { text: SUMMARY_JSON, toolCalls: [], usage: { input_tokens: 10, output_tokens: 10 }, stopReason: { kind: 'stop' } };
    },
  };
}

function setup({ llm } = {}) {
  const vm = createContextVm({
    rawConfig: {},
    dbPath: ':memory:',
    llm: llm ?? fakeLlm([{ text: SUMMARY_JSON }, { text: SUMMARY_JSON }, { text: '{}' }]),
  });
  vm.runtime.setWindow(S, W);
  return { vm, budgets: deriveBudgets(vm.config, W) };
}

/**
 * 写入指定 token 量的原始事件。
 * 用长行以减少事件条数（否则验收测试会因上万次 FTS 插入而变慢）。
 */
function fill(vm, sessionId, { tokens, startAt = 0, taskId = null, gapMs = 0, baseTime = Date.parse('2026-09-17T00:00:00Z') }) {
  const line = '普通叙述内容，用于把 episode 推到目标长度。'.repeat(16); // ≈ 300+ chars
  const per = vm.tokenizer.estimate(line);
  const n = Math.max(1, Math.ceil(tokens / per));
  const ids = [];
  for (let i = 0; i < n; i += 1) {
    ids.push(
      vm.raw.append({
        sessionId,
        role: i % 2 ? 'assistant' : 'user',
        eventType: i % 2 ? 'assistant_message' : 'user_message',
        content: `${line}（第 ${startAt + i} 条）`,
        taskId,
        createdAt: new Date(baseTime + i * (1000 + gapMs)).toISOString(),
      }).eventId,
    );
  }
  return ids;
}

test('Episode 摘要契约：字段规范化与幻觉字段拒绝（§6.2 / §27.3）', () => {
  const ok = validateEpisodeSummary(JSON.parse(SUMMARY_JSON));
  assert.equal(ok.ok, true);
  assert.equal(ok.summary.topic, '波长标定');
  assert.deepEqual(ok.summary.importantNumbersOrIdentifiers, ['1064.37nm', 'CAL-7F3A-91']);

  assert.equal(validateEpisodeSummary({ topic: 1 }).ok, false);
  assert.equal(validateEpisodeSummary({ what_changed: 'not-an-array' }).ok, false);
  assert.equal(validateEpisodeSummary({ source_event_range: { start_event: 1 } }).ok, false);
  assert.equal(validateEpisodeSummary('nope').ok, false);

  const text = renderEpisodeSummary(ok.summary);
  assert.ok(text.includes('1064.37nm'));
  assert.ok(text.includes('rejected_options'));
  assert.ok(text.includes('source_event_range'));
});

test('episode 边界：累计 token 达标即关闭并置 summary_pending（§6.1-1）', async () => {
  const { vm, budgets } = setup();
  try {
    fill(vm, S, { tokens: budgets.episode.targetRaw + 500 });
    const r = await vm.episodes.sync({ sessionId: S, budgets, summarize: false });
    assert.equal(r.closeReasons[0], 'token_target');
    assert.ok(r.closed.length >= 1);
    const st = vm.episodes.episodes.stats(S);
    assert.equal(st.summary_pending, 1);
    assert.equal(st.open, 1, '关闭后应开启下一个，避免后续事件落在已关闭 episode 上');
  } finally {
    vm.close();
  }
});

test('episode 边界：task 切换触发关闭（§6.1-2）', async () => {
  const { vm, budgets } = setup();
  try {
    fill(vm, S, { tokens: 300, taskId: 'task-1' });
    await vm.episodes.sync({ sessionId: S, budgets, summarize: false });
    fill(vm, S, { tokens: 300, startAt: 100, taskId: 'task-2' });
    const r = await vm.episodes.sync({ sessionId: S, budgets, summarize: false });
    assert.ok(r.closeReasons.includes('task_switch'), `实际 ${JSON.stringify(r.closeReasons)}`);
  } finally {
    vm.close();
  }
});

test('episode 边界：长空闲触发关闭（§6.1-5 代理）', async () => {
  const { vm, budgets } = setup();
  try {
    // 注意：填充行约 208 token/条，取值必须保证产生多条事件，否则没有"相邻边界"可判
    fill(vm, S, { tokens: 800, gapMs: 60 * 60 * 1000 });
    assert.ok(vm.raw.count(S) >= 3, '需要多条事件才能判定边界');
    const r = await vm.episodes.sync({ sessionId: S, budgets, summarize: false });
    assert.ok(r.closeReasons.includes('idle_gap'), `实际 ${JSON.stringify(r.closeReasons)}`);
  } finally {
    vm.close();
  }
});

test('episode 边界：未达阈值且无其它触发时不关闭', async () => {
  const { vm, budgets } = setup();
  try {
    fill(vm, S, { tokens: 800 }); // 多条事件，但远低于 targetRaw
    assert.ok(vm.raw.count(S) >= 3);
    const r = await vm.episodes.sync({ sessionId: S, budgets, summarize: false });
    assert.deepEqual(r.closeReasons, []);
    assert.equal(vm.episodes.episodes.stats(S).open, 1);
    assert.equal(vm.episodes.episodes.stats(S).summary_pending, 0);
  } finally {
    vm.close();
  }
});

test('分段回填：一次 sync 跨越数倍目标历史时切成多个有界 episode（§6.1）', async () => {
  const { vm, budgets } = setup();
  try {
    fill(vm, S, { tokens: budgets.episode.targetRaw * 3 });
    const r = await vm.episodes.sync({ sessionId: S, budgets, summarize: false });
    assert.ok(r.closed.length >= 2, `应切成多段，实际 ${r.closed.length}`);
    for (const ep of vm.episodes.episodes.closed(S)) {
      assert.ok(
        ep.rawTokenCount <= budgets.episode.maxRaw,
        `单段 ${ep.rawTokenCount} 不得超过 maxRaw(${budgets.episode.maxRaw})`,
      );
    }
    const total = vm.episodes.episodes.closed(S).reduce((a, e) => a + e.rawTokenCount, 0);
    assert.ok(total > budgets.episode.targetRaw * 2, '分段不得丢事件');
  } finally {
    vm.close();
  }
});

test('摘要成功：写入 summary 并置 summarized，导航可读（§6.2）', async () => {
  const { vm, budgets } = setup();
  try {
    fill(vm, S, { tokens: budgets.episode.targetRaw + 500 });
    const r = await vm.episodes.sync({ sessionId: S, budgets, summarize: true });
    assert.equal(r.summarized, 1);
    const summarized = vm.episodes.episodes.summarized(S);
    assert.equal(summarized.length, 1);
    assert.ok(summarized[0].summary.includes('1064.37nm'));
    assert.ok(summarized[0].summaryTokenCount > 0);

    const nav = vm.episodes.navigator({ sessionId: S, tokenBudget: 2000 });
    assert.equal(nav.blocks.length, 1);
    assert.equal(nav.blocks[0].topic, '波长标定');
  } finally {
    vm.close();
  }
});

test('摘要失败：保持 summary_pending，原始事件不受影响（§22.2）', async () => {
  const { vm, budgets } = setup({ llm: flakyLlm(99) });
  try {
    fill(vm, S, { tokens: budgets.episode.targetRaw + 500 });
    const before = vm.raw.count(S);
    const r = await vm.episodes.sync({ sessionId: S, budgets, summarize: true });
    assert.equal(r.summarized, 0);
    const st = vm.episodes.episodes.stats(S);
    assert.equal(st.summary_pending, 1, '摘要失败必须保持 pending 以便重试');
    assert.equal(vm.raw.count(S), before, '原始事件 MUST NOT 受影响');
    assert.equal(st.open, 1, '新 episode 的开启不受阻塞');
  } finally {
    vm.close();
  }
});

test('摘要重试：上游恢复后 pending 转为 summarized（§22.2）', async () => {
  const { vm, budgets } = setup({ llm: flakyLlm(1) });
  try {
    fill(vm, S, { tokens: budgets.episode.targetRaw + 500 });
    const first = await vm.episodes.sync({ sessionId: S, budgets, summarize: true });
    assert.equal(first.summarized, 0, '首次调用应失败');
    assert.equal(vm.episodes.episodes.pendingSummaries(S).length, 1);

    const retry = await vm.episodes.summarizePending({ sessionId: S, budgets, limit: 2 });
    assert.equal(retry.summarized, 1, '重试应成功');
    assert.equal(vm.episodes.episodes.pendingSummaries(S).length, 0);
    assert.equal(vm.episodes.episodes.stats(S).summarized, 1);
  } finally {
    vm.close();
  }
});

test('BROAD：编译产物含 episode 导航段，且不声称完整（§8.2/§8.3）', async () => {
  const { vm, budgets } = setup();
  try {
    fill(vm, S, { tokens: budgets.episode.targetRaw + 500 });
    await vm.episodes.sync({ sessionId: S, budgets, summarize: true });

    const broad = vm.runtime.compile({ sessionId: S, query: '以前讨论过哪些标定决定', mode: 'BROAD' });
    assert.equal(broad.mode, 'BROAD');
    assert.equal(broad.coverage.complete, false);
    assert.equal(broad.coverage.reason, 'broad_navigation_only');
    assert.ok(broad.includedEpisodeIds.length >= 1, '应引用 episode');
    const nav = broad.renderedSections.find((s) => s.title === 'Episode navigator');
    assert.ok(nav, 'BROAD 必须有导航段');
    assert.ok(nav.content.includes('波长标定'));

    const local = vm.runtime.compile({ sessionId: S, query: '继续', mode: 'LOCAL' });
    assert.ok(!local.renderedSections.some((s) => s.title === 'Episode navigator'), 'LOCAL 不注入导航段');
    assert.deepEqual(local.includedEpisodeIds, []);
  } finally {
    vm.close();
  }
});

test('证据回填 episode_id（§7.4 provenance）', async () => {
  const { vm, budgets } = setup();
  try {
    const secret = vm.raw.append({
      sessionId: S, role: 'user', eventType: 'user_message',
      content: '基准波长 1064.37nm 与编号 CAL-7F3A-91',
    });
    fill(vm, S, { tokens: budgets.episode.targetRaw + 500, startAt: 1 });
    await vm.episodes.sync({ sessionId: S, budgets, summarize: true });

    const ctx = vm.runtime.compile({ sessionId: S, query: '基准波长是多少', mode: 'BROAD' });
    const withEpisode = ctx.evidenceManifest.filter((e) => e.episodeId);
    assert.ok(withEpisode.length >= 1, '命中事件落在已关闭 episode 内时应回填 episodeId');
    assert.ok(withEpisode[0].episodeId.startsWith('ep_'));
    assert.ok(ctx.evidenceManifest.some((e) => e.sourceEventIds.includes(secret.eventId)));
  } finally {
    vm.close();
  }
});

test('分层摘要：>20 段时生成 meta，且是确定性抽取、不递归（§6.4）', async () => {
  const { vm } = setup();
  try {
    for (let i = 0; i < 21; i += 1) {
      const e = vm.raw.append({ sessionId: 'meta-s', role: 'user', eventType: 'user_message', content: `段 ${i}` });
      const ep = vm.episodes.episodes.createOpen({ sessionId: 'meta-s', startEventId: e.eventId });
      vm.episodes.episodes.close(ep.episodeId, { endEventId: e.eventId, rawTokenCount: 100 });
      vm.episodes.episodes.setSummary(ep.episodeId, {
        summary: `topic: 主题${i}\nwhat_changed: 变化${i}`, summaryTokenCount: 10,
      });
    }
    const meta1 = vm.episodes.metaSummaries('meta-s');
    const meta2 = vm.episodes.metaSummaries('meta-s');
    assert.ok(meta1.length >= 3, `21 段按 10 分组应得 3 组，实际 ${meta1.length}`);
    assert.deepEqual(meta1, meta2, 'meta 必须是确定性结果');
    assert.equal(meta1[0].id, 'M01');
    assert.ok(meta1[0].digest.includes('主题0'));
    assert.ok(meta1[0].range[0].startsWith('ep_'));
    assert.deepEqual(vm.episodes.metaSummaries(S), [], '未超过 20 段时不生成 meta');
  } finally {
    vm.close();
  }
});

test('Phase B 验收：长历史的 episode 数增长，单段尺寸受上界约束（§6.1 保真度）', async () => {
  const { vm, budgets } = setup();
  try {
    fill(vm, S, { tokens: budgets.episode.targetRaw * 2.5 });
    const r = await vm.episodes.sync({ sessionId: S, budgets, summarize: true });
    const closed = vm.episodes.episodes.closed(S);
    assert.ok(closed.length >= 2, `应产生多个 episode，实际 ${closed.length}`);
    for (const ep of closed) {
      assert.ok(ep.rawTokenCount <= budgets.episode.maxRaw);
    }

    // 大窗口下 clamp 生效：不随 W 线性外推
    const big = deriveBudgets(vm.config, 1048576);
    assert.equal(big.episode.targetRaw, 64000);
    assert.ok(big.episode.targetRaw < 0.153 * 1048576);

    // 导航在预算内可用
    const nav = vm.episodes.navigator({ sessionId: S, tokenBudget: 2000 });
    assert.ok(nav.blocks.length >= 1);
    assert.ok(nav.tokens <= 2000);
  } finally {
    vm.close();
  }
});

test('轮末钩子推进 episode 且不影响回答（§15.2 非关键路径）', async () => {
  const { vm, budgets } = setup();
  const handlers = new Map();
  const ctx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    on(e, fn) { handlers.set(e, fn); },
    get: () => null,
    tools: { register() {} },
  };
  const { applySeams } = await import('../lib/host/seams.js');
  try {
    vm.runtime.setWindow(S, W);
    applySeams(ctx, vm, {});
    fill(vm, S, { tokens: budgets.episode.targetRaw + 500 });

    const events = [
      { type: 'user/message', seq: 1000, time: Date.now(), data: { content: [{ type: 'text', text: '问' }] } },
      { type: 'assistant/message', seq: 1001, time: Date.now(), data: { message: { content: [{ type: 'text', text: '答' }] } } },
    ];
    const session = { id: S, requestHeader: () => ({}), snapshotEvents: () => events };
    handlers.get('agent/turn-stopping')({ agent: { session }, turn: 1 });

    await new Promise((r) => setTimeout(r, 120));
    assert.ok(vm.episodes.episodes.closed(S).length >= 1, '轮末应推进 episode 边界');
  } finally {
    vm.close();
  }
});
