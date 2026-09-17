/**
 * Phase A 审计：宿主缝接线（§21.6 / §13.2 / §9.1.1 / §22.1）。
 * 用假 ctx 驱动，不依赖 DSH 进程。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createContextVm } from '../lib/app/create.js';
import {
  applySeams, mapSessionEvent, classifyEvent, blocksToText, hostEventId, lastTurn,
} from '../lib/host/seams.js';
import { createLlmPort } from '../lib/host/llm.js';
import { fakeLlm } from './helpers.mjs';
import { setSessionActive } from '../lib/app/session_mode.js';

/** 显式开启某会话（默认休眠是设计行为，测试必须显式开启才走注入/抽取路径）。 */
const enable = (vm, sessionId) => setSessionActive(vm.db, sessionId, true);

/** 假 Cordis 上下文：记录钩子、提供可注入服务。 */
function fakeCtx(services = {}) {
  const handlers = new Map();
  const registeredTools = [];
  const base = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    on(event, fn) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(fn);
    },
    get(name) {
      if (name === 'tools') return { register: (t) => registeredTools.push(t) };
      return services[name] ?? null;
    },
    tools: { register: (t) => registeredTools.push(t) },
  };
  return {
    ctx: base,
    handlers,
    registeredTools,
    async fire(event, ...args) {
      const list = handlers.get(event) ?? [];
      const out = [];
      for (const fn of list) out.push(await fn(...args));
      return out;
    },
  };
}

/** 假会话：可控 requestHeader 与事件流。 */
function fakeSession(id, events = [], header = { provider: 'openrouter-stealth', model: 'stealth/union-alpha' }) {
  return {
    id,
    requestHeader: () => header,
    snapshotEvents: () => events,
  };
}

const W = 262144;

function makeVm({ llm = fakeLlm([{ text: 'ok' }]) } = {}) {
  const vm = createContextVm({ rawConfig: {}, dbPath: ':memory:', llm });
  return vm;
}

test('blocksToText：保留文本与工具调用，丢弃 reasoning（§1.3）', () => {
  const text = blocksToText([
    { type: 'reasoning', text: '这是思维链，必须丢弃' },
    { type: 'text', text: '可见回答' },
    { type: 'tool_use', name: 'grep', input: { q: 'x' } },
    { type: 'image' },
  ]);
  assert.ok(text.includes('可见回答'));
  assert.ok(!text.includes('思维链'));
  assert.ok(text.includes('[tool_use grep]'));
  assert.ok(text.includes('[image]'));
  assert.equal(blocksToText('直接字符串'), '直接字符串');
});

test('mapSessionEvent：只有四类 surface 事件入索引', () => {
  const mapped = mapSessionEvent({ type: 'user/message', data: { content: [{ type: 'text', text: '你好' }] } });
  assert.equal(mapped.role, 'user');
  assert.equal(mapped.eventType, 'user_message');
  assert.equal(mapped.content, '你好');
  assert.deepEqual(mapped.metadata, { sourceKind: null }, '无来源标记时 sourceKind 记 null');
  assert.equal(mapSessionEvent({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'a' }] } } }).eventType, 'assistant_message');
  assert.equal(mapSessionEvent({ type: 'tool/result', data: { content: [{ type: 'text', text: 'r' }] } }).eventType, 'tool_result');
  assert.equal(mapSessionEvent({ type: 'step/start', data: {} }), null);
  assert.equal(mapSessionEvent({ type: 'turn/start', data: {} }), null);
});

test('lastTurn：取最后一条 user 消息及其后的 assistant 消息', () => {
  const events = [
    { type: 'user/message', data: { content: [{ type: 'text', text: '第一问' }] } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '第一答' }] } } },
    { type: 'user/message', data: { content: [{ type: 'text', text: '第二问' }] } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '第二答' }] } } },
  ];
  assert.deepEqual(lastTurn(events), { query: '第二问', answer: '第二答', eventIds: [] });
  assert.deepEqual(lastTurn([]), { query: '', answer: '', eventIds: [] });
});

