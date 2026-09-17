/**
 * 会话级开关审计（污染隔离的核心不变量）。
 *
 * 背景（真机审计结论）：插件此前**全局注册 8 个工具**，其 schema 实测约 1433 token，
 * 随该 profile 下**每个会话**的请求发送 —— 与用户是否用 ContextVM 无关，比插件注入的
 * 上下文（82–257 token）贵一个量级。改为默认休眠、`/contextvm on` 按会话开启后，
 * 污染隔离必须是**结构性**的：没开启的会话在请求层面零足迹。
 *
 * 本文件守住三条：
 *   1. 休眠 = 不注册工具 + 不注入 + 不做后台模型调用；
 *   2. 开启 = 三者同时生效，且工具只注册进该会话的 agent 作用域；
 *   3. 拿不到作用域时如实失败，MUST NOT 全局兜底、MUST NOT 写"已开启"的假状态。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createContextVm } from '../lib/app/create.js';
import { applySeams } from '../lib/host/seams.js';
import { setSessionActive, isSessionActive, parseSubcommand } from '../lib/app/session_mode.js';
import { registerStatusCommand } from '../lib/commands/status.js';
import { fakeLlm } from './helpers.mjs';

const S = 'sess-mode';
const W = 262144;

/** 假宿主：记录 llm 调用次数（用于断言"休眠时不做后台调用"）。 */
function fakeHost(vm) {
  const handlers = new Map();
  const tools = [];
  const llmCalls = [];
  const ctx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    on(e, fn) {
      if (!handlers.has(e)) handlers.set(e, []);
      handlers.get(e).push(fn);
    },
    get(name) {
      // 窗口解析要经 llm.resolveModelInfo（§2.1）；这里给一个够用的假实现
      return name === 'llm' ? { async resolveModelInfo() { return { contextWindow: W }; } } : null;
    },
  };
  return {
    ctx,
    tools,
    llmCalls,
    async fire(e, ...args) {
      const out = [];
      for (const fn of handlers.get(e) ?? []) out.push(await fn(...args));
      return out;
    },
  };
}

function makeVmWithHistory() {
  const calls = [];
  const vm = createContextVm({
    rawConfig: {},
    dbPath: ':memory:',
    llm: {
      async complete(req) {
        calls.push(req?.purpose ?? 'unknown');
        return { text: '{}', toolCalls: [], usage: null, stopReason: { kind: 'stop' } };
      },
    },
  });
  vm.runtime.setWindow(S, W);
  vm.raw.append({ sessionId: S, role: 'user', eventType: 'user_message', content: '约束：波长 1064nm' });
  return { vm, calls };
}

const fakeSession = () => ({
  id: S,
  requestHeader: () => ({ config: { provider: 'openrouter-stealth', model: 'stealth/union-alpha' } }),
  snapshotEvents: () => [
    { type: 'user/message', seq: 1, time: Date.now(), data: { content: [{ type: 'text', text: '约束：波长 1064nm' }] } },
    { type: 'assistant/message', seq: 2, time: Date.now(), data: { message: { content: [{ type: 'text', text: '好的' }] } } },
  ],
});

/** 组装 assemble 的三参：第二参要的是 **agent**（不是 session）。 */
const assembleArgs = (agent) => [
  {},
  { agent, signal: undefined },
  async () => ({ sections: [{ name: 'base', text: 'B' }], contexts: [], tools: [], variables: {} }),
];

test('休眠（默认）：不注入、不注册工具、不做后台模型调用 —— 请求零足迹', async () => {
  const { vm, calls } = makeVmWithHistory();
  const host = fakeHost(vm);
  try {
    const seams = applySeams(host.ctx, vm, {});
    seams.setDefineTool((def) => def);
    const session = fakeSession();

    assert.equal(isSessionActive(vm.db, S), false, '默认 MUST 是休眠');
    const [out] = await host.fire('system-prompt/assemble', ...assembleArgs({ session }));
    assert.equal(out.contexts.length, 0, '休眠时 MUST NOT 注入任何 contexts');

    await host.fire('agent/turn-stopping', { agent: { session }, turn: 1 });
    await new Promise((r) => setTimeout(r, 80));
    assert.deepEqual(calls, [], '休眠时 MUST NOT 发起任何后台模型调用（抽取/摘要都要花产能）');
    assert.equal(seams.toolsActive(S), false);
  } finally {
    vm.close();
  }
});

test('开启：注入生效；工具就绪时含输出契约，未就绪时不含（避免让模型调用不存在的工具）', async () => {
  const { vm } = makeVmWithHistory();
  const host = fakeHost(vm);
  try {
    const seams = applySeams(host.ctx, vm, {});
    const session = fakeSession();
    const agent = {
      session,
      ctx: { tools: { register: (t) => { host.tools.push(t); return () => {}; } } },
    };

    setSessionActive(vm.db, S, true);
    // 工具定义器还没就绪 → 注入状态，但**不**注入输出契约
    const [noTools] = await host.fire('system-prompt/assemble', ...assembleArgs(agent));
    assert.ok(noTools.contexts.length > 0, '开启后应注入');
    const joined1 = noTools.contexts.map((c) => c.text).join('\n');
    assert.ok(joined1.includes('1064nm'), '应带权威状态');
    assert.ok(!joined1.includes('contextvm_commit_state'), '工具未就绪时 MUST NOT 注入输出契约');

    // 定义器就绪 → 工具注册进该会话作用域，输出契约随之出现
    seams.setDefineTool((def) => def);
    const [withTools] = await host.fire('system-prompt/assemble', ...assembleArgs(agent));
    assert.equal(host.tools.length, 8, '开启后工具应注册进该 agent 作用域');
    const joined2 = withTools.contexts.map((c) => c.text).join('\n');
    assert.ok(joined2.includes('contextvm_commit_state'), '工具就绪后应注入输出契约');
  } finally {
    vm.close();
  }
});

