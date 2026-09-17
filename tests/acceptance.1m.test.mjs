/**
 * 规范 §24.2 合成长期记忆验收（1M+ token 语料）+ §24.3 目标指标。
 *
 * 语料按 §24.2 的规定构造：
 *   - 1M+ token 的合成对话；
 *   - 100 个精确数字约束；
 *   - 100 个名称/ID；
 *   - 50 个后来被 superseded 的决定；
 *   - 50 个否决项；
 *   - 多个**相似但不同**的参数。
 *
 * 五类测试：Exact Recall / Supersession / Negative Memory / Cross-Episode / Global Completeness。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createContextVm } from '../lib/app/create.js';
import { deriveBudgets } from '../lib/app/config.js';
import { fakeLlm } from './helpers.mjs';

const W = 262144;
const S = 'accept-1m';
const FILLER =
  '这是一段用于填充合成历史的普通叙述，不含任何关键信息，仅用于把上下文推到百万 token 量级。'.repeat(9);

const NUMERIC_COUNT = 100;
const ID_COUNT = 100;
const SUPERSEDE_COUNT = 50;
const REJECT_COUNT = 50;

const SUMMARY_JSON = JSON.stringify({
  topic: '合成长期记忆验收', goal: '验证 1M 历史下的召回与状态正确性',
  what_changed: [], confirmed_decisions: [], constraints_added_or_changed: [],
  rejected_options: [], open_questions: [], artifacts_touched: [],
  important_numbers_or_identifiers: [], source_event_range: { start_event: 'a', end_event: 'b' },
  search_keywords: ['验收'],
});

/** 确定性伪随机（保证语料可复现，§24.4）。 */
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * 构造 1M+ token 语料。
 * @returns {object} ground truth
 */
function buildCorpus(vm) {
  const rnd = lcg(20260917);
  const gt = {
    numeric: [], ids: [], superseded: [], rejected: [], similar: [],
    earlyFact: null, lateFact: null,
  };
  /** @type {Array<object>} */
  const batch = [];
  const push = (content, extra = {}) =>
    batch.push({
      sessionId: S,
      role: extra.role ?? 'user',
      eventType: extra.eventType ?? 'user_message',
      content,
      createdAt: new Date(Date.UTC(2026, 0, 1) + batch.length * 60000).toISOString(),
      taskId: extra.taskId ?? null,
    });

  // ---- 早期埋点（Cross-Episode 的一端）----
  push('早期基线：设备序列号 SN-ALPHA-0001，初始标称波长 1053.00nm。这两项后面不再重复。');
  gt.earlyFact = { sn: 'SN-ALPHA-0001', wavelength: '1053.00nm' };

  // ---- 精确数字约束 100 条（分散在语料中）----
  for (let i = 0; i < NUMERIC_COUNT; i += 1) {
    const value = `${1000 + i}.${String(i).padStart(2, '0')}nm`;
    gt.numeric.push({ key: `N${String(i + 1).padStart(3, '0')}`, value, query: `约束 N${String(i + 1).padStart(3, '0')} 波长` });
  }

  // ---- 名称/ID 100 条 ----
  for (let i = 0; i < ID_COUNT; i += 1) {
    const id = `CAL-${String(i + 1).padStart(4, '0')}-X${String.fromCharCode(65 + (i % 26))}`;
    gt.ids.push({ id, query: `编号 ${id}` });
  }

  // ---- 相似但不同的参数（用于区分度测试）----
  for (const v of ['1064.00nm', '1064.01nm', '1064.10nm', '1064.11nm']) {
    gt.similar.push({ value: v, query: `参数取值 ${v}` });
  }

  // ---- 交错写入：特殊事件 + 填充，直到 token 量达标 ----
  const specials = [];
  gt.numeric.forEach((n, i) => specials.push(`精确约束 ${n.key}：波长必须为 ${n.value}，不得更改。`));
  gt.ids.forEach((x) => specials.push(`本次验收编号为 ${x.id}，请记录在案。`));
  gt.similar.forEach((x) => specials.push(`参数取值 ${x.value} 是候选之一。`));
  // 决定的 v1 与 v2（v2 写在语料后段，模拟"后来改主意"）
  const decV1 = [];
  for (let i = 0; i < SUPERSEDE_COUNT; i += 1) {
    decV1.push(`决定 D${String(i + 1).padStart(3, '0')}：先按方案 A 实现（键 plan-${i + 1}）。`);
    gt.superseded.push({ key: `plan-${i + 1}`, v1: '方案 A', v2: '方案 B', query: `决定 plan-${i + 1} 当前方案` });
  }
  const decV2 = gt.superseded.map((s) => `决定更新：键 ${s.key} 改用方案 B，方案 A 作废。`);
  const rejects = [];
  for (let i = 0; i < REJECT_COUNT; i += 1) {
    rejects.push(`否决 REJ${String(i + 1).padStart(3, '0')}：不要采用滚动摘要方案 ${i + 1}，已明确否决。`);
    gt.rejected.push({ key: `rej-${i + 1}`, value: `滚动摘要方案 ${i + 1}`, query: `否决项 REJ${String(i + 1).padStart(3, '0')}` });
  }
  // 晚期埋点（Cross-Episode 的另一端）
  const late = `晚期结论：设备 SN-ALPHA-0001 的最终标定波长为 1064.37nm，与早期标称值不同。`;
  gt.lateFact = { wavelength: '1064.37nm' };

  const specialQueue = [
    ...specials,
    ...decV1,
    ...rejects,
    ...decV2,
  ];
  let si = 0;
  const targetTokens = 1_020_000;
  let tokens = 0;
  const perFiller = vm.tokenizer.estimate(FILLER);
  while (tokens < targetTokens) {
    if (si < specialQueue.length && rnd() < 0.25) {
      const c = specialQueue[si];
      push(c);
      si += 1;
      tokens += vm.tokenizer.estimate(c);
    } else {
      push(`${FILLER}（第 ${batch.length} 段）`);
      tokens += perFiller;
    }
  }
  while (si < specialQueue.length) {
    push(specialQueue[si]);
    si += 1;
  }
  // 晚期埋点**在语料铺满之后**追加：Cross-Episode 要求两端相距 > 500k token，
  // 若混入随机队列会被提前消费，间距就不成立了。
  push(late);

  const inserted = vm.raw.appendAll(batch);
  return { gt, inserted };
}

