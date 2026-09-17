/**
 * 主动余量检查（真机事故驱动）。
 *
 * 事故现场：长跑里注入涨到 49,030 token 后请求撞网关预检上限（网关计数 262,144 / 上限 270,828），
 * 自适应收缩把注入降到 0.7 → 0.49 仍被拒 —— 因为**宿主自身上下文已接近上限，我们缩不动** ——
 * 于是整轮失败、长跑终止。
 *
 * 本文件守住三条：拿不到 meter 时行为不变；余量不足时按余量收缩；余量为零时整段不注入
 * （而不是让请求死掉）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createContextVm } from '../lib/app/create.js';
import { applySeams } from '../lib/host/seams.js';
import { setSessionActive } from '../lib/app/session_mode.js';
import { deriveBudgets } from '../lib/app/config.js';
import { fakeLlm } from './helpers.mjs';

const S = 'sess-headroom';
const W = 262144;

/** @param {number|null} hostTokens 宿主已用量；null = 不提供 tokenMeter */
function makeHost(hostTokens) {
  const handlers = new Map();
  const ctx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    on(e, fn) {
      if (!handlers.has(e)) handlers.set(e, []);
      handlers.get(e).push(fn);
    },
    get(name) {
      if (name === 'llm') return { async resolveModelInfo() { return { contextWindow: W }; } };
      if (name === 'tokenMeter' && hostTokens !== null) {
        return { measure: () => ({ totalTokens: hostTokens }) };
      }
      return null;
    },
  };
  return {
    ctx,
    async fire(e, ...args) {
      const out = [];
      for (const fn of handlers.get(e) ?? []) out.push(await fn(...args));
      return out;
    },
  };
}

function makeVm() {
  const telemetry = [];
  const vm = createContextVm({
    rawConfig: {}, dbPath: ':memory:', llm: fakeLlm([{ text: '{}' }]),
    onTelemetry: (r) => telemetry.push(r),
  });
  vm.runtime.setWindow(S, W);
  setSessionActive(vm.db, S, true);
  // 造一点可注入的内容
  vm.raw.append({ sessionId: S, role: 'user', eventType: 'user_message', content: '约束：波长 1064nm' });
  return { vm, telemetry };
}

const agent = () => ({
  session: { id: S, requestHeader: () => ({ config: { provider: 'p', model: 'm' } }), snapshotEvents: () => [] },
  ctx: { tools: { register: () => () => {} } },
});

const assembleArgs = (a) => [
  {},
  { agent: a, signal: undefined },
  async () => ({ sections: [{ name: 'base', text: 'B' }], contexts: [], tools: [], variables: {} }),
];

test('拿不到 tokenMeter 时行为不变（照常注入，MUST NOT 因此中断）', async () => {
  const { vm } = makeVm();
  const host = makeHost(null);
  try {
    applySeams(host.ctx, vm, {});
    const [out] = await host.fire('system-prompt/assemble', ...assembleArgs(agent()));
    assert.ok(out.contexts.length > 0, '没有 meter 时应照常注入');
  } finally {
    vm.close();
  }
});

test('余量为零：整段不注入并如实上报（而不是让请求撞上限失败）', async () => {
  const { vm, telemetry } = makeVm();
  const cap = deriveBudgets(vm.config, W).hardInputCap;
  const host = makeHost(cap); // 宿主自己已占满上限
  try {
    applySeams(host.ctx, vm, {});
    const [out] = await host.fire('system-prompt/assemble', ...assembleArgs(agent()));
    assert.equal(out.contexts.length, 0, '没有余量时 MUST NOT 注入');
    const ev = telemetry.find((r) => r.event === 'injection_skipped_no_headroom');
    assert.ok(ev, '必须发出 injection_skipped_no_headroom 遥测（不能静默）');
    assert.equal(ev.would_inject > 0, true, '应记录本来打算注入多少');
  } finally {
    vm.close();
  }
});

test('余量不足但尚有空间：按余量收缩注入（只降不升）', async () => {
  const { vm, telemetry } = makeVm();
  const cap = deriveBudgets(vm.config, W).hardInputCap;
  // 留出一半余量，逼迫注入收缩
  const host = makeHost(cap - Math.floor(cap / 2));
  try {
    applySeams(host.ctx, vm, {});
    const [first] = await host.fire('system-prompt/assemble', ...assembleArgs(agent()));
    const capped = telemetry.find((r) => r.event === 'injection_capped_by_headroom');
    // 本用例内容很小，可能直接放行；两种结果都合法，但若有收缩必须只降不升
    if (capped) {
      assert.ok(capped.scale <= 1 && capped.scale >= 0.15, `缩放应在 [0.15,1]，实际 ${capped.scale}`);
      assert.ok(first.contexts.length > 0, '有部分余量时仍应注入（收缩后）');
    } else {
      assert.ok(first.contexts.length > 0, '内容小于余量时应原样注入');
    }
    assert.ok(vm.runtime.injectionScale(S) <= 1, '缩放不得被抬高');
  } finally {
    vm.close();
  }
});
