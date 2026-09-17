/**
 * Phase C 审计与验收：分块 / worker / reducer / 覆盖校验 / GLOBAL 编译
 * （§8.3 / §11 / §12 / §23.3 / §24.3）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createContextVm } from '../lib/app/create.js';
import { deriveBudgets, resolveConfig } from '../lib/app/config.js';
import { splitIntoChunks, verifyChunkContiguity } from '../lib/global_scan/splitter.js';
import { reduceScan, detectConflicts } from '../lib/global_scan/reducer.js';
import { validateWorkerResult } from '../lib/llm/schemas.js';
import { renderCoverage } from '../lib/context/renderer.js';

const W = 262144;
const S = 'sess-c';

/** 把 chunk 目标压小，以便在测试里产生多块。 */
function smallChunks(extra = {}) {
  // 0.0002 * 262144 ≈ 52 token/块；配合约 25 token/条的填充 → 稳定切成多块
  return resolveConfig({ global_scan: { chunk_target_ratio: 0.0002, overlap_ratio: 0.00003 }, ...extra });
}

/**
 * 会读输入的假 worker：从提示里解析被分配的 chunk 范围，
 * 返回与之严格对应的 coverage；对含 marker 的事件各产出一条 finding。
 * 这样 reducer 的覆盖校验才真正被 exercised（而不是自说自话）。
 */
function scriptedWorkerLlm({ marker = '约束', failChunkIndex = -1, misreportChunkIndex = -1 } = {}) {
  let call = 0;
  return {
    calls: 0,
    /** 记录每次调用的 maxTokens，供"worker 输出受限"的断言使用（§17.1） */
    maxTokensSeen: [],
    async complete(req) {
      this.calls += 1;
      if (req.maxTokens !== undefined) this.maxTokensSeen.push(req.maxTokens);
      const body = req.messages.map((m) => m.content).join('\n');
      // 与 workerUserMessage 的格式保持一致：首尾 id 各自成行
      const startEvent = /^start_event: (\S+)$/m.exec(body)?.[1] ?? null;
      const endEvent = /^end_event: (\S+)$/m.exec(body)?.[1] ?? null;
      const idx = call;
      call += 1;

      if (idx === failChunkIndex) throw new Error('upstream 502 provider_unavailable');

      const findings = [];
      for (const line of body.split('\n')) {
        const m = /^\[[a-z_]+\s+(\S+)\]\s*(.+)$/.exec(line.trim());
        if (!m) continue;
        if (!m[2].includes(marker) && !/1064/.test(m[2])) continue;
        findings.push({
          claim: m[2].slice(0, 80),
          source_event_ids: [m[1]],
          category: 'constraint',
          relevance: 0.9,
          conflict_with: [],
        });
      }
      const reportedStart = idx === misreportChunkIndex ? 'evt_wrong' : startEvent;
      return {
        text: JSON.stringify({
          findings,
          coverage: { start_event: reportedStart, end_event: endEvent, complete: true },
        }),
        toolCalls: [],
        usage: { input_tokens: 100, output_tokens: 50 },
        stopReason: 'end_turn',
      };
    },
  };
}

function setup({ llm, config } = {}) {
  const vm = createContextVm({
    rawConfig: config ?? smallChunks(),
    dbPath: ':memory:',
    llm: llm ?? scriptedWorkerLlm(),
  });
  vm.runtime.setWindow(S, W);
  return { vm, budgets: deriveBudgets(vm.config, W) };
}

/** 写入 n 条事件，其中 marker 事件带可识别的编号。 */
function fill(vm, sessionId, { count, markerEvery = 0, prefix = '普通叙述内容用于填充本片段并推高长度。', startAt = 0 }) {
  const ids = [];
  const markerIds = [];
  for (let i = 0; i < count; i += 1) {
    const isMarker = markerEvery > 0 && i % markerEvery === markerEvery - 1;
    const content = isMarker
      ? `${prefix} 约束 C${startAt + i}：基准波长 1064.${(startAt + i) % 100}nm 必须保持。`
      : `${prefix}（第 ${startAt + i} 条）`;
    const id = vm.raw.append({
      sessionId,
      role: 'user',
      eventType: 'user_message',
      content,
    }).eventId;
    ids.push(id);
    if (isMarker) markerIds.push(id);
  }
  return { ids, markerIds };
}