/**
 * 脚本化 llm 端口：按 purpose 分流。
 * - global_worker：从提示里解析本块的 start/end，为其覆盖范围内每条精确约束产出 finding；
 * - episode_summary：返回固定摘要；
 * - 其它：空对象。
 * 该脚本与真实 worker 的契约一致（§11.2），因此覆盖校验是被真正 exercised 的。
 */
function scriptedLlm() {
  return {
    calls: { worker: 0, summary: 0, other: 0 },
    async complete(req) {
      const body = req.messages.map((m) => m.content).join('\n');
      const purpose = req.purpose;
      if (purpose === 'global_worker') {
        this.calls.worker += 1;
        const startEvent = /^start_event: (\S+)$/m.exec(body)?.[1] ?? null;
        const endEvent = /^end_event: (\S+)$/m.exec(body)?.[1] ?? null;
        const findings = [];
        for (const line of body.split('\n')) {
          const m = /^\[[a-z_]+\s+(\S+)\]\s*(.+)$/.exec(line.trim());
          if (!m) continue;
          if (!/精确约束 N\d{3}/.test(m[2])) continue;
          findings.push({
            claim: m[2].slice(0, 80),
            source_event_ids: [m[1]],
            category: 'constraint',
            relevance: 0.9,
            conflict_with: [],
          });
        }
        return {
          text: JSON.stringify({
            findings,
            coverage: { start_event: startEvent, end_event: endEvent, complete: true },
          }),
          toolCalls: [],
          usage: { input_tokens: 1000, output_tokens: 50 },
          stopReason: { kind: 'stop' },
        };
      }
      if (purpose === 'episode_summary') {
        this.calls.summary += 1;
        return { text: SUMMARY_JSON, toolCalls: [], usage: { input_tokens: 100, output_tokens: 50 }, stopReason: { kind: 'stop' } };
      }
      this.calls.other += 1;
      return { text: '{}', toolCalls: [], usage: { input_tokens: 10, output_tokens: 5 }, stopReason: { kind: 'stop' } };
    },
  };
}