test('镜像：同一 seq 重复读到只索引一次（幂等）', () => {
  const vm = makeVm();
  const { ctx, fire } = fakeCtx();
  try {
    applySeams(ctx, vm, {});
    const session = fakeSession('s1');
    const ev = { type: 'user/message', seq: 3, time: Date.now(), data: { content: [{ type: 'text', text: '内容 A' }] } };
    return (async () => {
      await fire('session/event', session, ev);
      await fire('session/event', session, ev);
      assert.equal(vm.raw.count('s1'), 1);
      assert.ok(vm.raw.has(hostEventId('s1', 3)));
      // 空内容事件不入索引
      await fire('session/event', session, { type: 'assistant/message', seq: 4, data: { message: { content: [{ type: 'reasoning', text: 'x' }] } } });
      assert.equal(vm.raw.count('s1'), 1);
    })();
  } finally {
    setImmediate(() => vm.close());
  }
});

test('注入：assembled.contexts 增加 ContextVM 段落，且窗口按当次路由解析（§2.1）', () => {
  const vm = makeVm();
  const resolved = [];
  const { ctx, fire } = fakeCtx({
    llm: {
      async resolveModelInfo(provider, model) {
        resolved.push(`${provider}/${model}`);
        return { contextWindow: W };
      },
    },
  });
  try {
    vm.raw.append({ sessionId: 's2', role: 'user', eventType: 'user_message', content: '约束：波长 1064nm' });
    enable(vm, 's2');
    applySeams(ctx, vm, {});
    const session = fakeSession('s2');
    return (async () => {
      const [out] = await fire('system-prompt/assemble', {}, { agent: { session } }, async () => ({ sections: [{ name: 'base', text: 'B' }], contexts: [], tools: [], variables: {} }));
      assert.equal(out.sections.length, 1, '原始 sections 不得被改动');
      assert.ok(out.contexts.length > 0, '应注入 contexts');
      assert.ok(out.contexts.every((c) => c.name.startsWith('contextvm:')));
      assert.ok(out.contexts.some((c) => c.text.includes('1064nm')));
      assert.deepEqual(resolved, ['openrouter-stealth/stealth/union-alpha']);
      assert.equal(vm.runtime.window('s2'), W);
    })();
  } finally {
    setImmediate(() => vm.close());
  }
});

test('注入：llm 服务缺失时放行原始装配并给出警告，不抛错', () => {
  const vm = makeVm();
  const { ctx, fire } = fakeCtx({ llm: null });
  try {
    applySeams(ctx, vm, {});
    const session = fakeSession('s3');
    return (async () => {
      const base = { sections: [], contexts: [], tools: [], variables: {} };
      const [out] = await fire('system-prompt/assemble', {}, { agent: { session } }, async () => base);
      assert.equal(out, base, '应原样返回');
      assert.ok(vm.runtime.injectionScale('s3') === 1);
    })();
  } finally {
    setImmediate(() => vm.close());
  }
});

test('注入：诊断路径（无 agent）直接放行，不报错', () => {
  const vm = makeVm();
  const { ctx, fire } = fakeCtx({ llm: { resolveModelInfo: async () => ({ contextWindow: W }) } });
  try {
    applySeams(ctx, vm, {});
    return (async () => {
      const base = { sections: [], contexts: [], tools: [], variables: {} };
      const [out] = await fire('system-prompt/assemble', {}, {}, async () => base);
      assert.equal(out, base);
    })();
  } finally {
    setImmediate(() => vm.close());
  }
});