test('开启：轮末才做后台抽取（休眠时为零调用）', async () => {
  const { vm, calls } = makeVmWithHistory();
  const host = fakeHost(vm);
  try {
    applySeams(host.ctx, vm, {});
    setSessionActive(vm.db, S, true);
    await host.fire('agent/turn-stopping', { agent: { session: fakeSession() }, turn: 1 });
    await new Promise((r) => setTimeout(r, 150));
    assert.ok(calls.includes('state_delta'), `开启后应做轮末抽取，实际调用：${calls.join(',')}`);
  } finally {
    vm.close();
  }
});

test('模式按会话持久化（跨重启保持开启）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cvm-mode-'));
  const dbPath = path.join(dir, 'contextvm.db');
  const llm = fakeLlm([{ text: '{}' }]);
  const vm1 = createContextVm({ rawConfig: {}, dbPath, llm });
  setSessionActive(vm1.db, S, true);
  vm1.close();

  const vm2 = createContextVm({ rawConfig: {}, dbPath, llm });
  try {
    assert.equal(isSessionActive(vm2.db, S), true, '模式应随库持久化');
    assert.equal(isSessionActive(vm2.db, 'sess-other'), false, '未开启的会话仍是休眠');
  } finally {
    vm2.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('命令：on 在拿不到 agent 作用域时如实失败，且 MUST NOT 写成"已开启"', () => {
  const { vm } = makeVmWithHistory();
  try {
    let def = null;
    const seamsLike = {
      activate: () => ({ ok: false, registered: [], reason: '该 agent 未提供 tools 作用域（不做全局兜底）' }),
      deactivate: () => ({ released: 0 }),
    };
    registerStatusCommand({ commands: { register: (d) => { def = d; return () => {}; } } }, vm, seamsLike);

    const bad = def.handler({ agent: { session: { id: S } }, rawInput: 'on' });
    assert.equal(bad.kind, 'success');
    assert.ok(/未能开启/.test(bad.text), `应如实报告失败，实际：${bad.text}`);
    assert.equal(isSessionActive(vm.db, S), false, '工具没注册上时 MUST NOT 把模式写成已开启');

    // 正常开启
    const okSeams = { activate: () => ({ ok: true, registered: ['a', 'b'] }), deactivate: () => ({ released: 2 }) };
    registerStatusCommand({ commands: { register: (d) => { def = d; return () => {}; } } }, vm, okSeams);
    const ok = def.handler({ agent: { session: { id: S } }, rawInput: 'on' });
    assert.ok(/已开启/.test(ok.text));
    assert.equal(isSessionActive(vm.db, S), true);

    // 状态报告要显示模式
    const st = def.handler({ agent: { session: { id: S } }, rawInput: '' });
    assert.ok(/模式: 已开启/.test(st.text), `状态应显示模式，实际：${st.text.slice(0, 120)}`);

    // 关闭
    const off = def.handler({ agent: { session: { id: S } }, rawInput: 'off' });
    assert.ok(/已关闭/.test(off.text));
    assert.equal(isSessionActive(vm.db, S), false);

    // 非法子命令
    const bad2 = def.handler({ agent: { session: { id: S } }, rawInput: 'xyz' });
    assert.equal(bad2.kind, 'error');
    assert.ok(/用法/.test(bad2.text));
  } finally {
    vm.close();
  }
});

test('子命令解析：裸命令 = 状态（无副作用），只有 on/off 改模式', () => {
  assert.equal(parseSubcommand(''), 'status');
  assert.equal(parseSubcommand('   '), 'status');
  assert.equal(parseSubcommand('on'), 'on');
  assert.equal(parseSubcommand(' ON '), 'on');
  assert.equal(parseSubcommand('off'), 'off');
  assert.equal(parseSubcommand('on now'), 'invalid');
  assert.equal(parseSubcommand('status'), 'invalid');
});

test('命令 MUST 声明 input —— 否则 web 客户端会把带参数的行当普通消息发给模型', () => {
  // 客户端 matchEnter 规则（dsh-client-ui-commands）：
  //   desc.input !== undefined → 认领整行并按命令执行；
  //   否则 `!bare` 时 return undefined → 掉进默认通道（当作消息发给模型）。
  // 真机症状：`/contextvm on` 被当消息送进模型，用户侧表现为"命令输入无反应"。

  const vm = createContextVm({ rawConfig: {}, dbPath: ':memory:', llm: fakeLlm([{ text: '{}' }]) });
  try {
    let def = null;
    registerStatusCommand({ commands: { register: (d) => { def = d; return () => {}; } } }, vm, {});
    assert.ok(def.input, '命令 MUST 声明 input，否则带参数的行不会被当作命令');
    assert.equal(typeof def.input.hint, 'string');
    assert.ok(def.input.hint.length > 0, 'hint 是客户端 leadingClaim 的输入提示，不能为空');
  } finally {
    vm.close();
  }
});