test('§24.2 合成 1M 语料 + §24.3 目标指标', async () => {
  const started = Date.now();
  const llm = scriptedLlm();
  const vm = createContextVm({ rawConfig: {}, dbPath: ':memory:', llm });
  const budgets = deriveBudgets(vm.config, W);
  vm.runtime.setWindow(S, W);

  const { gt, inserted } = buildCorpus(vm);
  const rawTokens = vm.raw.totalTokens(S);
  const rawCount = vm.raw.count(S);

  // ---- §24.2：语料规模 ----
  assert.ok(rawTokens >= 1_000_000, `原始历史应 >= 1M token，实际 ${rawTokens}`);
  assert.equal(rawCount, inserted.length);
  console.error(`[1M 语料] 事件 ${rawCount} 条 / 估算 ${rawTokens} token / 构建 ${Date.now() - started}ms`);

  // ---------------- Exact Recall（§24.2 / §24.3 ≥99%） ----------------
  const probes = [...gt.numeric, ...gt.ids];
  let exactHit = 0;
  const exactMisses = [];
  for (const p of probes) {
    const cands = vm.retriever.candidates(S, p.query, { limits: { merged: 20 } });
    const ok = cands.some((c) => {
      const ev = vm.raw.get(c.eventId);
      return ev && ev.content.includes(p.value ?? p.id);
    });
    if (ok) exactHit += 1;
    else exactMisses.push(p.query);
  }
  const exactRecall = exactHit / probes.length;
  assert.ok(
    exactRecall >= 0.99,
    `Exact identifier recall 应 >= 99%，实际 ${(exactRecall * 100).toFixed(1)}%（漏 ${exactMisses.length}：${exactMisses.slice(0, 5).join(' / ')}）`,
  );

  // 相似但不同的参数必须能被区分（正确者排第一）
  for (const s of gt.similar) {
    const cands = vm.retriever.candidates(S, s.query, { limits: { merged: 20 } });
    const top = cands[0] && vm.raw.get(cands[0].eventId);
    assert.ok(top && top.content.includes(s.value), `${s.value} 应排在首位，实际首位为 ${top?.content?.slice(0, 40)}`);
  }

  // ---------------- Supersession（§24.2 / §24.3 ≥99%） ----------------
  let superOk = 0;
  for (const [i, s] of gt.superseded.entries()) {
    const v1ev = inserted.find((e) => e.content.includes(`键 plan-${i + 1}）`));
    const v2ev = inserted.find((e) => e.content.includes(`键 ${s.key} 改用方案 B`));
    vm.state.upsert({ sessionId: S, itemType: 'decision', key: s.key, value: s.v1, sourceEventIds: [v1ev.eventId] });
    vm.state.upsert({ sessionId: S, itemType: 'decision', key: s.key, value: s.v2, sourceEventIds: [v2ev.eventId] });
  }
  const activeDecisions = vm.state.active(S).filter((i) => i.itemType === 'decision');
  assert.equal(activeDecisions.length, SUPERSEDE_COUNT, '每个键只应有一个 active 决定');
  for (const d of activeDecisions) if (d.value === '方案 B') superOk += 1;
  const superCorrect = superOk / SUPERSEDE_COUNT;
  assert.ok(superCorrect >= 0.99, `active-vs-superseded 正确率应 >= 99%，实际 ${(superCorrect * 100).toFixed(1)}%`);

  // 编译产物中当前结论必须是 v2，且 superseded 的 v1 不得作为当前结论出现
  const compiled = vm.runtime.compile({ sessionId: S, query: '当前各决定的方案是什么' });
  const constraintsSection = compiled.renderedSections.map((s) => s.content).join('\n');
  assert.ok(constraintsSection.includes('方案 B'), '当前结论必须进入上下文');
  const history = vm.state.history(S, 'decision', 'plan-1');
  assert.deepEqual(history.map((h) => [h.version, h.value, h.status]), [
    [1, '方案 A', 'superseded'],
    [2, '方案 B', 'active'],
  ]);

  // ---------------- Negative Memory（§24.2） ----------------
  for (const [i, r] of gt.rejected.entries()) {
    const ev = inserted.find((e) => e.content.includes(`REJ${String(i + 1).padStart(3, '0')}`));
    const res = vm.state.upsert({
      sessionId: S, itemType: 'rejected_option', key: r.key, value: r.value, sourceEventIds: [ev.eventId],
    });
    vm.state.setStatus(res.item.stateId, 'rejected');
  }
  const activeValues = vm.state.active(S).map((i) => String(i.value));
  for (const r of gt.rejected) {
    assert.ok(!activeValues.includes(r.value), `否决项「${r.value}」不得出现在 active 状态`);
  }
  assert.equal(vm.state.stats(S).rejected, REJECT_COUNT);
  // 否决项仍可被检索到（可追溯，而不是被抹掉）
  const rejHit = vm.retriever.candidates(S, gt.rejected[0].query, { limits: { merged: 10 } });
  assert.ok(rejHit.length > 0, '否决项必须仍可检索（raw 永不删）');

  // ---------------- Cross-Episode（§24.2） ----------------
  // 早期标称值与晚期结论相距 > 500k token
  const earlyEv = inserted.find((e) => e.content.includes('SN-ALPHA-0001'));
  const lateEv = inserted.find((e) => e.content.includes('最终标定波长'));
  const earlySeq = vm.raw.get(earlyEv.eventId).seq;
  const lateSeq = vm.raw.get(lateEv.eventId).seq;
  const spanTokens = vm.raw
    .range(S, { fromSeq: earlySeq, toSeq: lateSeq })
    .reduce((a, e) => a + e.tokenCount, 0);
  assert.ok(spanTokens > 500_000, `两端应相距 > 500k token，实际 ${spanTokens}`);

  const cross = vm.retriever.retrieve(S, 'SN-ALPHA-0001 最终标定波长', { tokenBudget: 20_000 });
  const crossIds = new Set(cross.bundles.flatMap((b) => b.sourceEventIds));
  assert.ok(
    crossIds.has(earlyEv.eventId) || cross.bundles.some((b) => b.content.includes('SN-ALPHA-0001')),
    '跨段问题必须能同时触达早期事实',
  );

  // ---------------- Global Completeness（§24.2 / §24.3） ----------------
  const scan = await vm.runtime.exhaustiveScan({ sessionId: S, query: '列出全部精确约束' });
  assert.equal(scan.coverage.complete, true, `覆盖必须完整：${JSON.stringify(scan.coverage)}`);
  assert.equal(scan.coverage.coveredChunks, scan.coverage.chunks);
  const found = new Set(scan.findings.flatMap((f) => f.sourceEventIds));
  const numericEvents = inserted.filter((e) => /精确约束 N\d{3}/.test(e.content));
  const hitCount = numericEvents.filter((e) => found.has(e.eventId)).length;
  const findingRecall = hitCount / numericEvents.length;
  assert.ok(
    findingRecall >= 0.98,
    `Global finding recall 应 >= 98%，实际 ${(findingRecall * 100).toFixed(1)}%（${hitCount}/${numericEvents.length}）`,
  );

  // GLOBAL 编译须给出完整声明
  const globalCtx = vm.runtime.compile({ sessionId: S, query: '列出全部精确约束，不要遗漏', mode: 'GLOBAL' });
  assert.equal(globalCtx.coverage.complete, true);
  assert.equal(globalCtx.coverage.reason, 'exhaustive_scan');

  // ---------------- Raw traceability / Provenance（§24.3 = 100%） ----------------
  let evidenceRefs = 0;
  let traceable = 0;
  for (const b of cross.bundles) {
    for (const id of b.sourceEventIds) {
      evidenceRefs += 1;
      if (vm.raw.has(id)) traceable += 1;
    }
  }
  assert.ok(evidenceRefs > 0);
  assert.equal(traceable, evidenceRefs, '所有证据来源必须可追溯到原始事件');
  assert.equal(vm.state.countWithoutProvenance(S), 0, 'active 状态 100% 具备 provenance');

  // ---------------- 预算不变量（§24.3 = 100%） ----------------
  for (const mode of ['LOCAL', 'BROAD', 'GLOBAL']) {
    const c = vm.runtime.compile({ sessionId: S, query: '当前状态与结论', mode });
    assert.ok(
      c.tokenCount <= budgets.hardInputCap,
      `${mode} 编译 ${c.tokenCount} 必须 <= hard cap ${budgets.hardInputCap}`,
    );
  }

  // ---------------- 恢复能力（§24.3 pass） ----------------
  // 语义索引失败：检索仍工作，且状态标记为降级
  assert.equal(vm.runtime.semanticStatus().status, 'disabled');
  assert.ok(vm.runtime.semanticStatus().note.includes('降级'));
  const brokenSemantic = createContextVm({
    rawConfig: {}, dbPath: ':memory:', llm: fakeLlm([{ text: '{}' }]),
    semantic: { search() { throw new Error('embedding provider 不可达'); } },
  });
  brokenSemantic.runtime.setWindow(S, W);
  try {
    brokenSemantic.raw.append({ sessionId: S, role: 'user', eventType: 'user_message', content: '语义失败时关键词仍须可用' });
    // §22.3：embedding 抛错 MUST NOT 拖垮检索，且状态必须据实降级
    assert.equal(brokenSemantic.runtime.semanticStatus().status, 'ok', '尚未调用前应报 ok');
    const c = brokenSemantic.retriever.candidates(S, '关键词');
    assert.ok(c.length >= 1, '关键词检索不受 embedding 失败影响');
    const st = brokenSemantic.runtime.semanticStatus();
    assert.equal(st.status, 'degraded', 'embedding 失败后状态必须变为 degraded');
    assert.ok(String(st.lastError).includes('不可达'));
    assert.ok(st.note.includes('降级'));
    // 权重按缺分量规则重归一化，得分仍在有效区间
    assert.ok(c[0].components.semantic === undefined, '失败的分量不得进入打分');
    assert.ok(c[0].score > 0 && c[0].score <= 1.001);
  } finally {
    brokenSemantic.close();
  }

  console.error(
    `[§24.3] exact=${(exactRecall * 100).toFixed(1)}% supersession=${(superCorrect * 100).toFixed(1)}% ` +
      `coverage=${scan.coverage.coveredChunks}/${scan.coverage.chunks} findingRecall=${(findingRecall * 100).toFixed(1)}% ` +
      `traceable=${traceable}/${evidenceRefs} 总耗时=${Date.now() - started}ms`,
  );
  vm.close();
});
