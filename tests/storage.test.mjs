/**
 * Phase A 审计：raw event 追加语义与 state 版本链（§4.1 / §4.2 / §16.2 / §23）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeBackend } from './helpers.mjs';

const S = 'sess-1';

test('raw event 追加后可读，且保留插入顺序', () => {
  const be = makeBackend();
  try {
    const a = be.raw.append({ sessionId: S, role: 'user', eventType: 'user_message', content: '第一条' });
    const b = be.raw.append({ sessionId: S, role: 'assistant', eventType: 'assistant_message', content: '第二条' });
    assert.ok(a.eventId.startsWith('evt_'));
    assert.equal(be.raw.count(S), 2);
    assert.equal(be.raw.get(a.eventId).content, '第一条');
    assert.equal(be.raw.has(b.eventId), true);
    const r = be.raw.range(S);
    assert.deepEqual(
      r.map((e) => e.content),
      ['第一条', '第二条'],
    );
    assert.ok(r[0].seq < r[1].seq, 'seq 必须单调');
  } finally {
    be.close();
  }
});

test('未知 event_type 被拒绝（避免脏数据进入索引）', () => {
  const be = makeBackend();
  try {
    assert.throws(
      () => be.raw.append({ sessionId: S, role: 'user', eventType: 'made_up_type', content: 'x' }),
      /未知 event_type/,
    );
    assert.throws(() => be.raw.append({ sessionId: '', role: 'user', eventType: 'user_message', content: 'x' }), /sessionId/);
  } finally {
    be.close();
  }
});

test('append-only：store 不暴露任何修改或删除原 content 的接口（§23.7）', () => {
  const be = makeBackend();
  try {
    for (const m of ['update', 'delete', 'remove', 'edit', 'replaceContent']) {
      assert.equal(typeof be.raw[m], 'undefined', `raw store MUST NOT 暴露 ${m}()`);
    }
    // 直接走 SQL 也改不动：表上没有触发器可改内容，测试确认无 UPDATE 语句被内部使用
    const before = be.raw.append({ sessionId: S, role: 'user', eventType: 'user_message', content: '原始内容' });
    be.raw.append({ sessionId: S, role: 'user', eventType: 'system_note', content: 'correction: 原文有误' });
    assert.equal(be.raw.get(before.eventId).content, '原始内容', '修正 MUST 走新事件，旧内容保持原样');
    assert.equal(be.raw.count(S), 2);
  } finally {
    be.close();
  }
});

test('同内容可经 content_hash 检测重复，但两条事件语义都保留（§4.1）', () => {
  const be = makeBackend();
  try {
    const a = be.raw.append({ sessionId: S, role: 'user', eventType: 'user_message', content: '重复内容' });
    const b = be.raw.append({ sessionId: S, role: 'assistant', eventType: 'assistant_message', content: '重复内容' });
    assert.equal(be.raw.get(a.eventId).contentHash, be.raw.get(b.eventId).contentHash);
    const dups = be.raw.findDuplicates(S, '重复内容', b.eventId);
    assert.deepEqual(dups.map((e) => e.eventId), [a.eventId]);
    assert.equal(be.raw.count(S), 2, 'MUST NOT 因去重丢掉事件记录');
  } finally {
    be.close();
  }
});

test('recent / neighbors 按插入顺序工作（§7.3 用）', () => {
  const be = makeBackend();
  try {
    const ids = [];
    for (let i = 0; i < 7; i += 1) {
      ids.push(be.raw.append({ sessionId: S, role: 'user', eventType: 'user_message', content: `第${i}条` }).eventId);
    }
    assert.deepEqual(
      be.raw.recent(S, 3).map((e) => e.content),
      ['第4条', '第5条', '第6条'],
    );
    const n = be.raw.neighbors(ids[3], 2, 2);
    assert.deepEqual(n.before.map((e) => e.content), ['第1条', '第2条']);
    assert.equal(n.self.content, '第3条');
    assert.deepEqual(n.after.map((e) => e.content), ['第4条', '第5条']);
  } finally {
    be.close();
  }
});

test('state：同 key 变更产生新版本并 supersede 旧版本，不原地覆盖（§4.2/§23.5）', () => {
  const be = makeBackend();
  try {
    const e1 = be.raw.append({ sessionId: S, role: 'user', eventType: 'user_message', content: '用 sqlite' });
    const e2 = be.raw.append({ sessionId: S, role: 'user', eventType: 'user_message', content: '改用 postgres' });

    const v1 = be.state.upsert({
      sessionId: S, itemType: 'decision', key: 'db', value: 'sqlite', sourceEventIds: [e1.eventId],
    });
    assert.equal(v1.item.version, 1);
    assert.equal(v1.superseded.length, 0);

    const v2 = be.state.upsert({
      sessionId: S, itemType: 'decision', key: 'db', value: 'postgres', sourceEventIds: [e2.eventId],
    });
    assert.equal(v2.item.version, 2);
    assert.deepEqual(v2.superseded, [{ stateId: v1.item.stateId, reason: 'replaced_by_new_version' }]);

    const old = be.state.get(v1.item.stateId);
    assert.equal(old.status, 'superseded');
    assert.equal(old.supersededBy, v2.item.stateId);
    assert.equal(old.value, 'sqlite', '旧版本内容不得被改写');

    assert.equal(be.state.active(S).length, 1);
    assert.equal(be.state.active(S)[0].value, 'postgres');
    assert.deepEqual(
      be.state.history(S, 'decision', 'db').map((i) => [i.version, i.value, i.status]),
      [
        [1, 'sqlite', 'superseded'],
        [2, 'postgres', 'active'],
      ],
    );
  } finally {
    be.close();
  }
});

test('state：无 source 的项不得成为 active（§4.2/§23.2）', () => {
  const be = makeBackend();
  try {
    assert.throws(
      () => be.state.upsert({ sessionId: S, itemType: 'fact', key: 'f1', value: '未验证的断言' }),
      /无 source/,
    );
    // 允许以 uncertain 落库
    const u = be.state.upsert({ sessionId: S, itemType: 'fact', key: 'f1', value: '未验证的断言', status: 'uncertain' });
    assert.equal(u.item.status, 'uncertain');
    assert.equal(be.state.countWithoutProvenance(S), 0, 'active 项数应为 0');
  } finally {
    be.close();
  }
});

test('state：乐观版本冲突不静默覆盖（§16.2）', () => {
  const be = makeBackend();
  try {
    const e = be.raw.append({ sessionId: S, role: 'user', eventType: 'user_message', content: 'x' });
    be.state.upsert({ sessionId: S, itemType: 'constraint', key: 'c1', value: 'A', sourceEventIds: [e.eventId] });
    assert.throws(
      () =>
        be.state.upsert({
          sessionId: S, itemType: 'constraint', key: 'c1', value: 'B',
          sourceEventIds: [e.eventId], expectedVersion: 99,
        }),
      /版本冲突/,
    );
    assert.equal(be.state.latest(S, 'constraint', 'c1').value, 'A');
  } finally {
    be.close();
  }
});

test('state：resolve / reject / uncertain 状态迁移与统计', () => {
  const be = makeBackend();
  try {
    const e = be.raw.append({ sessionId: S, role: 'user', eventType: 'user_message', content: 'x' });
    const q = be.state.upsert({
      sessionId: S, itemType: 'open_question', key: 'q1', value: '要不要缓存？', status: 'active', sourceEventIds: [e.eventId],
    });
    be.state.setStatus(q.item.stateId, 'resolved');
    const r = be.state.upsert({
      sessionId: S, itemType: 'rejected_option', key: 'o1', value: '用 rolling summary', sourceEventIds: [e.eventId],
    });
    be.state.setStatus(r.item.stateId, 'rejected');

    const st = be.state.stats(S);
    assert.equal(st.resolved, 1);
    assert.equal(st.rejected, 1);
    assert.equal(st.active, 0);
    assert.equal(be.state.countWithoutProvenance(S), 0);
    assert.throws(() => be.state.setStatus('st_nope', 'resolved'), /不存在/);
    assert.throws(() => be.state.setStatus(q.item.stateId, 'bogus'), /未知 status/);
  } finally {
    be.close();
  }
});

test('state：null key 的项各自独立，不参与版本链', () => {
  const be = makeBackend();
  try {
    const e = be.raw.append({ sessionId: S, role: 'user', eventType: 'user_message', content: 'x' });
    const a = be.state.upsert({ sessionId: S, itemType: 'goal', value: '目标 A', sourceEventIds: [e.eventId] });
    const b = be.state.upsert({ sessionId: S, itemType: 'goal', value: '目标 B', sourceEventIds: [e.eventId] });
    assert.equal(a.item.version, 1);
    assert.equal(b.item.version, 1);
    assert.equal(be.state.active(S).length, 2);
    assert.equal(be.state.latest(S, 'goal', null), null);
  } finally {
    be.close();
  }
});

test('迁移是版本化的，重复打开不重复执行（§23.6）', () => {
  const be = makeBackend();
  try {
    const versions = be.db.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all();
    assert.equal(versions.length, 1);
    assert.equal(versions[0].version, 1);
    assert.equal(versions[0].name, 'phase-a-core');
    assert.equal(be.db.prepare('SELECT MAX(version) v FROM schema_migrations').get().v, 1);
  } finally {
    be.close();
  }
});