test('分块：连续覆盖、带 overlap、优先 episode 边界（§11.1）', () => {
  const { vm, budgets } = setup();
  try {
    fill(vm, S, { count: 20 });
    const split = splitIntoChunks({
      raw: vm.raw, sessionId: S,
      tokenTarget: budgets.chunkTarget, overlapTokens: budgets.chunkOverlap,
    });
    assert.ok(split.chunks.length >= 2, `应切成多块，实际 ${split.chunks.length}`);
    const all = vm.raw.range(S);
    const contig = verifyChunkContiguity(split.chunks, all[0].seq, all.at(-1).seq);
    assert.equal(contig.contiguous, true, `不应有缺口：${JSON.stringify(contig.gaps)}`);
    // overlap：下一块的起点不晚于前一块的终点
    for (let i = 1; i < split.chunks.length; i += 1) {
      assert.ok(split.chunks[i].startSeq <= split.chunks[i - 1].endSeq, 'overlap 缺失');
    }
  } finally {
    vm.close();
  }
});

test('分块：单条超长事件不会导致死循环或丢事件', () => {
  const { vm, budgets } = setup();
  try {
    vm.raw.append({ sessionId: S, role: 'user', eventType: 'user_message', content: '超长事件 '.repeat(4000) });
    vm.raw.append({ sessionId: S, role: 'user', eventType: 'user_message', content: '短事件' });
    const split = splitIntoChunks({
      raw: vm.raw, sessionId: S,
      tokenTarget: budgets.chunkTarget, overlapTokens: budgets.chunkOverlap,
    });
    const covered = new Set(split.chunks.flatMap((c) => c.eventIds));
    assert.equal(covered.size, 2, '两条事件都必须被覆盖');
  } finally {
    vm.close();
  }
});

test('覆盖校验：块之间的缺口被检出（§11.3）', () => {
  const contig = verifyChunkContiguity([{ startSeq: 1, endSeq: 5 }, { startSeq: 8, endSeq: 12 }], 1, 12);
  assert.equal(contig.contiguous, false);
  assert.deepEqual(contig.gaps, [{ afterSeq: 5, beforeSeq: 8 }]);
  assert.equal(verifyChunkContiguity([{ startSeq: 1, endSeq: 6 }, { startSeq: 6, endSeq: 12 }], 1, 12).contiguous, true);
});

test('reducer：worker 自报范围与分配不符时记为缺口，禁止声称完整（§11.3）', () => {
  const chunk = { index: 0, startEventId: 'evt_a', endEventId: 'evt_b' };
  const good = { chunk, ok: true, result: { findings: [], coverage: { startEvent: 'evt_a', endEvent: 'evt_b', complete: true } } };
  const wrong = { chunk: { index: 1, startEventId: 'evt_c', endEventId: 'evt_d' }, ok: true, result: { findings: [], coverage: { startEvent: 'evt_wrong', endEvent: 'evt_d', complete: true } } };
  const failed = { chunk: { index: 2, startEventId: 'evt_e', endEventId: 'evt_f' }, ok: false, reason: 'llm_failed' };

  const okAll = reduceScan({ chunks: [chunk], results: [good], scope: { firstSeq: 1, lastSeq: 2 } });
  assert.equal(okAll.coverage.complete, true);
  assert.equal(okAll.coverage.reason, 'all_chunks_covered');

  const withWrong = reduceScan({ chunks: [chunk, wrong.chunk], results: [good, wrong], scope: { firstSeq: 1, lastSeq: 4 } });
  assert.equal(withWrong.coverage.complete, false);
  assert.equal(withWrong.coverage.gaps.length, 1);
  assert.equal(withWrong.coverage.reason, 'coverage_gaps');

  const withFail = reduceScan({ chunks: [chunk, failed.chunk], results: [good, failed], scope: { firstSeq: 1, lastSeq: 4 } });
  assert.equal(withFail.coverage.complete, false);
  assert.equal(withFail.coverage.reason, 'worker_failures');
  assert.equal(withFail.coverage.failedChunks.length, 1);
});

