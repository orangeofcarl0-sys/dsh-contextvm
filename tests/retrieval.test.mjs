/**
 * Phase A 审计：lexical / neighborhood / hybrid 检索（§7.1–§7.4 / §9.4）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeBackend } from './helpers.mjs';
import { LexicalIndex } from '../lib/indexing/lexical.js';
import { Retriever, hasExactFirst, exactLiterals, WEIGHTS } from '../lib/retrieval/hybrid.js';
import { expandNeighborhoods } from '../lib/retrieval/neighborhood.js';
import { resolveConfig } from '../lib/app/config.js';
import { normalizeSearchText, toMatchExpression } from '../lib/core/text.js';

const S = 'sess-r';

function setup() {
  const be = makeBackend();
  const cfg = resolveConfig({});
  const lexical = new LexicalIndex(be.db);
  const retriever = new Retriever({
    db: be.db, raw: be.raw, tokenizer: be.tokenizer, lexical, state: be.state, config: cfg,
  });
  return { be, cfg, lexical, retriever };
}

test('归一化：CJK 逐字切开，ASCII 原样；MATCH 表达式拆项后 OR（不要求整句连续）', () => {
  assert.equal(normalizeSearchText('上下文abc虚拟化'), '上 下 文 abc 虚 拟 化');
  // 单术语保持整体短语，避免 . / - 被当作 FTS 语法
  assert.equal(toMatchExpression('1.693'), '"1.693"');
  assert.equal(toMatchExpression(''), null);
  assert.equal(toMatchExpression('   '), null);

  // 关键回归：多术语查询必须拆成 OR 项，MUST NOT 拼成一条连续短语
  // （曾经的缺陷：整体加引号 → 长历史下检索恒为空）
  const m = toMatchExpression('当前架构方案是什么？波长多少？');
  assert.ok(m.includes(' OR '), `应为多项 OR，实际 ${m}`);
  assert.ok(m.includes('"当 前"'), 'CJK 应切为二元组短语');
  assert.ok(m.includes('"波 长"'), '应含"波长"这一二元组');
  assert.ok(!m.startsWith('"当 前 架 构'), 'MUST NOT 变回整句短语');
});

test('检索：多术语中文查询能命中（长历史下的实际形态）', () => {
  const { be, lexical } = setup();
  try {
    be.raw.append({ sessionId: S, role: 'user', eventType: 'user_message', content: '早期约定：标定基准波长是 1064.37nm' });
    be.raw.append({ sessionId: S, role: 'user', eventType: 'user_message', content: '架构决定用 B 方案' });
    be.raw.append({ sessionId: S, role: 'user', eventType: 'user_message', content: '完全无关的一段叙述' });
    const hits = lexical.search(S, '当前架构方案是什么？波长多少？', { limit: 10 });
    assert.ok(hits.length >= 2, `应命中两条相关事件，实际 ${hits.length}`);
  } finally {
    be.close();
  }
});

test('lexical：两字中文词可查（trigram 做不到，故弃用 trigram）', () => {
  const { be, lexical } = setup();
  try {
    be.raw.append({ sessionId: S, role: 'user', eventType: 'user_message', content: '网关预检估算器比真实分词器保守' });
    be.raw.append({ sessionId: S, role: 'user', eventType: 'user_message', content: '这一段与检索无关' });
    for (const q of ['预检', '分词', '网关']) {
      const hits = lexical.search(S, q, { limit: 10 });
      assert.equal(hits.length, 1, `查询「${q}」应命中 1 条`);
    }
    assert.equal(lexical.search(S, '不存在的词', { limit: 10 }).length, 0);
  } finally {
    be.close();
  }
});

test('lexical：相关内容得分更高，relevance 落在 [0,1] 且越大越好', () => {
  const { be, lexical } = setup();
  try {
    be.raw.append({ sessionId: S, role: 'user', eventType: 'user_message', content: '预检 预检 预检 估算器' });
    be.raw.append({ sessionId: S, role: 'user', eventType: 'user_message', content: '预检 估算器 别的词' });
    const hits = lexical.search(S, '预检 估算器', { limit: 10 });
    assert.equal(hits.length, 2);
    assert.ok(hits[0].relevance >= hits[1].relevance);
    for (const h of hits) assert.ok(h.relevance >= 0 && h.relevance <= 1);
  } finally {
    be.close();
  }
});

test('exact-first：识别数字/文件名/标识符/引号原话（§7.2）', () => {
  assert.equal(hasExactFirst('窗口是 262144 吗'), true);
  assert.equal(hasExactFirst('看一下 lib/index.js'), true);
  assert.equal(hasExactFirst('请回顾一下之前的讨论'), false);
  assert.deepEqual(exactLiterals('查 union-alpha 与 1.693'), ['1.693', 'union-alpha']);
});

test('neighborhood：相邻窗口合并为不重叠片段（§7.3）', () => {
  const { be } = setup();
  try {
    const ids = [];
    for (let i = 0; i < 10; i += 1) {
      ids.push(be.raw.append({ sessionId: S, role: 'user', eventType: 'user_message', content: `第${i}条` }).eventId);
    }
    const segs = expandNeighborhoods(be.raw, [ids[2], ids[3], ids[8]], { before: 1, after: 1 });
    assert.equal(segs.length, 2, '相邻命中应合并');
    assert.deepEqual(segs[0].hitEventIds, [ids[2], ids[3]]);
    assert.equal(segs[0].events[0].content, '第1条');
    assert.equal(segs[1].events.at(-1).content, '第9条');
    assert.ok(segs[0].endSeq < segs[1].startSeq);
  } finally {
    be.close();
  }
});

test('检索结果不孤立返回：命中事件带前后邻居（§7.3）', () => {
  const { be, retriever } = setup();
  try {
    be.raw.append({ sessionId: S, role: 'user', eventType: 'user_message', content: '前置说明' });
    be.raw.append({ sessionId: S, role: 'user', eventType: 'user_message', content: '关键约束是波长 1064nm' });
    be.raw.append({ sessionId: S, role: 'user', eventType: 'user_message', content: '后续补充' });
    const { bundles } = retriever.retrieve(S, '1064nm', { tokenBudget: 5000 });
    assert.equal(bundles.length, 1);
    assert.equal(bundles[0].sourceEventIds.length, 3, '应含前后邻居');
    assert.ok(bundles[0].content.includes('前置说明'));
    assert.ok(bundles[0].content.includes('后续补充'));
  } finally {
    be.close();
  }
});

test('去重：同 content_hash 只保留一份证据（§9.4）', () => {
  const { be, retriever } = setup();
  try {
    // 相距 8 条，确保两条命中各自的 ±3 邻域不重叠，从而真正走到哈希去重分支
    be.raw.append({ sessionId: S, role: 'user', eventType: 'user_message', content: '完全一样的内容 预检' });
    for (let i = 0; i < 8; i += 1) {
      be.raw.append({ sessionId: S, role: 'assistant', eventType: 'assistant_message', content: `无关填充 ${i}` });
    }
    be.raw.append({ sessionId: S, role: 'assistant', eventType: 'assistant_message', content: '完全一样的内容 预检' });

    const { bundles, dropped } = retriever.retrieve(S, '预检', { tokenBudget: 5000 });
    assert.equal(bundles.length, 1, '同内容只保留一份证据');
    assert.equal(dropped.dedup, 1, '第二条同内容命中应由 content_hash 去重挡住');
  } finally {
    be.close();
  }
});

test('相邻同内容命中由"邻域已覆盖"计数，不重复出证据（§7.3 + §9.4）', () => {
  const { be, retriever } = setup();
  try {
    be.raw.append({ sessionId: S, role: 'user', eventType: 'user_message', content: '相邻同内容 预检' });
    be.raw.append({ sessionId: S, role: 'assistant', eventType: 'assistant_message', content: '相邻同内容 预检' });
    const { bundles, dropped } = retriever.retrieve(S, '预检', { tokenBudget: 5000 });
    assert.equal(bundles.length, 1);
    assert.equal(dropped.covered, 1, '第二条命中已落在首条证据的邻域内');
    assert.equal(dropped.dedup, 0, '被邻域覆盖时不计入 dedup，避免两个计数器重复记账');
  } finally {
    be.close();
  }
});

test('预算不足时严格不超额，且不孤立返回命中（§9.3 + §7.3）', () => {
  const { be, retriever } = setup();
  try {
    for (let i = 0; i < 6; i += 1) {
      be.raw.append({ sessionId: S, role: 'user', eventType: 'user_message', content: `预检 条目${i} ${'填充 '.repeat(20)}` });
    }
    // 预算远小于任一完整片段：MUST 返回 0 条并报告丢弃，而不是放行超额证据
    const tiny = retriever.retrieve(S, '预检', { tokenBudget: 120 });
    assert.equal(tiny.bundles.length, 0, '不得为凑数而超额');
    assert.equal(tiny.tokens, 0);
    assert.ok(tiny.dropped.budget >= 1);

    // 现实预算下应能装入若干条，且总量在预算内
    const real = retriever.retrieve(S, '预检', { tokenBudget: 4000 });
    assert.ok(real.bundles.length >= 1);
    assert.ok(real.tokens <= 4000, `实际 ${real.tokens} 应在预算内`);

    // 同一事件不得跨证据重复；且不得出现"内部孤立命中"
    const all = new Set();
    for (const b of real.bundles) {
      for (const id of b.sourceEventIds) {
        assert.ok(!all.has(id), '同一事件不应在两条证据中重复出现');
        all.add(id);
      }
    }
    const allEvents = be.raw.range(S);
    const minSeq = allEvents[0].seq;
    const maxSeq = allEvents.at(-1).seq;
    for (const b of real.bundles) {
      if (b.sourceEventIds.length >= 2) continue;
      const seq = be.raw.get(b.hitEventIds[0]).seq;
      assert.ok(seq === minSeq || seq === maxSeq, '孤立返回只允许出现在会话边界');
    }
  } finally {
    be.close();
  }
});

test('权重：缺 semantic 分量时按剩余权重重新归一化，分数仍落在 [0,1]', () => {
  const { be, lexical } = setup();
  try {
    be.raw.append({ sessionId: S, role: 'user', eventType: 'user_message', content: '预检估算器' });
    const base = new Retriever({
      db: be.db, raw: be.raw, tokenizer: be.tokenizer, lexical, state: be.state, config: resolveConfig({}),
    });
    const withoutSemantic = base.candidates(S, '预检');
    assert.equal(withoutSemantic.length, 1);
    const c = withoutSemantic[0];
    assert.ok(c.components.semantic === undefined);
    // 归一化后仅 lexical/recency/entity_task/state_priority/source_authority 参与
    const avail = Object.entries(WEIGHTS).filter(([k]) => c.components[k] !== undefined);
    assert.equal(avail.length, 5);
    assert.ok(c.score > 0 && c.score <= 1.001, `score=${c.score}`);

    // 接上 semantic 端口后（Phase B 的形态），同一接口即可生效，无需改调用方
    const withSemantic = new Retriever({
      db: be.db, raw: be.raw, tokenizer: be.tokenizer, lexical, state: be.state, config: resolveConfig({}),
      semantic: { search: () => [{ eventId: c.eventId, relevance: 1 }] },
    });
    const c2 = withSemantic.candidates(S, '预检')[0];
    assert.equal(c2.components.semantic, 1);
    assert.notEqual(c2.score, c.score);
  } finally {
    be.close();
  }
});

test('authority：同等条件下 user 消息优先于 assistant 消息（§16.1）', () => {
  const { be, retriever } = setup();
  try {
    const a = be.raw.append({ sessionId: S, role: 'assistant', eventType: 'assistant_message', content: '目标 是 A' });
    const u = be.raw.append({ sessionId: S, role: 'user', eventType: 'user_message', content: '目标 是 B' });
    const cands = retriever.candidates(S, '目标');
    const map = new Map(cands.map((c) => [c.eventId, c]));
    assert.ok(map.get(u.eventId).score > map.get(a.eventId).score);
  } finally {
    be.close();
  }
});

test('state provenance 命中的事件获得 state_priority 加分（§7.1）', () => {
  const { be, retriever } = setup();
  try {
    const plain = be.raw.append({ sessionId: S, role: 'user', eventType: 'user_message', content: '约束 波长 1064nm' });
    const cited = be.raw.append({ sessionId: S, role: 'user', eventType: 'user_message', content: '约束 波长 1064nm' });
    be.state.upsert({
      sessionId: S, itemType: 'constraint', key: 'wavelength', value: '1064nm', sourceEventIds: [cited.eventId],
    });
    const cands = retriever.candidates(S, '波长');
    const map = new Map(cands.map((c) => [c.eventId, c]));
    assert.equal(map.get(cited.eventId).components.state_priority, 1);
    assert.equal(map.get(plain.eventId).components.state_priority, 0);
  } finally {
    be.close();
  }
});
