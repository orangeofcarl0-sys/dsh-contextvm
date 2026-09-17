/**
 * 长对话实验：事实掉出"最近原文"窗口之后还能不能被召回。
 *
 * 为什么单独做这个：此前的 1M 验收证明的是"库够大时仍能检索"，而真实长对话的困难不是
 * 总量大，而是**早期内容被挤出模型可见窗口**——宿主用压缩摘要遮蔽早期消息，而摘要必然
 * 丢细节；朴素上下文管理只保留最近若干条，早期精确值就此消失。
 *
 * 本实验把条件压到最紧，全部离线、确定性、真实驱动插件的编译路径：
 *   1. 第一轮埋入精确事实（编号 + 数值），来源可追溯；
 *   2. 再灌 25 轮填充（共 51 个事件），使其**落在 recent_events(40) 窗口之外**；
 *   3. 先用状态路径回答，再把状态清掉，验证**纯检索**路径同样能召回；
 *   4. 与"朴素基线"对照 —— 只给最近窗口，事实确实不在其中。
 *
 * 摘要路径被刻意排除：假 LLM 生成的 episode 摘要**不含**该事实，因此若事实仍出现在注入里，
 * 只可能来自 state 或 lexical 检索，不会是摘要兜底。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createContextVm } from '../lib/app/create.js';
import { setSessionActive } from '../lib/app/session_mode.js';
import { deriveBudgets } from '../lib/app/config.js';
import { fakeLlm } from './helpers.mjs';

const S = 'sess-longconv';
const W = 262144;
const FACT_ID = 'CAL-7Q2X-88';
const FACT_WAVELENGTH = '1064.37nm';

/** 第一轮的原始事件 id（实验全程引用它做 provenance 与断言）。 */
let factEventId = null;

/**
 * 造一段"像真实对话"的长历史：第一轮埋事实，其余为填充。
 * @param {ReturnType<import('../lib/app/create.js').createContextVm>} vm
 * @param {number} turns
 */
function buildConversation(vm, turns) {
  factEventId = vm.raw.append({
    sessionId: S,
    role: 'user',
    eventType: 'user_message',
    // 事实**不加任何强调**地埋在一段清单中间 —— 与真机实验一致
    content:
      '接下来是项目背景，请只回复「已读」。我们在改造一条 1550nm 光纤链路：收发模块要换型，' +
      '增益谱要重测，控制板固件要升级，机柜走线要重排。现场温度波动大，温控需复核；供电要加浪涌保护；' +
      `接口按 LC/APC 统一；验收编号 ${FACT_ID}，基准波长 ${FACT_WAVELENGTH}；测试分静态、动态、长稳三轮。`,
  }).eventId;

  for (let i = 1; i <= turns; i += 1) {
    vm.raw.append({
      sessionId: S,
      role: 'user',
      eventType: 'user_message',
      content: `第 ${i} 轮追问：再讲讲第 ${i} 部分的注意事项，用一两句话。`,
    });
    vm.raw.append({
      sessionId: S,
      role: 'assistant',
      eventType: 'assistant_message',
      content: `第 ${i} 轮的答复：这一段主要说明第 ${i} 项的施工顺序与验收口径，细节见现场记录。`,
    });
  }
}

function makeVm() {
  // 摘要**不含**事实：确保召回只能来自 state 或检索，不能靠摘要兜底
  const llm = fakeLlm([
    { text: '{"upsert":[],"supersede":[],"resolve":[],"open":[],"next_action":null}' },
    { text: '本轮讨论了光纤链路的改造顺序与验收口径，未涉及具体参数。' },
  ]);
  const vm = createContextVm({ rawConfig: {}, dbPath: ':memory:', llm });
  vm.runtime.setWindow(S, W);
  setSessionActive(vm.db, S, true);
  return vm;
}

const sectionOf = (ctx, title) => ctx.renderedSections.find((s) => s.title === title)?.content ?? '';
const allInjected = (ctx) => ctx.renderedSections.map((s) => s.content).join('\n');