test('容量拒绝：收缩注入并要求重试，且受 preflight_max_retries 限制（§9.1.1）', async () => {
  const vm = makeVm();
  const { ctx, fire } = fakeCtx();
  applySeams(ctx, vm, {});
  const agent = { session: fakeSession('s4') };
  const failure = {
    message:
      "This endpoint's maximum context length is 262144 tokens. However, you requested about 324789 tokens (324781 of text input, 8 in the output).",
  };
  try {
    const a1 = await fire('agent/request-error', { agent, turn: 1, failure }, async () => 'next');
    assert.deepEqual(a1[0], { kind: 'retry' });
    const after = vm.runtime.injectionScale('s4');
    assert.ok(after < 1, `缩放应下降，实际 ${after}`);

    const a2 = await fire('agent/request-error', { agent, turn: 1, failure }, async () => 'next');
    assert.deepEqual(a2[0], { kind: 'retry' });
    // 第三次达到上限后交还宿主
    const a3 = await fire('agent/request-error', { agent, turn: 1, failure }, async () => 'next');
    assert.equal(a3[0], 'next', '超过重试上限 MUST 交还宿主');
    // 新一轮重新计数
    const b1 = await fire('agent/request-error', { agent, turn: 2, failure }, async () => 'next');
    assert.deepEqual(b1[0], { kind: 'retry' });
  } finally {
    vm.close();
  }
});

test('容量拒绝：与长度无关的失败不被误判，直接交还宿主', async () => {
  const vm = makeVm();
  const { ctx, fire } = fakeCtx();
  applySeams(ctx, vm, {});
  const agent = { session: fakeSession('s5') };
  try {
    const out = await fire(
      'agent/request-error',
      { agent, turn: 1, failure: { message: 'provider_unavailable' } },
      async () => 'next',
    );
    assert.equal(out[0], 'next');
    assert.equal(vm.runtime.injectionScale('s5'), 1, '不得因无关失败收缩');
  } finally {
    vm.close();
  }
});

test('轮末：调度 delta 抽取（先写 pending，成功后清空），不阻塞轮次（§15.2/§22.1）', async () => {
  const vm = makeVm({ llm: fakeLlm([{ text: '{"upsert":[],"supersede":[],"resolve":[],"open":[],"next_action":null}' }]) });
  const { ctx, fire } = fakeCtx();
  applySeams(ctx, vm, {});
  try {
    vm.runtime.setWindow('s6', W);
    const e1 = vm.raw.append({ sessionId: 's6', role: 'user', eventType: 'user_message', content: '问题' });
    const events = [
      { type: 'user/message', seq: 1, time: Date.now(), data: { content: [{ type: 'text', text: '问题' }] } },
      { type: 'assistant/message', seq: 2, time: Date.now(), data: { message: { content: [{ type: 'text', text: '回答' }] } } },
    ];
    const session = fakeSession('s6', events);
    await fire('agent/turn-stopping', { agent: { session }, turn: 1 });

    // 调度是异步的：等待微任务队列跑完
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(vm.runtime.pendingDeltas().length, 0, '成功后 pending 应清空');
    assert.ok(vm.raw.count('s6') >= 3, '宿主事件已镜像（含 state_delta 事件或原始两条）');
  } finally {
    vm.close();
  }
});