test('reducer：findings 去重，冲突双方均保留（§11.3）', () => {
  const chunk = { index: 0, startEventId: 'a', endEventId: 'b' };
  const f = (claim, src) => ({ claim, sourceEventIds: [src], category: 'decision', relevance: 1, conflictWith: [] });
  const res = {
    chunk, ok: true,
    result: {
      findings: [f('采用 A 方案', 'e1'), f('采用 A 方案', 'e1'), f(' 采用 A 方案 ', 'e1'), f('不采用 A 方案', 'e2')],
      coverage: { startEvent: 'a', endEvent: 'b', complete: true },
    },
  };
  const out = reduceScan({ chunks: [chunk], results: [res], scope: { firstSeq: 1, lastSeq: 2 } });
  assert.equal(out.duplicates, 2, '同 claim 同 source 应去重');
  assert.equal(out.findings.length, 2);
  assert.equal(out.conflicts.length, 1, '去重后 A 与 非A 各一条，构成 1 对；双方都必须保留');
  assert.ok(out.conflicts[0].a && out.conflicts[0].b);
});

test('冲突检测：否定式冲突可识别，非冲突不误报', () => {
  const mk = (claim) => ({ claim, sourceEventIds: ['e'], category: 'constraint', conflictWith: [] });
  assert.equal(detectConflicts([mk('波长必须是 1064nm'), mk('波长不是 1064nm')]).length, 1);
  assert.equal(detectConflicts([mk('波长必须是 1064nm'), mk('温度需要补偿')]).length, 0);
});

test('worker 输出校验：跨 chunk 引用 source 即判为幻觉（§11.2）', () => {
  assert.equal(validateWorkerResult({ findings: [], coverage: { start_event: 'a', end_event: 'b' } }).ok, true);
  assert.equal(validateWorkerResult({ findings: [{ claim: 'x' }], coverage: {} }).ok, false);
  assert.equal(
    validateWorkerResult({ findings: [{ claim: 'x', source_event_ids: [] }], coverage: { start_event: 'a', end_event: 'b' } }).ok,
    false,
  );
});

test('扫描：多块并行、覆盖完整、findings 带来源（§11 / §24.3）', async () => {
  const llm = scriptedWorkerLlm();
  const { vm, budgets } = setup({ llm });
  try {
    const { markerIds } = fill(vm, S, { count: 24, markerEvery: 6 });
    const scan = await vm.runtime.exhaustiveScan({ sessionId: S, query: '列出全部关于波长的约束' });
    assert.ok(scan.chunks.length >= 2, `应有多块，实际 ${scan.chunks.length}`);
    assert.equal(scan.coverage.complete, true, `覆盖应完整：${JSON.stringify(scan.coverage)}`);
    assert.equal(scan.coverage.reason, 'all_chunks_covered');
    assert.equal(scan.coverage.scope.firstSeq, 1);

    // §24.3 Global finding recall：埋入的每个约束都必须被找到，且来源正确
    const foundSources = new Set(scan.findings.flatMap((f) => f.sourceEventIds));
    for (const id of markerIds) {
      assert.ok(foundSources.has(id), `埋入的约束 ${id} 未被找到`);
    }
    assert.ok(llm.calls >= scan.chunks.length, '每个块至少一次 worker 调用');
  } finally {
    vm.close();
  }
});

