/**
 * 交互审计：人能不能方便地用。
 *
 * 覆盖两件对用户直接可见的事：
 *   1) **零配置安装必须真的持久化** —— 默认 dbPath 曾因 `null ?? ':memory:'` 落成内存库，
 *      导致文档推荐的零配置用法重启即丢失全部状态（真机跑零配置才发现）；
 *   2) **人读入口** —— `/contextvm` 状态命令；在此之前 ContextVM 对人是完全不可见的。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createContextVm } from '../lib/app/create.js';
import { renderStatus, registerStatusCommand, CONTEXTVM_COMMAND } from '../lib/commands/status.js';
import { defaultDbPath, kvSet } from '../lib/storage/sqlite.js';
import { fakeLlm } from './helpers.mjs';

const S = 'sess-interaction';

/** 把 DSH_HOME 指到临时目录，避免测试触碰用户真实库。 */
function withTempHome(fn) {
  const prev = process.env.DSH_HOME;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cvm-home-'));
  process.env.DSH_HOME = dir;
  try {
    return fn(dir);
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('零配置持久化：不传 dbPath 时落到默认文件库，MUST NOT 是内存库', () => {
  withTempHome((home) => {
    const vm = createContextVm({ rawConfig: {}, llm: fakeLlm([{ text: '{}' }]) });
    try {
      const file = vm.db.prepare('PRAGMA database_list').get()?.file ?? '';
      assert.ok(file.length > 0, '零配置必须产生文件库；内存库意味着重启即丢失全部状态');
      assert.equal(path.resolve(file), path.resolve(defaultDbPath()));
      assert.ok(file.startsWith(home), `库应位于 DSH_HOME 之下，实际 ${file}`);

      // 真的写了盘：关掉再开，数据还在
      vm.raw.append({ sessionId: S, role: 'user', eventType: 'user_message', content: '零配置持久化探针' });
      vm.close();
      const reopened = createContextVm({ rawConfig: {}, dbPath: file, llm: fakeLlm([{ text: '{}' }]) });
      try {
        assert.equal(reopened.raw.count(S), 1, '重开后应能读到上次写入的事件');
      } finally {
        reopened.close();
      }
    } finally {
      try {
        vm.close();
      } catch {
        /* 已关闭 */
      }
    }
  });
});

test('零配置持久化：显式 :memory: 仍然有效（测试与临时场景需要）', () => {
  const vm = createContextVm({ rawConfig: {}, dbPath: ':memory:', llm: fakeLlm([{ text: '{}' }]) });
  try {
    const file = vm.db.prepare('PRAGMA database_list').get()?.file ?? '';
    assert.equal(file, '', '显式 :memory: 时 database_list 的 file 为空');
  } finally {
    vm.close();
  }
});

test('状态命令：能注册、返回成功，且内容含用户关心的关键事实', () => {
  withTempHome(() => {
    const vm = createContextVm({ rawConfig: {}, llm: fakeLlm([{ text: '{}' }]) });
    try {
      vm.runtime.setWindow(S, 262144);
      vm.raw.append({ sessionId: S, role: 'user', eventType: 'user_message', content: '约束 波长 1064nm' });
      vm.state.upsert({
        sessionId: S, itemType: 'constraint', key: 'wl', value: '1064nm',
        sourceEventIds: [vm.raw.range(S)[0].eventId],
      });

      const registered = [];
      const ctx = { get: (n) => (n === 'commands' ? { register: (d) => { registered.push(d); return () => {}; } } : null) };
      const res = registerStatusCommand(ctx, vm);
      assert.equal(res.registered, true);
      assert.equal(registered.length, 1);
      assert.equal(registered[0].name, CONTEXTVM_COMMAND);
      assert.ok(registered[0].description.length > 10, '命令描述是发现性的关键');

      const out = registered[0].handler({ agent: { session: { id: S } }, rawInput: '' });
      assert.equal(out.kind, 'success');
      const text = out.text;
      // 用户最需要知道的四件事必须出现
      assert.ok(text.includes('262,144'), '应显示本会话窗口');
      assert.ok(/事件 1 条/.test(text), '应显示索引规模');
      assert.ok(/active 1/.test(text), '应显示状态规模');
      assert.ok(/语义索引: disabled/.test(text), '应说明语义索引状态（§22.3）');
      assert.ok(text.includes('contextvm.db'), '应显示库文件路径，便于用户确认持久化');
      assert.ok(!text.includes('内存库'), '零配置下不应警告内存库');
      // 真机上看过一次空括号：`编译统计: 0 次（）` —— by_mode 是空对象时被当成有值渲染
      assert.ok(!text.includes('（）'), '不得出现空括号（by_mode 为空时不应渲染括号）');
      assert.ok(!text.includes('平均 未知 token（'), '空 by_mode 不得留下悬挂括号');
    } finally {
      vm.close();
    }
  });
});

test('状态命令：宿主无 commands 服务时如实报告，不抛错', () => {
  const vm = createContextVm({ rawConfig: {}, dbPath: ':memory:', llm: fakeLlm([{ text: '{}' }]) });
  try {
    const res = registerStatusCommand({ get: () => null }, vm);
    assert.equal(res.registered, false);
    assert.ok(res.reason.includes('commands'));
    // 宿主 register 抛错也不能把插件启动带崩
    const bad = registerStatusCommand({ get: () => ({ register() { throw new Error('boom'); } }) }, vm);
    assert.equal(bad.registered, false);
    assert.ok(bad.reason.includes('boom'));
  } finally {
    vm.close();
  }
});

test('状态命令：渲染本身 MUST NOT 抛错（排障入口不能自己崩）', () => {
  // 刻意喂一个残缺 vm：每项都应降级为"未知"而不是抛
  const broken = {
    config: { route: { provider: 'p', model: 'm' } },
    runtime: { window() { throw new Error('no window'); }, semanticStatus() { throw new Error('x'); }, pendingDeltas() { throw new Error('y'); }, injectionScale() { throw new Error('z'); } },
    db: { prepare() { throw new Error('db gone'); } },
    raw: { count() { throw new Error('x'); }, totalTokens() { throw new Error('x'); } },
    state: { stats() { throw new Error('x'); } },
    episodes: { episodes: { stats() { throw new Error('x'); } } },
    artifacts: { stats() { throw new Error('x'); } },
    llmClient: {},
    telemetry: { report() { throw new Error('x'); } },
  };
  const text = renderStatus(broken, { agent: { session: { id: S } } });
  assert.ok(typeof text === 'string' && text.length > 0);
  assert.ok(text.includes('ContextVM 状态'));
  assert.ok(text.includes('未知'), '取不到的项应写"未知"');

  // 无会话上下文同样不抛
  assert.ok(renderStatus(broken, undefined).includes('ContextVM 状态'));
});

// ---------------- 待处理 delta 队列：真机缺陷回归 ----------------
//
// 队列是全局的（不按会话隔离），且现在真的持久化了。上一进程遗留的条目会被下次运行取出，
// 而其会话早已结束 → `window()` 按设计抛错 → `flushPendingDeltas` 整体抛出，
// 连 `kvSet(remain)` 都到不了：队列永不推进，当前会话的 delta 再也没机会抽取。
// 真机上表现为"第一次失败之后，状态就再也不更新了"。

function queueVm(script) {
  return createContextVm({ rawConfig: {}, dbPath: ':memory:', llm: fakeLlm(script) });
}

test('待处理队列：上一进程遗留的会话条目被剪掉，MUST NOT 占掉队列名额', async () => {
  const vm = queueVm([{ text: '{}' }]);
  try {
    vm.runtime.setWindow(S, 262144);
    const e = vm.raw.append({ sessionId: S, role: 'user', eventType: 'user_message', content: '约束 1064nm' });
    vm.runtime.enqueuePending({ sessionId: 'sess-dead', query: 'q', answer: 'a', eventIds: [], error: 'scheduled' });
    vm.runtime.enqueuePending({ sessionId: S, query: 'q', answer: 'a', eventIds: [e.eventId], error: 'scheduled' });

    const flush = await vm.runtime.flushPendingDeltas({ limit: 1 });
    assert.equal(flush.pruned, 1, '会话已结束的条目必须剪掉');
    assert.equal(flush.attempted, 1, '队首的旧条目不得占掉本次唯一的抽取名额');
    assert.equal(flush.results[0].entry.sessionId, S, '被抽取的应是仍然活着的那个会话');
    assert.equal(vm.runtime.pendingDeltas().length, 0, '本次会话的 delta 处理完即出队');
  } finally {
    vm.close();
  }
});

test('待处理队列：单条条目抛错 MUST NOT 阻断其余条目（每条独立容错）', async () => {
  const vm = queueVm([{ text: '{}' }]);
  try {
    const OTHER = 'sess-other';
    vm.runtime.setWindow(S, 262144);
    vm.runtime.setWindow(OTHER, 262144);
    vm.runtime.enqueuePending({ sessionId: OTHER, query: 'q', answer: 'a', eventIds: [], error: 'scheduled' });
    vm.runtime.enqueuePending({ sessionId: S, query: 'q', answer: 'a', eventIds: [], error: 'scheduled' });

    const orig = vm.runtime.extractDelta.bind(vm.runtime);
    vm.runtime.extractDelta = async (req) => {
      if (req.sessionId === OTHER) throw new Error('boom');
      return orig(req);
    };

    const flush = await vm.runtime.flushPendingDeltas({ limit: 5 });
    assert.equal(flush.attempted, 2, '抛错条目之后的条目仍须被尝试');
    assert.equal(flush.results[0].res.reason, 'flush_threw');
    assert.equal(flush.results[1].res.ok, true, '第二条应正常处理');
    assert.deepEqual(vm.runtime.pendingDeltas().map((x) => x.sessionId), [OTHER], '抛错条目留队，成功条目出队');
    assert.equal(vm.runtime.pendingDeltas()[0].attempts, 1, '重试次数应累加');
  } finally {
    vm.close();
  }
});

test('待处理队列：重试超限的条目被剪掉并如实上报，避免长期占位', async () => {
  const vm = queueVm([{ text: '{}' }]);
  try {
    vm.runtime.setWindow(S, 262144);
    // 直接构造队列状态：一条已重试到上限、一条正常
    kvSet(vm.db, 'pending_deltas', [
      { sessionId: S, query: 'stuck', answer: 'a', eventIds: [], error: 'unparseable', attempts: 5 },
      { sessionId: S, query: 'fresh', answer: 'a', eventIds: [], error: 'scheduled', attempts: 0 },
    ]);

    const flush = await vm.runtime.flushPendingDeltas({ limit: 5 });
    assert.equal(flush.pruned, 1, '超限条目应被剪掉');
    assert.equal(flush.attempted, 1, '正常条目仍应被处理');
    assert.equal(vm.runtime.pendingDeltas().length, 0, '成功处理后队列应清空');
  } finally {
    vm.close();
  }
});

