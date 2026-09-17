/**
 * 注入策略审计：宿主托管上下文与自己写的记账事件 MUST NOT 作为对话内容注入
 * （§4.1 / §7.1 / §9.2）。
 *
 * 真机实测背景：宿主把 `Current runtime context` 快照与 `<system-reminder>` 技能目录
 * 写进 session surface，它们占某会话镜像内容的 **98%**；我们自己的 `state_delta`
 * 记账事件也进了 recent 与证据。结果是注入的 5860 token 里只有 31 token 是权威状态，
 * 榜首证据（0.871）完全不含对话内容。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  injectability, isInjectableContent, parseEventMetadata,
  HOST_MANAGED_FORMS, HOST_MANAGED_KINDS, BOOKKEEPING_EVENT_TYPES,
} from '../lib/core/injectability.js';
import { createContextVm } from '../lib/app/create.js';
import { makeBackend } from './helpers.mjs';
import { Retriever } from '../lib/retrieval/hybrid.js';
import { LexicalIndex } from '../lib/indexing/lexical.js';
import { resolveConfig } from '../lib/app/config.js';

const S = 'sess-inj';

test('判定：真实对话内容是 content，宿主托管与记账事件不是', () => {
  // 真实内容
  assert.equal(injectability('user_message', { sourceKind: 'user' }), 'content');
  assert.equal(injectability('assistant_message', { sourceKind: 'model' }), 'content');
  assert.equal(injectability('tool_result', { sourceKind: 'tool' }), 'content');
  // 宿主托管（真机实测的两种形态）
  assert.equal(injectability('system_note', { sourceKind: 'plugin', contextForm: 'snapshot' }), 'host_managed');
  assert.equal(injectability('system_note', { sourceKind: 'skill-catalog', contextForm: 'catalog' }), 'host_managed');
  // 只看 form 或只看 kind 也能判定（宿主新增 kind 时仍然拦得住）
  assert.equal(injectability('system_note', { contextForm: 'snapshot' }), 'host_managed');
  assert.equal(injectability('system_note', { sourceKind: 'skill-catalog' }), 'host_managed');
  // 我们自己的记账事件
  assert.equal(injectability('state_delta', {}), 'bookkeeping');
  assert.equal(isInjectableContent('state_delta', {}), false);

  // 未知形态一律按"可注入"：这里错了的代价不对称 —— 多注入只是浪费预算，
  // 误丢真实内容则是静默丢失。
  assert.equal(injectability('system_note', { sourceKind: 'unknown-plugin-kind' }), 'content');
  assert.equal(injectability('system_note', {}), 'content');
  assert.equal(injectability('system_note', { contextForm: 'notice' }), 'content');
  assert.equal(injectability('weird_new_type', {}), 'content');
  // 非 system_note 的事件即使带 snapshot form 也不算宿主托管（规则不外溢）
  assert.equal(injectability('assistant_message', { contextForm: 'snapshot' }), 'content');

  // metadata 容错：JSON 文本、损坏文本、null 都不抛
  assert.equal(injectability('system_note', '{"contextForm":"snapshot"}'), 'host_managed');
  assert.equal(injectability('system_note', '{损坏的 json'), 'content');
  assert.equal(injectability('system_note', null), 'content');
  assert.deepEqual(parseEventMetadata('{"a":1}'), { a: 1 });
  assert.deepEqual(parseEventMetadata('[1,2]'), {}, '非对象按无元数据处理');
  assert.deepEqual(parseEventMetadata(undefined), {});

  // 常量本身是冻结的（避免被下游改写）
  assert.ok(Object.isFrozen(HOST_MANAGED_FORMS) && Object.isFrozen(HOST_MANAGED_KINDS));
  assert.ok(HOST_MANAGED_FORMS.includes('snapshot') && BOOKKEEPING_EVENT_TYPES.includes('state_delta'));
});

test('recent verbatim：宿主样板与记账事件不进注入，真实对话照常进', () => {
  const vm = createContextVm({ rawConfig: {}, dbPath: ':memory:', llm: { async complete() { throw new Error('x'); } } });
  try {
    const add = (o) => vm.raw.append({ sessionId: S, ...o });
    add({ role: 'user', eventType: 'user_message', content: '真实用户问题：波长多少' });
    add({ role: 'system', eventType: 'system_note', content: 'Current runtime context. This snapshot supersedes ...', metadata: { sourceKind: 'plugin', contextForm: 'snapshot' } });
    add({ role: 'assistant', eventType: 'assistant_message', content: '真实助手回答：1064nm' });
    add({ role: 'system', eventType: 'system_note', content: '<system-reminder> skills ...', metadata: { sourceKind: 'skill-catalog', contextForm: 'catalog' } });
    add({ role: 'assistant', eventType: 'state_delta', content: '{"upserted":["st_1"]}' });

    vm.runtime.setWindow(S, 262144);
    const ctx = vm.runtime.compile({ sessionId: S, query: '波长多少' });
    const recent = ctx.renderedSections.find((s) => s.title === 'Recent verbatim');
    assert.ok(recent, '应有 recent 段');
    assert.ok(recent.content.includes('真实用户问题'), '真实用户消息必须进 recent');
    assert.ok(recent.content.includes('真实助手回答'), '真实助手消息必须进 recent');
    assert.ok(!recent.content.includes('Current runtime context'), '宿主运行时快照 MUST NOT 进 recent');
    assert.ok(!recent.content.includes('<system-reminder>'), '技能目录 MUST NOT 进 recent');
    assert.ok(!recent.content.includes('upserted'), '我们自己的记账事件 MUST NOT 进 recent');
    assert.equal(ctx.notes.skippedNonContent, 3, '应记录被跳过的非内容事件数');
  } finally {
    vm.close();
  }
});

test('recent verbatim：宿主样板占比极高时，真实对话仍能进来（扫描倍数生效）', () => {
  const vm = createContextVm({ rawConfig: {}, dbPath: ':memory:', llm: { async complete() { throw new Error('x'); } } });
  try {
    // 先铺真实对话，再压上大量宿主样板（模拟真机：样板远多于真实内容）
    for (let i = 1; i <= 3; i++) {
      vm.raw.append({ sessionId: S, role: 'user', eventType: 'user_message', content: `真实提问 ${i}` });
    }
    for (let i = 1; i <= 40; i++) {
      vm.raw.append({
        sessionId: S, role: 'system', eventType: 'system_note',
        content: `Current runtime context 第 ${i} 份快照`,
        metadata: { sourceKind: 'plugin', contextForm: 'snapshot' },
      });
    }
    vm.runtime.setWindow(S, 262144);
    const ctx = vm.runtime.compile({ sessionId: S, query: '提问' });
    const recent = ctx.renderedSections.find((s) => s.title === 'Recent verbatim');
    assert.ok(recent, '应有 recent 段');
    assert.ok(recent.content.includes('真实提问 3'), '最近的真实对话 MUST 仍然进得来，不被样板挤掉');
    assert.ok(!recent.content.includes('快照'));
  } finally {
    vm.close();
  }
});

test('检索：非内容事件不进候选、不进证据，也不借邻居扩展混进来', () => {
  const be = makeBackend();
  const cfg = resolveConfig({});
  const lexical = new LexicalIndex(be.db);
  const retriever = new Retriever({
    db: be.db, raw: be.raw, tokenizer: be.tokenizer, lexical, state: be.state, config: cfg,
  });

  // 宿主样板（19k 字符级别的快照，含查询词），夹在两条真实消息之间
  be.raw.append({ sessionId: S, role: 'user', eventType: 'user_message', content: '约定：标定基准波长是 1064.37nm' });
  be.raw.append({
    sessionId: S, role: 'system', eventType: 'system_note',
    content: 'Current runtime context: 波长相关的宿主样板 ' + '填充'.repeat(500),
    metadata: { sourceKind: 'plugin', contextForm: 'snapshot' },
  });
  be.raw.append({ sessionId: S, role: 'assistant', eventType: 'assistant_message', content: '好的，波长记下了' });
  // 我们自己的记账事件
  be.raw.append({ sessionId: S, role: 'assistant', eventType: 'state_delta', content: '{"upserted":["st_1"],"波长":"1064.37"}' });

  const cands = retriever.candidates(S, '波长', {});
  const ids = cands.map((c) => c.eventId);
  assert.ok(ids.length >= 2, `真实内容应仍在候选池，实际 ${ids.length}`);
  assert.equal(retriever.lastExcluded.nonContent, 2, '宿主样板与记账事件都应被排除（观测计数）');

  // 排除而非降权：非内容事件 MUST NOT 出现在候选里
  const types = be.db
    .prepare('SELECT event_id, event_type FROM raw_events WHERE session_id = ?')
    .all(S);
  const nonContentIds = types.filter((t) => t.event_type !== 'user_message' && t.event_type !== 'assistant_message').map((t) => t.event_id);
  for (const id of nonContentIds) {
    assert.ok(!ids.includes(id), `非内容事件 ${id} MUST NOT 成为候选`);
  }

  // 邻居扩展同样不得把它们拖进证据束
  const { bundles } = retriever.retrieve(S, '波长', { tokenBudget: 100000 });
  const allSources = bundles.flatMap((b) => b.sourceEventIds ?? []);
  for (const id of nonContentIds) {
    assert.ok(!allSources.includes(id), `非内容事件 ${id} MUST NOT 借邻居扩展进入证据`);
  }
  const text = bundles.map((b) => b.content ?? '').join('\n');
  assert.ok(!text.includes('宿主样板'), '证据正文里不得出现宿主样板');
  assert.ok(text.includes('1064.37nm'), '真实证据必须照常给出');
  // 证据规模应贴近真实内容，而不是被 19k 字符的样板撑大
  assert.ok(
    bundles.reduce((a, b) => a + (b.content?.length ?? 0), 0) < 2000,
    '证据规模 MUST NOT 被宿主样板撑大',
  );
});