test('长对话实验：事实被挤出 recent 窗口后，仍能从状态路径召回', () => {
  const vm = makeVm();
  try {
    buildConversation(vm, 25);
    const totalEvents = vm.raw.count(S);
    assert.ok(totalEvents > 40, `历史应超过 recent 窗口（实际 ${totalEvents} 个事件）`);

    // 状态路径：早期事实经 delta 落库（带 provenance）
    vm.state.upsert({
      sessionId: S, itemType: 'fact', key: '验收编号', value: FACT_ID, sourceEventIds: [factEventId],
    });
    vm.state.upsert({
      sessionId: S, itemType: 'fact', key: '基准波长', value: FACT_WAVELENGTH, sourceEventIds: [factEventId],
    });

    const ctx = vm.runtime.compile({ sessionId: S, query: '验收编号和基准波长分别是多少' });

    // 事实必须出现在注入里
    const injected = allInjected(ctx);
    assert.ok(injected.includes(FACT_ID), '精确编号必须进入注入');
    assert.ok(injected.includes(FACT_WAVELENGTH), '精确数值必须进入注入');

    // 而且**不能**来自 recent verbatim —— 它已被挤出窗口
    const recent = sectionOf(ctx, 'Recent verbatim');
    assert.ok(
      !recent.includes(FACT_ID),
      `事实不应还在 recent 窗口内（否则本实验不成立）：${recent.slice(0, 120)}`,
    );
    // 也不能来自摘要：假摘要刻意不含事实，故注入里只要出现事实就只能是 state 或检索
    assert.ok(!injected.includes('未涉及具体参数'), '本用例不应注入摘要内容');

    // 来源应是状态段
    assert.ok(sectionOf(ctx, 'Active decisions / facts').includes(FACT_ID), '应从 authoritative state 注入');
    assert.ok(ctx.tokenCount <= deriveBudgets(vm.config, W).hardInputCap, '注入不得超过硬上限');
  } finally {
    vm.close();
  }
});

test('长对话实验：状态被清空后，纯检索路径同样能召回早期原文', () => {
  const vm = makeVm();
  try {
    buildConversation(vm, 25);
    const ctx = vm.runtime.compile({ sessionId: S, query: '验收编号和基准波长分别是多少' });
    const injected = allInjected(ctx);

    // 没有任何状态项 → 唯一可能的来源是 lexical 检索（原始证据）
    assert.equal(vm.state.active(S).length, 0, '本用例不写状态');
    assert.ok(injected.includes(FACT_ID), '纯检索也必须召回早期精确编号');
    assert.ok(injected.includes(FACT_WAVELENGTH), '纯检索也必须召回早期精确数值');
    assert.ok(
      !sectionOf(ctx, 'Recent verbatim').includes(FACT_ID),
      '仍然不应来自 recent 窗口',
    );
    const evidence = sectionOf(ctx, 'Retrieved evidence');
    assert.ok(evidence.includes(FACT_ID), '应作为检索证据给出，且带 source id');
    assert.ok(ctx.evidenceManifest.length > 0, '证据清单非空（§7.4 可追溯）');
  } finally {
    vm.close();
  }
});

test('长对话实验：朴素基线（只给最近窗口）确实拿不到该事实 —— 量化插件的增量', () => {
  const vm = makeVm();
  try {
    buildConversation(vm, 25);
    // 朴素上下文管理：只保留最近 N 条（模型可见窗口）
    const naive = vm.raw.recent(S, vm.config.recent_events).map((e) => e.content).join('\n');
    assert.ok(!naive.includes(FACT_ID), '朴素基线不应包含早期精确编号');
    assert.ok(!naive.includes(FACT_WAVELENGTH), '朴素基线不应包含早期精确数值');

    // 而本插件在同一条件下给出了它
    vm.state.upsert({
      sessionId: S, itemType: 'fact', key: '验收编号', value: FACT_ID, sourceEventIds: [factEventId],
    });
    const ctx = vm.runtime.compile({ sessionId: S, query: '验收编号和基准波长分别是多少' });
    assert.ok(allInjected(ctx).includes(FACT_ID), '本插件应给出朴素基线拿不到的事实');
    assert.ok(ctx.tokenCount < deriveBudgets(vm.config, W).normalTargetInput, '代价很小：注入远低于正常目标');
  } finally {
    vm.close();
  }
});

test('长对话实验：多轮之后状态与队列仍然干净（无重复 key、provenance 完整、无积压）', async () => {
  const vm = makeVm();
  try {
    buildConversation(vm, 25);
    setSessionActive(vm.db, S, true);

    // 跑一次真实的 delta 流水线（假 LLM 返回空增量）
    const res = await vm.runtime.extractDelta({
      sessionId: S, query: '验收编号和基准波长分别是多少', answer: '已读。', eventIds: [factEventId],
    });
    assert.equal(res.ok, true, `抽取应成功：${res.reason ?? ''}`);

    const active = vm.state.active(S);
    const keys = active.map((i) => `${i.itemType}:${i.key}`);
    assert.equal(new Set(keys).size, keys.length, `不应出现重复 key：${keys.join(', ')}`);
    assert.equal(vm.state.countWithoutProvenance(S), 0, '§24.3：active 项 100% 有来源');
    assert.equal(vm.runtime.pendingDeltas().length, 0, '队列不应积压');
  } finally {
    vm.close();
  }
});