test('扫描：单块失败 → coverage 不完整，且不掩盖（§23.3）', async () => {
  const { vm } = setup({ llm: scriptedWorkerLlm({ failChunkIndex: 1 }) });
  try {
    fill(vm, S, { count: 24, markerEvery: 6 });
    const scan = await vm.runtime.exhaustiveScan({ sessionId: S, query: '列出全部约束' });
    assert.equal(scan.coverage.complete, false);
    assert.ok(scan.coverage.failedChunks.length >= 1);
    assert.equal(scan.coverage.reason, 'worker_failures');
  } finally {
    vm.close();
  }
});

test('扫描：worker 自报范围错误 → 记为缺口', async () => {
  const { vm } = setup({ llm: scriptedWorkerLlm({ misreportChunkIndex: 0 }) });
  try {
    fill(vm, S, { count: 24, markerEvery: 6 });
    const scan = await vm.runtime.exhaustiveScan({ sessionId: S, query: 'q' });
    assert.equal(scan.coverage.complete, false);
    assert.ok(scan.coverage.gaps.length >= 1);
  } finally {
    vm.close();
  }
});

test('扫描：并发受限（不超过配置值）', async () => {
  let inFlight = 0;
  let peak = 0;
  const base = scriptedWorkerLlm();
  const llm = {
    async complete(req) {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      try {
        return await base.complete(req);
      } finally {
        inFlight -= 1;
      }
    },
  };
  const { vm } = setup({ llm, config: smallChunks({ global_scan: { chunk_target_ratio: 0.0002, max_concurrency: 2 } }) });
  try {
    fill(vm, S, { count: 30, markerEvery: 6 });
    const scan = await vm.runtime.exhaustiveScan({ sessionId: S, query: 'q' });
    assert.ok(scan.chunks.length >= 3, `应有多块，实际 ${scan.chunks.length}`);
    assert.ok(peak <= 2, `并发峰值 ${peak} 不得超过 2`);
    assert.equal(scan.stats.concurrency, 2);
  } finally {
    vm.close();
  }
});

test('worker 输出受限：每次调用都带 config 中的硬上限（§17.1 / §11.2）', async () => {
  const llm = scriptedWorkerLlm();
  const { vm } = setup({ llm });
  try {
    fill(vm, S, { count: 24, markerEvery: 6 });
    const scan = await vm.runtime.exhaustiveScan({ sessionId: S, query: '列出全部约束' });
    assert.ok(llm.maxTokensSeen.length >= scan.chunks.length, '每个块都应有一次受上限约束的调用');
    const cap = vm.config.output.global_worker_output_max_tokens;
    for (const mt of llm.maxTokensSeen) assert.equal(mt, cap, `worker 输出上限应为 ${cap}，实际 ${mt}`);

    // complex 模式放宽到 500，且仍受上限约束
    llm.maxTokensSeen.length = 0;
    await vm.runtime.exhaustiveScan({ sessionId: S, query: 'q', complex: true });
    const complexCap = vm.config.output.global_worker_output_complex_max_tokens;
    assert.ok(llm.maxTokensSeen.every((mt) => mt === complexCap), `complex 上限应为 ${complexCap}`);
  } finally {
    vm.close();
  }
});

test('GLOBAL 编译：有完整扫描结果时给出完整声明与 findings 段（§8.3）', async () => {
  const { vm } = setup({ llm: scriptedWorkerLlm() });
  try {
    const { markerIds } = fill(vm, S, { count: 24, markerEvery: 6 });
    await vm.runtime.exhaustiveScan({ sessionId: S, query: '列出全部约束' });

    const ctx = vm.runtime.compile({ sessionId: S, query: '列出全部关于波长的约束，不要遗漏', mode: 'GLOBAL' });
    assert.equal(ctx.coverage.complete, true);
    assert.equal(ctx.coverage.reason, 'exhaustive_scan');
    const cov = ctx.renderedSections.find((s) => s.title === 'Scan coverage');
    assert.ok(cov, '必须有覆盖声明段');
    assert.ok(cov.content.includes('complete: true'));
    const findings = ctx.renderedSections.find((s) => s.title === 'Exhaustive scan findings');
    assert.ok(findings, '必须有 findings 段');
    for (const id of markerIds) {
      assert.ok(findings.content.includes(id), `findings 应含来源 ${id}`);
    }
  } finally {
    vm.close();
  }
});