test('会话级工具生命周期：默认零注册，开启后注册进该 agent 作用域，关闭即释放', () => {
  const vm = makeVm();
  const { ctx, registeredTools } = fakeCtx();
  const seams = applySeams(ctx, vm, {});
  const defineTool = (opts) => ({ ...opts, __defined: true });
  seams.setDefineTool(defineTool);
  const agent = { session: { id: 's-tools' }, ctx: { tools: { register: (t) => { registeredTools.push(t); return () => { registeredTools.splice(registeredTools.indexOf(t), 1); }; } } } };
  try {
    // 默认休眠：**一个工具都不注册**（这是污染隔离的核心 —— schema 不随请求发送）
    assert.equal(registeredTools.length, 0, '默认 MUST NOT 注册任何工具');
    assert.equal(seams.toolsActive('s-tools'), false);

    const r = seams.activate(agent);
    assert.equal(r.ok, true, `激活应成功：${r.reason ?? ''}`);
    assert.deepEqual(r.registered, [
      'contextvm_commit_state',
      'contextvm_exhaustive_scan',
      'search_memory',
      'fetch_event',
      'fetch_events',
      'fetch_episode',
      'fetch_artifact',
      'search_artifacts',
    ]);
    assert.equal(registeredTools.length, 8);
    assert.equal(registeredTools[0].name, 'contextvm_commit_state');
    assert.ok(registeredTools[0].output.schema.properties.ok.required);
    assert.ok(registeredTools[1].parameters.question.required);
    // §14 工具必须都有有界输出与 source ids 字段
    for (const t of registeredTools.slice(2)) {
      assert.ok(t.output.schema.properties.source_event_ids, `${t.name} 缺少 source_event_ids`);
      assert.ok(t.output.schema.properties.truncated, `${t.name} 缺少 truncated 标记`);
    }
    assert.equal(seams.toolsActive('s-tools'), true);
    // 重复激活是幂等的（不应重复注册）
    assert.equal(seams.activate(agent).ok, true);
    assert.equal(registeredTools.length, 8, '重复激活 MUST NOT 重复注册');

    // 关闭：释放该会话的注册，其它会话不受影响
    assert.equal(seams.deactivate('s-tools').released, 8);
    assert.equal(registeredTools.length, 0, '关闭后 MUST 释放注册');
    assert.equal(seams.toolsActive('s-tools'), false);
  } finally {
    vm.close();
  }
});

test('会话级工具生命周期：拿不到 agent 作用域时如实失败，MUST NOT 全局兜底', () => {
  const vm = makeVm();
  const { ctx, registeredTools } = fakeCtx();
  const seams = applySeams(ctx, vm, {});
  seams.setDefineTool((def) => def);
  try {
    // agent 没有 ctx.tools：宁可失败也不能退化成全局注册（那会悄悄破坏隔离）
    const r = seams.activate({ session: { id: 's-noScope' } });
    assert.equal(r.ok, false);
    assert.ok(/作用域/.test(r.reason), `理由应点明作用域问题，实际：${r.reason}`);
    assert.equal(registeredTools.length, 0, 'MUST NOT 全局兜底注册');

    // defineTool 未就绪时同样如实失败
    const vm2 = makeVm();
    const c2 = fakeCtx();
    const seams2 = applySeams(c2.ctx, vm2, {});
    const r2 = seams2.activate({ session: { id: 's2' }, ctx: { tools: { register: () => () => {} } } });
    assert.equal(r2.ok, false);
    assert.ok(/定义器/.test(r2.reason));
    vm2.close();
  } finally {
    vm.close();
  }
});

// 复用同一 vm 的注册路径（applySeams 只应挂一次钩子）
function seamsRegister(ctx, vm, defineTool) {
  return applySeams(ctx, vm, {}).registerTool(defineTool);
}

test('LlmPort 适配器：聚合流式增量，丢弃 reasoning，解析工具参数', async () => {
  const chunks = [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: '不该被采用' },
    { type: 'block-start', index: 1, blockType: 'text' },
    { type: 'text-delta', index: 1, text: '结论' },
    { type: 'text-delta', index: 1, text: '如下' },
    { type: 'tool-call-delta', index: 2, name: 'contextvm_commit_state', argumentsDelta: '{"upsert":[{"type":"fact",' },
    { type: 'tool-call-delta', index: 2, argumentsDelta: '"value":"x"}]}' },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, reasoningTokens: 3 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ];
  const { ctx } = fakeCtx({
    llm: {
      stream() {
        return (async function* gen() {
          for (const c of chunks) yield c;
        })();
      },
    },
  });
  const port = createLlmPort(ctx, {});
  const res = await port.complete({
    provider: 'p', model: 'm',
    messages: [{ role: 'user', content: '问题' }],
    tools: [{ name: 'contextvm_commit_state', description: 'd', parameters: { type: 'object' } }],
    maxTokens: 64,
  });
  assert.equal(res.text, '结论如下');
  assert.equal(res.toolCalls.length, 1);
  assert.equal(res.toolCalls[0].name, 'contextvm_commit_state');
  assert.deepEqual(res.toolCalls[0].args, { upsert: [{ type: 'fact', value: 'x' }] });
  assert.deepEqual(res.stopReason, { kind: 'tool-calls' }, '宿主 FinishReason 是 {kind} 对象，不转字符串');
  // 宿主给 camelCase（inputTokens），端口契约给 snake_case —— 转换在适配器一处完成
  assert.deepEqual(res.usage, { input_tokens: 10, output_tokens: 5, reasoning_tokens: 3 });
  // 流规模要如实带出去：真机上"27 秒 + text/usage/stopReason 全空"曾无从判断
  // 是上游没送内容还是我们漏读了 chunk
  assert.equal(res.chunks, 9);
  assert.ok(res.types.includes('text-delta') && res.types.includes('finish'));
});

