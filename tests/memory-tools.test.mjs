/**
 * §14 JIT memory tools 的行为审计。
 *
 * 为什么必须有这个文件：本轮重构 memory_tools 时，一次正则误匹配把
 * `fetch_artifact` 的 execute 与 `search_artifacts` 的实现错接了，而当时
 * **全部 164 项测试仍然全绿** —— 因为此前只测了"注册了几个工具"，没有任何
 * 测试真正调用过这 6 个工具。定义表与实现分离后，这类错接必须由行为测试兜住。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createContextVm } from '../lib/app/create.js';
import { deriveBudgets } from '../lib/app/config.js';
import { memoryTools, MEMORY_TOOL_NAMES } from '../lib/tools/memory_tools.js';
import { fakeLlm } from './helpers.mjs';

const W = 262144;
const S = 'sess-tools';

function setup() {
  const vm = createContextVm({ rawConfig: {}, dbPath: ':memory:', llm: fakeLlm([{ text: '{}' }]) });
  vm.runtime.setWindow(S, W);
  const tools = memoryTools(vm.runtime, { defineTool: (o) => o });
  const byName = new Map(tools.map((t) => [t.name, t]));
  const exec = { session: { id: S } };
  return { vm, tools, byName, exec, budgets: deriveBudgets(vm.config, W) };
}

test('定义表：工具名集合与导出的清单一致，且每个都有描述/参数/输出 schema', () => {
  const { vm, tools, byName } = setup();
  try {
    assert.deepEqual([...byName.keys()], [...MEMORY_TOOL_NAMES], 'MEMORY_TOOL_NAMES 必须与实现一致');
    for (const t of tools) {
      assert.ok(t.description.length > 10, `${t.name} 缺描述`);
      assert.ok(t.parameters && typeof t.parameters === 'object', `${t.name} 缺参数表`);
      assert.ok(t.output.schema.properties.source_event_ids, `${t.name} 缺 source_event_ids`);
      assert.ok(t.output.schema.properties.truncated, `${t.name} 缺 truncated`);
      assert.equal(typeof t.execute, 'function', `${t.name} 缺 execute`);
    }
  } finally {
    vm.close();
  }
});

test('search_memory：命中带来源与打分，未命中给明确空结果', async () => {
  const { vm, byName, exec } = setup();
  try {
    const e = vm.raw.append({ sessionId: S, role: 'user', eventType: 'user_message', content: '约束 基准波长 1064.37nm' });
    const hit = await byName.get('search_memory').execute({ query: '基准波长' }, exec);
    assert.equal(hit.ok, true);
    assert.ok(hit.result.includes('1064.37nm'));
    assert.ok(hit.source_event_ids.includes(e.eventId), '必须给出可追溯的来源');
    assert.equal(hit.truncated, false);

    const miss = await byName.get('search_memory').execute({ query: '完全不存在的术语' }, exec);
    assert.equal(miss.ok, true);
    assert.ok(miss.result.includes('未命中'));
    assert.deepEqual(miss.source_event_ids, []);
  } finally {
    vm.close();
  }
});

test('fetch_event：命中返回原文，跨会话与不存在的事件都被拒', async () => {
  const { vm, byName, exec } = setup();
  try {
    const e = vm.raw.append({ sessionId: S, role: 'user', eventType: 'user_message', content: '单条原文 ABC-123' });
    const other = vm.raw.append({ sessionId: 'other-sess', role: 'user', eventType: 'user_message', content: '别的会话' });

    const ok = await byName.get('fetch_event').execute({ event_id: e.eventId }, exec);
    assert.equal(ok.ok, true);
    assert.ok(ok.result.includes('ABC-123'));
    assert.deepEqual(ok.source_event_ids, [e.eventId]);

    const cross = await byName.get('fetch_event').execute({ event_id: other.eventId }, exec);
    assert.equal(cross.ok, false, 'MUST NOT 跨会话读取');

    const missing = await byName.get('fetch_event').execute({ event_id: 'evt_不存在' }, exec);
    assert.equal(missing.ok, false);
    assert.ok(missing.result.includes('未找到'));
  } finally {
    vm.close();
  }
});

test('fetch_events：批量取回并报告缺失条数，空入参被拒', async () => {
  const { vm, byName, exec } = setup();
  try {
    const a = vm.raw.append({ sessionId: S, role: 'user', eventType: 'user_message', content: '第一条' });
    const b = vm.raw.append({ sessionId: S, role: 'user', eventType: 'user_message', content: '第二条' });

    const ok = await byName.get('fetch_events').execute({ event_ids: [a.eventId, b.eventId] }, exec);
    assert.equal(ok.ok, true);
    assert.ok(ok.result.includes('第一条') && ok.result.includes('第二条'));
    assert.deepEqual(ok.source_event_ids, [a.eventId, b.eventId]);

    const partial = await byName.get('fetch_events').execute({ event_ids: [a.eventId, 'evt_无'] }, exec);
    assert.ok(partial.result.includes('1 条未找到'), '缺失条数必须显式告知');
    assert.deepEqual(partial.source_event_ids, [a.eventId]);

    const empty = await byName.get('fetch_events').execute({ event_ids: [] }, exec);
    assert.equal(empty.ok, false);
  } finally {
    vm.close();
  }
});

test('fetch_episode：给出摘要与原始范围，未知 id 被拒', async () => {
  const { vm, byName, exec } = setup();
  try {
    const e = vm.raw.append({ sessionId: S, role: 'user', eventType: 'user_message', content: '一段历史' });
    const ep = vm.episodes.episodes.createOpen({ sessionId: S, startEventId: e.eventId });
    vm.episodes.episodes.close(ep.episodeId, { endEventId: e.eventId, rawTokenCount: 12 });
    vm.episodes.episodes.setSummary(ep.episodeId, { summary: 'topic: 标定\nwhat_changed: 定了波长', summaryTokenCount: 10 });

    const ok = await byName.get('fetch_episode').execute({ episode_id: ep.episodeId }, exec);
    assert.equal(ok.ok, true);
    assert.ok(ok.result.includes('标定'));
    assert.ok(ok.result.includes(e.eventId), '必须给出原始范围，便于按需取原文');
    assert.deepEqual(ok.source_event_ids, [e.eventId, e.eventId]);
    assert.ok(ok.result.includes('导航'), '必须标注摘要是导航而非真相源');

    const missing = await byName.get('fetch_episode').execute({ episode_id: 'ep_无' }, exec);
    assert.equal(missing.ok, false);
  } finally {
    vm.close();
  }
});

test('fetch_artifact：返回引用与摘要，并说明正文不由本插件读取', async () => {
  const { vm, byName, exec } = setup();
  try {
    const e = vm.raw.append({ sessionId: S, role: 'user', eventType: 'user_message', content: '生成 calib.md' });
    const art = vm.artifacts.register({
      sessionId: S, logicalName: 'calib.md', uri: 'file:///w/calib.md', summary: '标定记录', createdEventId: e.eventId,
    });

    const ok = await byName.get('fetch_artifact').execute({ artifact_id: art.artifact.artifactId }, exec);
    assert.equal(ok.ok, true);
    assert.ok(ok.result.includes('calib.md'));
    assert.ok(ok.result.includes('file:///w/calib.md'), '必须给出 uri');
    assert.ok(ok.result.includes('不读取文件正文'), '必须说明正文归属，避免模型以为拿到了全文');
    assert.deepEqual(ok.source_event_ids, [e.eventId]);

    const missing = await byName.get('fetch_artifact').execute({ artifact_id: 'art_无' }, exec);
    assert.equal(missing.ok, false);
  } finally {
    vm.close();
  }
});

test('search_artifacts：按名字与摘要命中，未知词为空结果', async () => {
  const { vm, byName, exec } = setup();
  try {
    vm.artifacts.register({ sessionId: S, logicalName: 'calib.md', summary: '波长标定记录' });
    vm.artifacts.register({ sessionId: S, logicalName: 'notes.md', summary: '会议记录' });

    const byNameHit = await byName.get('search_artifacts').execute({ query: 'calib' }, exec);
    assert.equal(byNameHit.ok, true);
    assert.ok(byNameHit.result.includes('calib.md'));
    assert.ok(!byNameHit.result.includes('notes.md'));

    const bySummary = await byName.get('search_artifacts').execute({ query: '会议' }, exec);
    assert.ok(bySummary.result.includes('notes.md'));

    const miss = await byName.get('search_artifacts').execute({ query: '不存在的东西' }, exec);
    assert.equal(miss.ok, true);
    assert.ok(miss.result.includes('未找到'));
  } finally {
    vm.close();
  }
});

test('长内容被截断且显式标注，不静默丢内容（§14）', async () => {
  const { vm, byName, exec } = setup();
  try {
    const long = '这是一条很长的工具结果，用于验证截断行为。'.repeat(400);
    const e = vm.raw.append({ sessionId: S, role: 'user', eventType: 'user_message', content: long });
    const res = await byName.get('fetch_event').execute({ event_id: e.eventId }, exec);
    assert.equal(res.ok, true);
    assert.equal(res.truncated, true, '超预算必须标记 truncated');
    assert.ok(res.result.includes('已截断'), '必须显式写出已截断');
    assert.ok(
      vm.tokenizer.estimate(res.result) <= 1300,
      `截断后应接近预算上限，实际 ${vm.tokenizer.estimate(res.result)} token`,
    );
  } finally {
    vm.close();
  }
});

test('无会话上下文的工具明确失败，不静默返回空结果', async () => {
  const { vm, byName } = setup();
  try {
    const e = vm.raw.append({ sessionId: S, role: 'user', eventType: 'user_message', content: 'x' });
    const art = vm.artifacts.register({ sessionId: S, logicalName: 'a.md', summary: 'x' });
    // 六个工具的姿态必须统一：无会话上下文一律拒绝（否则按 id 取会成为跨会话旁路）
    const calls = [
      ['search_memory', { query: 'q' }],
      ['fetch_event', { event_id: e.eventId }],
      ['fetch_events', { event_ids: [e.eventId] }],
      ['fetch_episode', { episode_id: 'ep_x' }],
      ['fetch_artifact', { artifact_id: art.artifact.artifactId }],
      ['search_artifacts', { query: 'a' }],
    ];
    for (const [name, args] of calls) {
      const res = await byName.get(name).execute(args, {});
      assert.equal(res.ok, false, `${name} 无会话时应失败`);
      assert.ok(res.result.includes('无法确定会话'), `${name} 应给出明确原因`);
    }
  } finally {
    vm.close();
  }
});
