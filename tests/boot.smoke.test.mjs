/**
 * 端到端启动冒烟：用假宿主完整走一遍插件入口（lib/index.js 的 apply）。
 *
 * 这是"四阶段接线确实连起来"的证据：入口 → 装配 → 五条宿主缝 → 编译 → delta
 * → episode → 维护 → 拆解。不依赖 DSH 进程。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../lib/index.js';

const W = 262144;
const S = 'boot-sess';

const DELTA_TOOL_ARGS = {
  upsert: [{ type: 'constraint', key: 'wl', value: '1064.37nm', source_event_ids: [] }],
  supersede: [],
  resolve: [],
  open: [],
  next_action: '复核波长',
};

const SUMMARY_JSON = JSON.stringify({
  topic: '标定', goal: '固定波长', what_changed: ['确定 1064.37nm'],
  confirmed_decisions: [], constraints_added_or_changed: ['波长 1064.37nm'],
  rejected_options: [], open_questions: [], artifacts_touched: [],
  important_numbers_or_identifiers: ['1064.37nm'],
  source_event_range: { start_event: 'x', end_event: 'y' }, search_keywords: ['波长'],
});

/** 假宿主：llm 服务按 purpose 返回不同内容；记录调用次数。 */
function makeHost() {
  const handlers = new Map();
  const tools = [];
  const llmCalls = [];
  const llm = {
    async resolveModelInfo(provider, model) {
      return { contextWindow: W, provider, model };
    },
    async *stream(options) {
      llmCalls.push(options.purpose ?? 'unknown');
      const purpose = options.purpose;
      if (purpose === 'state_delta') {
        // 走工具路径，且把 source_event_ids 留空 → 会被 §4.2 拒绝（无 source 的 constraint）
        // 故这里显式给出工具调用，由测试断言"有 source 才落库"
        yield {
          type: 'tool-call-delta', index: 0,
          name: 'contextvm_commit_state',
          argumentsText: JSON.stringify({ ...DELTA_TOOL_ARGS, upsert: [] }),
        };
      } else if (purpose === 'episode_summary') {
        yield { type: 'text-delta', index: 0, text: SUMMARY_JSON };
      } else {
        yield { type: 'text-delta', index: 0, text: '{}' };
      }
      yield { type: 'done', stopReason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } };
    },
  };

  const ctx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    on(event, fn) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(fn);
    },
    get(name) {
      if (name === 'llm') return llm;
      return null;
    },
    tools: { register: (t) => tools.push(t) },
  };
  return { ctx, handlers, tools, llmCalls };
}

test('启动冒烟：apply 装配成功、注册两个工具、五条缝全部挂上', async () => {
  const host = makeHost();
  const plugin = apply(host.ctx, {});

  // 等异步的工具解析/注册完成（宿主包在本环境不可解析，故应走降级路径）
  await new Promise((r) => setTimeout(r, 30));

  assert.ok(plugin.vm, '应返回装配好的 vm');
  assert.equal(plugin.vm.config.route.provider, 'openrouter-stealth');
  assert.ok(plugin.vm.maintenance, '维护队列应就位');
  assert.ok(plugin.vm.telemetry, '遥测应就位');
  assert.ok(plugin.vm.scanner, 'GlobalScanner 应就位');

  for (const ev of ['session/event', 'system-prompt/assemble', 'agent/request-error', 'agent/turn-stopping']) {
    assert.ok(host.handlers.has(ev), `缺少宿主缝：${ev}`);
  }
  plugin.dispose();
});

test('启动冒烟：完整走一轮（镜像 → 注入 → delta → episode → 维护）', async () => {
  const host = makeHost();
  const plugin = apply(host.ctx, {});
  const { vm } = plugin;
  await new Promise((r) => setTimeout(r, 20));

  const session = {
    id: S,
    requestHeader: () => ({ provider: 'openrouter-stealth', model: 'stealth/union-alpha' }),
    snapshotEvents: () => [
      { type: 'user/message', seq: 1, time: Date.now(), data: { content: [{ type: 'text', text: '基准波长定为 1064.37nm' }] } },
      { type: 'assistant/message', seq: 2, time: Date.now(), data: { message: { content: [{ type: 'text', text: '已记录' }] } } },
    ],
  };

  // 1) 镜像
  for (const fn of host.handlers.get('session/event')) fn(session, session.snapshotEvents()[0]);
  assert.equal(vm.raw.count(S), 1);
  assert.ok(vm.raw.range(S)[0].content.includes('1064.37nm'));

  // 2) 注入（应解析 W 并产出 contexts）
  const assembly = { sections: [], contexts: [], tools: [], variables: {} };
  const out = (
    await Promise.all(
      host.handlers.get('system-prompt/assemble').map((fn) =>
        fn({}, { agent: { session } }, async () => assembly),
      ),
    )
  )[0];
  assert.equal(vm.runtime.window(S), W, '窗口应按路由解析并缓存');
  assert.ok(out.contexts.length >= 1, '应注入 contextvm 段落');
  assert.ok(out.contexts.every((c) => c.name.startsWith('contextvm:')));

  // 3) 轮末：delta + episode + 维护（异步，等待完成）
  for (const fn of host.handlers.get('agent/turn-stopping')) fn({ agent: { session }, turn: 1 });
  await new Promise((r) => setTimeout(r, 300));

  const rep = vm.telemetry.report();
  assert.ok(rep.context.compiles >= 1, '应记录一次编译');
  assert.ok(host.llmCalls.includes('state_delta'), '轮末应发起 delta 抽取调用');
  assert.equal(vm.runtime.pendingDeltas().length, 0, 'delta 应处理完毕（空 upsert 也是合法增量）');

  // 4) 手工写一条有 source 的状态，确认闭环可用
  const ev = vm.raw.range(S)[0];
  const res = vm.runtime.applySubmittedDelta({
    sessionId: S,
    rawDelta: { upsert: [{ type: 'constraint', key: 'wl', value: '1064.37nm', source_event_ids: [ev.eventId] }] },
  });
  assert.equal(res.ok, true);
  const ctx2 = vm.runtime.compile({ sessionId: S, query: '波长是多少' });
  assert.ok(ctx2.renderedSections.some((s) => s.content.includes('1064.37nm')), '状态应进入编译产物');

  // 5) 审计与重建工具可用
  assert.deepEqual(vm.audit(S, false).findings, []);
  assert.equal(vm.verifyRebuildability(5).ok, true);
  const rebuilt = vm.rebuildSearchIndex(S);
  assert.equal(rebuilt.rebuilt, vm.raw.count(S), '重建行数应等于 raw 事件数');
  assert.ok(rebuilt.rebuilt >= 2, `此时应已含镜像事件与状态变更事件，实际 ${rebuilt.rebuilt}`);

  plugin.dispose();
});

test('启动冒烟：配置不变量失败时 apply 抛错（拒绝启动，不静默兜底）', () => {
  const host = makeHost();
  assert.throws(
    () => apply(host.ctx, { ratios: { heavy_target_input: 0.1 } }),
    /配置不变量校验失败/,
  );
});