test('LlmPort 适配器：未识别的 chunk 类型必须露面（此前被静默丢弃）', async () => {
  const warned = [];
  const { ctx } = fakeCtx({
    llm: {
      stream() {
        return (async function* gen() {
          yield { type: 'block-start', index: 0, blockType: 'text' };
          yield { type: 'upstream-error', message: 'provider exploded' };
        })();
      },
    },
  });
  const port = createLlmPort(ctx, { logger: (level, msg) => warned.push(`${level}:${msg}`) });
  const res = await port.complete({ provider: 'p', model: 'm', messages: [{ role: 'user', content: 'q' }] });
  assert.equal(res.text, '', '未识别的 chunk 不产生文本');
  assert.equal(res.chunks, 2, '但仍应计入流规模');
  // 只筛未识别告警：端口加载宿主模块失败时的提示与本事无关
  const unk = warned.filter((w) => w.includes('未识别'));
  assert.equal(unk.length, 1, '必须恰好告警一次');
  assert.ok(unk[0].includes('upstream-error'), '告警必须点出未识别的类型名');
});

test('LlmPort 适配器：空流不报未识别告警（偶发空响应是上游行为，不是解析缺陷）', async () => {
  const warned = [];
  const { ctx } = fakeCtx({
    llm: {
      stream() {
        return (async function* gen() {})();
      },
    },
  });
  const port = createLlmPort(ctx, { logger: (level, msg) => warned.push(`${level}:${msg}`) });
  const res = await port.complete({ provider: 'p', model: 'm', messages: [{ role: 'user', content: 'q' }] });
  assert.equal(res.chunks, 0);
  assert.equal(res.text, '');
  assert.deepEqual(warned.filter((w) => w.includes('未识别')), [], '空流不应产生未识别类型告警');
});

test('LlmPort 适配器：宿主 llm 不可用时抛可诊断错误', async () => {
  const { ctx } = fakeCtx({ llm: null });
  const port = createLlmPort(ctx, {});
  await assert.rejects(() => port.complete({ provider: 'p', model: 'm', messages: [] }), /宿主 llm 服务不可用/);
});