test('GLOBAL 编译：无扫描结果时给出非穷举提示，coverage 不为 complete（§23.3）', async () => {
  const { vm } = setup();
  try {
    fill(vm, S, { count: 10, markerEvery: 6 });
    const ctx = vm.runtime.compile({ sessionId: S, query: '列出全部约束', mode: 'GLOBAL' });
    assert.equal(ctx.coverage.complete, false);
    assert.equal(ctx.coverage.reason, 'no_exhaustive_scan');
    assert.ok(ctx.notes.degraded.includes('global_scan_unavailable'));
    assert.ok(ctx.renderedSections.some((s) => s.title === 'Coverage notice'));
  } finally {
    vm.close();
  }
});

test('GLOBAL 编译：扫描不完整时明确要求不得声称"已检查全部"（§23.3）', async () => {
  const { vm } = setup({ llm: scriptedWorkerLlm({ failChunkIndex: 0 }) });
  try {
    fill(vm, S, { count: 24, markerEvery: 6 });
    await vm.runtime.exhaustiveScan({ sessionId: S, query: 'q' });
    const ctx = vm.runtime.compile({ sessionId: S, query: '列出全部约束', mode: 'GLOBAL' });
    assert.equal(ctx.coverage.complete, false);
    const cov = ctx.renderedSections.find((s) => s.title === 'Scan coverage');
    assert.ok(cov.content.includes('不得使用'));
    assert.ok(ctx.notes.degraded.some((d) => d.startsWith('scan_incomplete')));
  } finally {
    vm.close();
  }
});

test('renderCoverage：完整与不完整两种措辞互斥', () => {
  const complete = renderCoverage({ complete: true, reason: 'exhaustive_scan', chunks: 3, coveredChunks: 3, scope: { firstSeq: 1, lastSeq: 9 } });
  assert.ok(complete.includes('有覆盖依据'));
  assert.ok(!complete.includes('不得使用'));

  const incomplete = renderCoverage({ complete: false, reason: 'coverage_gaps', chunks: 3, coveredChunks: 2, gaps: [{ chunkIndex: 1 }], failedChunks: [], scope: { firstSeq: 1, lastSeq: 9 } });
  assert.ok(incomplete.includes('不得使用'));
  assert.ok(incomplete.includes('覆盖不完整'));
});

test('扫描工具：结果文本如实反映覆盖情况（§8.3）', async () => {
  const { vm } = setup({ llm: scriptedWorkerLlm() });
  try {
    const { markerIds } = fill(vm, S, { count: 24, markerEvery: 6 });
    const { exhaustiveScanTool } = await import('../lib/tools/exhaustive_scan.js');
    const tool = exhaustiveScanTool(vm.runtime, { defineTool: (o) => o });
    // 形状必须与真实宿主一致：ToolExecutionInput 只有 agent（没有 session）
    const out = await tool.execute({ question: '列出全部约束' }, { agent: { session: { id: S } } });
    assert.equal(out.ok, true);
    assert.equal(out.coverage_complete, true);
    assert.ok(out.result.includes('complete=true'));
    assert.ok(out.result.includes(markerIds[0]));
  } finally {
    vm.close();
  }
});

test('扫描工具：无会话时明确失败，不静默返回空结果', async () => {
  const { vm } = setup();
  try {
    const { exhaustiveScanTool } = await import('../lib/tools/exhaustive_scan.js');
    const tool = exhaustiveScanTool(vm.runtime, { defineTool: (o) => o });
    const out = await tool.execute({ question: 'q' }, {});
    assert.equal(out.ok, false);
    assert.ok(out.result.includes('无法确定会话'));
  } finally {
    vm.close();
  }
});
