/**
 * LLM 输出 schema 校验审计（§5.3 / §6.2 / §11.2 / §13.1 / §27.3）。
 *
 * §27.3 要求把所有 LLM 输出当不可信输入，且 §13.1 的结论是宿主缝不暴露
 * `response_format`、服务端不提供任何结构保证，因此本地校验是唯一防线。
 * 本文件逐条覆盖四类失败：JSON 语法错误、字段缺失、类型错误、幻觉字段。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseJsonLoose,
  validateDelta,
  validateEpisodeSummary,
  validateWorkerResult,
} from '../lib/llm/schemas.js';

const SRC = 'evt_1';

test('parseJsonLoose：覆盖 JSON 语法错误这一类失败', () => {
  assert.deepEqual(parseJsonLoose('{"a":1}').value, { a: 1 });
  // 夹带说明文字
  assert.deepEqual(parseJsonLoose('好的，结果如下：{"a":1} 请查收').value, { a: 1 });
  // 代码围栏
  assert.deepEqual(parseJsonLoose('```json\n{"a":1}\n```').value, { a: 1 });
  // 嵌套花括号与字符串内的花括号
  assert.deepEqual(parseJsonLoose('前言 {"a":{"b":"}"}} 后记').value, { a: { b: '}' } });
  // 确实无法解析
  assert.equal(parseJsonLoose('完全不是 JSON').value, null);
  assert.equal(parseJsonLoose('完全不是 JSON').error, 'no_parseable_json');
  assert.equal(parseJsonLoose('').error, 'empty');
  assert.equal(parseJsonLoose(null).error, 'empty');
});

test('validateDelta：字段缺失被拒', () => {
  const r = validateDelta({ upsert: [{ type: 'fact' }] });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('missing_value')));
});

test('validateDelta：类型错误被拒', () => {
  const r = validateDelta({ upsert: [{ type: 'fact', value: 'x', source_event_ids: 'evt_1' }] });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('source_not_array')));

  const r2 = validateDelta({ next_action: { text: 'x' } });
  assert.equal(r2.ok, false);
  assert.ok(r2.errors.some((e) => e.includes('next_action_not_string')));
});

test('validateDelta：幻觉字段被拒（顶层的未知键）', () => {
  const r = validateDelta({ upsert: [], bogus: 1, reasoning: '我想了想' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('unknown_field:bogus')));
  assert.ok(r.errors.some((e) => e.includes('unknown_field:reasoning')));
});

test('validateDelta：未知 item_type / status 被拒', () => {
  assert.equal(validateDelta({ upsert: [{ type: 'nonsense', value: 1, source_event_ids: [] }] }).ok, false);
  assert.equal(validateDelta({ upsert: [{ type: 'fact', value: 1, status: 'bogus', source_event_ids: [] }] }).ok, false);
});

test('validateDelta：合法输入被规范化（丢未用字段、next_action 并入 open）', () => {
  const r = validateDelta({
    upsert: [{ type: 'constraint', key: 'wl', value: '1064nm', source_event_ids: [SRC], extraIgnored: true }],
    supersede: [{ state_id: 'st_1', reason: 'r' }],
    resolve: ['st_2'],
    open: [{ value: '还有问题吗' }],
    next_action: '复核波长',
  });
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(r.delta).sort(), ['next_action', 'open', 'resolve', 'supersede', 'upsert']);
  assert.equal(r.delta.upsert[0].key, 'wl');
  assert.equal(r.delta.upsert[0].extraIgnored, undefined, '未知字段不得进入结果');
  assert.equal(r.delta.supersede[0].stateId, 'st_1');
  // next_action 保持顶层字段，MUST NOT 同时合成进 open（否则同一信息两处表示）
  assert.equal(r.delta.next_action, '复核波长');
  assert.ok(!r.delta.open.some((o) => o.type === 'next_action'), 'next_action 不得重复出现在 open 中');
});

test('validateDelta：空增量是合法输入（表示本轮无变化）', () => {
  const r = validateDelta({ upsert: [], supersede: [], resolve: [], open: [], next_action: null });
  assert.equal(r.ok, true);
  assert.deepEqual(r.delta.open, []);
});

test('validateDelta：supersede/resolve 支持字符串与对象两种写法', () => {
  const r = validateDelta({ supersede: ['st_1', { state_id: 'st_2', reason: 'x' }], resolve: ['st_3', { state_id: 'st_4' }] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.delta.supersede.map((s) => s.stateId), ['st_1', 'st_2']);
  assert.deepEqual(r.delta.resolve, ['st_3', 'st_4']);
});

test('validateEpisodeSummary：字段类型与范围端点被校验', () => {
  assert.equal(validateEpisodeSummary({ what_changed: 'not-array' }).ok, false);
  assert.equal(validateEpisodeSummary({ source_event_range: { start_event: 1, end_event: 'b' } }).ok, false);
  assert.equal(validateEpisodeSummary([]).ok, false);

  const good = validateEpisodeSummary({
    topic: 't', goal: 'g', what_changed: ['a', 1],
    source_event_range: { start_event: 'evt_a', end_event: 'evt_b' },
  });
  assert.equal(good.ok, true);
  assert.deepEqual(good.summary.whatChanged, ['a', '1'], '数字应被规范化为字符串');
  assert.equal(good.summary.sourceEventRange.startEvent, 'evt_a');
});

test('validateEpisodeSummary：数组长度受限，防止摘要膨胀', () => {
  const many = validateEpisodeSummary({
    what_changed: Array.from({ length: 50 }, (_, i) => `变化${i}`),
    important_numbers_or_identifiers: Array.from({ length: 50 }, (_, i) => `n${i}`),
  });
  assert.equal(many.ok, true);
  assert.equal(many.summary.whatChanged.length, 8);
  assert.equal(many.summary.importantNumbersOrIdentifiers.length, 12);
});

test('validateWorkerResult：每条 finding 必须有片内 source，coverage 必须完整', () => {
  assert.equal(validateWorkerResult({ findings: [], coverage: { start_event: 'a', end_event: 'b' } }).ok, true);
  assert.equal(validateWorkerResult({ findings: [{ claim: 'x' }], coverage: {} }).ok, false);
  assert.equal(
    validateWorkerResult({ findings: [{ claim: 'x', source_event_ids: [] }], coverage: { start_event: 'a', end_event: 'b' } }).ok,
    false,
  );
  // category 非法时降级为 evidence 而不是整体丢弃
  const r = validateWorkerResult({
    findings: [{ claim: 'x', source_event_ids: ['e'], category: 'bogus' }],
    coverage: { start_event: 'a', end_event: 'b', complete: true },
  });
  assert.equal(r.ok, true);
  assert.equal(r.result.findings[0].category, 'evidence');
  assert.equal(r.result.coverage.complete, true);
});

test('所有校验器对非对象输入一律拒绝，不抛异常', () => {
  for (const bad of [null, undefined, 'text', 42, []]) {
    assert.equal(validateDelta(bad).ok, false);
    assert.equal(validateEpisodeSummary(bad).ok, false);
    assert.equal(validateWorkerResult(bad).ok, false);
  }
});

test('scanBalancedJson：字符级状态机（字符串内的括号与转义）', async () => {
  const { scanBalancedJson } = await import('../lib/llm/schemas.js');
  assert.equal(scanBalancedJson('前言 {"a":1} 后记'), '{"a":1}');
  // 嵌套
  assert.equal(scanBalancedJson('x {"a":{"b":{"c":1}}} y'), '{"a":{"b":{"c":1}}}');
  // 字符串里的花括号不得影响配平
  assert.equal(scanBalancedJson('{"a":"}"}'), '{"a":"}"}');
  assert.equal(scanBalancedJson('{"a":"{"}'), '{"a":"{"}');
  // 转义引号
  assert.equal(scanBalancedJson('{"a":"\\""}'), '{"a":"\\""}');
  // 未闭合与无对象
  assert.equal(scanBalancedJson('{"a":1'), null);
  assert.equal(scanBalancedJson('没有对象'), null);
  // 配平后的子串必须真的可解析
  const s = scanBalancedJson('好 {"k":[1,2,{"n":"}"}]} 尾');
  assert.deepEqual(JSON.parse(s), { k: [1, 2, { n: '}' }] });
});

test('scanBalancedJson 与 parseJsonLoose 的协作：未闭合即判为不可解析', async () => {
  const { parseJsonLoose, scanBalancedJson } = await import('../lib/llm/schemas.js');
  assert.equal(scanBalancedJson('{"a":1'), null);
  assert.equal(parseJsonLoose('{"a":1').error, 'no_parseable_json');
});