test('来源分类：宿主注入的合成上下文不得冒充用户消息（real-machine 发现）', () => {
  // 真实用户输入
  assert.deepEqual(
    classifyEvent({ type: 'user/message', data: { source: { kind: 'user' }, content: [] } }),
    { role: 'user', eventType: 'user_message', form: null, kind: 'user' },
  );
  // 宿主注入的快照（实测单条 3595 token）→ 记为 system_note，不再以 user authority 参与打分
  assert.deepEqual(
    classifyEvent({ type: 'user/message', data: { source: { kind: 'plugin', plugin: 'harness', form: 'snapshot' }, content: [] } }),
    { role: 'system', eventType: 'system_note', form: 'snapshot', kind: 'plugin' },
  );
  // 技能目录同样属于宿主注入
  assert.equal(
    classifyEvent({ type: 'user/message', data: { source: { kind: 'plugin', form: 'catalog' }, content: [] } }).eventType,
    'system_note',
  );
  // 工具结果的来源
  assert.equal(classifyEvent({ type: 'tool/result', data: { source: { kind: 'tool' }, content: [] } }).eventType, 'tool_result');
  // 助手消息与未知事件
  assert.equal(classifyEvent({ type: 'assistant/message', data: {} }).eventType, 'assistant_message');
  assert.equal(classifyEvent({ type: 'step/start', data: {} }), null);
  // 缺 source 的 user/message 仍按用户消息处理（老宿主/手搓事件的兼容面）
  assert.equal(classifyEvent({ type: 'user/message', data: { content: [] } }).eventType, 'user_message');

  // 关键：kind 是 merge-extensible 的，插件可自行登记新 kind。
  // 因此判定必须反过来——非 user 的**任何** kind 都算注入上下文，白名单注定落后。
  assert.equal(
    classifyEvent({ type: 'user/message', data: { source: { kind: 'skill-catalog' }, content: [] } }).eventType,
    'system_note',
    '未知/插件自定义 kind 必须归为注入上下文（真机上出现过 skill-catalog）',
  );
  assert.equal(
    classifyEvent({ type: 'user/message', data: { source: { kind: '某个未来才有的kind' }, content: [] } }).eventType,
    'system_note',
  );
});

test('来源分类：form 会带进索引元数据，便于后续排除宿主样板', () => {
  const mapped = mapSessionEvent({
    type: 'user/message',
    data: { source: { kind: 'plugin', form: 'snapshot' }, content: [{ type: 'text', text: 'Current runtime context' }] },
  });
  assert.equal(mapped.eventType, 'system_note');
  assert.equal(mapped.content, 'Current runtime context');
  assert.deepEqual(mapped.metadata, { sourceKind: 'plugin', contextForm: 'snapshot' });
});

test('lastTurn：MUST NOT 把宿主注入的合成上下文当成"本轮用户查询"（真机缺陷回归）', () => {
  // 真机实测（web 长对话实验）：宿主把运行时快照也写成 user/message，lastTurn 按事件类型
  // 取最后一条 user/message → 增量抽取的"用户查询"变成
  // "Current runtime context. This snapshot supersedes …"，导致 unparseable、
  // 单次输出 2500 token 的畸形推理、状态项始终为 0。
  const events = [
    { type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: '真正的用户问题' }], source: { kind: 'user' } } },
    { type: 'assistant/message', seq: 2, data: { message: { content: [{ type: 'text', text: '真正的回答' }] } } },
    // 宿主注入的合成上下文：同为 user/message，但 source.kind 是 plugin
    { type: 'user/message', seq: 3, data: { content: [{ type: 'text', text: 'Current runtime context. This snapshot supersedes …' }], source: { kind: 'plugin', form: 'snapshot' } } },
    { type: 'user/message', seq: 4, data: { content: [{ type: 'text', text: '<system-reminder> 技能目录' }], source: { kind: 'skill-catalog', form: 'catalog' } } },
  ];
  const t = lastTurn(events);
  assert.equal(t.query, '真正的用户问题', `查询 MUST 取真实用户输入，实际：${t.query.slice(0, 40)}`);
  assert.equal(t.answer, '真正的回答');

  // 缺 kind 时按用户处理（与 §4.1 同向的兼容面）
  const legacy = lastTurn([
    { type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: '旧版无 kind 的消息' }] } },
  ]);
  assert.equal(legacy.query, '旧版无 kind 的消息');

  // 只有宿主样板时不得取到它
  const onlyHost = lastTurn([
    { type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: 'Current runtime context' }], source: { kind: 'plugin' } } },
  ]);
  assert.equal(onlyHost.query, '', '只有宿主样板时应保持空，MUST NOT 拿它当查询');
});
