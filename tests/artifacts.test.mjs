/**
 * Phase B 补全审计：Artifact 版本管理（§4.4 / §9.5 / §26 Phase B 的 artifact refs）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createContextVm } from '../lib/app/create.js';
import { deriveBudgets } from '../lib/app/config.js';
import { renderArtifacts } from '../lib/context/renderer.js';
import { fakeLlm } from './helpers.mjs';

const W = 262144;
const S = 'sess-art';

function setup() {
  const vm = createContextVm({ rawConfig: {}, dbPath: ':memory:', llm: fakeLlm([{ text: '{}' }]) });
  vm.runtime.setWindow(S, W);
  return { vm, budgets: deriveBudgets(vm.config, W) };
}

test('artifact：新版本取代旧版本，旧版本保留为 superseded（§4.4 与 §4.2 同原则）', () => {
  const { vm } = setup();
  try {
    const e1 = vm.raw.append({ sessionId: S, role: 'user', eventType: 'user_message', content: '生成 calib.md' });
    const v1 = vm.artifacts.register({
      sessionId: S, logicalName: 'calib.md', uri: 'file:///w/calib.md', summary: '标定记录 v1', createdEventId: e1.eventId,
    });
    assert.equal(v1.artifact.version, 1);
    assert.equal(v1.superseded, null);

    const e2 = vm.raw.append({ sessionId: S, role: 'user', eventType: 'user_message', content: '更新 calib.md' });
    const v2 = vm.artifacts.register({
      sessionId: S, logicalName: 'calib.md', uri: 'file:///w/calib.md', summary: '标定记录 v2', createdEventId: e2.eventId,
    });
    assert.equal(v2.artifact.version, 2);
    assert.equal(v2.superseded, v1.artifact.artifactId);
    assert.equal(vm.artifacts.get(v1.artifact.artifactId).status, 'superseded');
    assert.equal(vm.artifacts.get(v1.artifact.artifactId).summary, '标定记录 v1', '旧版本内容不得被改写');

    assert.equal(vm.artifacts.active(S).length, 1);
    assert.equal(vm.artifacts.active(S)[0].version, 2);
    assert.deepEqual(vm.artifacts.history(S, 'calib.md').map((a) => [a.version, a.status]), [
      [1, 'superseded'],
      [2, 'active'],
    ]);
  } finally {
    vm.close();
  }
});

test('artifact：只存引用与摘要，不把正文塞进 state（§4.4）', () => {
  const { vm } = setup();
  try {
    vm.artifacts.register({ sessionId: S, logicalName: 'big.md', uri: 'file:///w/big.md', summary: '一句话摘要' });
    assert.equal(vm.state.all(S).length, 0, 'artifact MUST NOT 落进 state_items');
    const rendered = renderArtifacts(vm.artifacts.active(S));
    assert.ok(rendered.includes('big.md@v1'));
    assert.ok(rendered.includes('uri=file:///w/big.md'));
    assert.ok(rendered.includes('一句话摘要'));
  } finally {
    vm.close();
  }
});

test('artifact：编译产物含当前产物段，并计入 includedArtifactIds（§9.5）', () => {
  const { vm } = setup();
  try {
    const e = vm.raw.append({ sessionId: S, role: 'user', eventType: 'user_message', content: '约束 1064nm' });
    vm.state.upsert({ sessionId: S, itemType: 'constraint', key: 'wl', value: '1064nm', sourceEventIds: [e.eventId] });
    const art = vm.artifacts.register({
      sessionId: S, logicalName: 'calib.md', uri: 'file:///w/calib.md', summary: '标定记录', createdEventId: e.eventId,
    });

    const ctx = vm.runtime.compile({ sessionId: S, query: '产物是什么' });
    const sec = ctx.renderedSections.find((s) => s.title === 'Current artifacts');
    assert.ok(sec, '应有当前产物段');
    assert.ok(sec.content.includes('calib.md@v1'));
    assert.deepEqual(ctx.includedArtifactIds, [art.artifact.artifactId]);
    // §9.5 顺序：产物段在 recent verbatim 之前
    const orderOf = (title) => ctx.renderedSections.find((s) => s.title === title)?.order ?? -1;
    assert.ok(orderOf('Current artifacts') < orderOf('Recent verbatim'), '产物段应排在 recent verbatim 之前');
  } finally {
    vm.close();
  }
});

test('artifact：超出组件预算时整段丢弃并记录降级，不截断其它高优先级内容（§9.3）', () => {
  const vm = createContextVm({
    rawConfig: { ratios: { context_components: { current_artifact_max: 0.00001 } } },
    dbPath: ':memory:',
    llm: fakeLlm([{ text: '{}' }]),
  });
  vm.runtime.setWindow(S, W);
  try {
    for (let i = 0; i < 5; i += 1) {
      vm.artifacts.register({ sessionId: S, logicalName: `f${i}.md`, summary: '摘要'.repeat(40) });
    }
    const ctx = vm.runtime.compile({ sessionId: S, query: 'q' });
    assert.ok(!ctx.renderedSections.some((s) => s.title === 'Current artifacts'), '超预算应整段不注入');
    assert.ok(ctx.notes.degraded.includes('artifact_section_dropped'));
    assert.deepEqual(ctx.includedArtifactIds, []);
  } finally {
    vm.close();
  }
});

test('artifact：按名字/摘要可检索（供 §14 memory tools 复用）', () => {
  const { vm } = setup();
  try {
    vm.artifacts.register({ sessionId: S, logicalName: 'calib.md', summary: '波长标定记录' });
    vm.artifacts.register({ sessionId: S, logicalName: 'notes.md', summary: '会议记录' });
    assert.deepEqual(vm.artifacts.search(S, 'calib').map((a) => a.logicalName), ['calib.md']);
    assert.deepEqual(vm.artifacts.search(S, '会议').map((a) => a.logicalName), ['notes.md']);
    assert.equal(vm.artifacts.search(S, '不存在').length, 0);
    assert.equal(vm.artifacts.stats(S).active, 2);
  } finally {
    vm.close();
  }
});

test('artifact：缺少 logicalName 或 sessionId 时拒绝登记', () => {
  const { vm } = setup();
  try {
    assert.throws(() => vm.artifacts.register({ sessionId: S }), /logicalName/);
    assert.throws(() => vm.artifacts.register({ logicalName: 'x.md' }), /sessionId/);
  } finally {
    vm.close();
  }
});
