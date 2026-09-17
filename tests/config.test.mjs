/**
 * Phase A 审计：配置不变量与预算派生（§19 / §19.1 / §9.1 / §9.2 / §9.6）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULTS,
  resolveConfig,
  validateInvariants,
  deriveBudgets,
  assertCompileFits,
} from '../lib/app/config.js';

const W = 262144; // Union Alpha 声明窗口

test('默认配置通过 §19.1 全部不变量', () => {
  const cfg = resolveConfig({});
  assert.equal(validateInvariants(cfg), true);
});

test('默认值是唯一事实来源：cordis.patch.yml 不重复定义预算（避免两处漂移）', async () => {
  const fs = await import('node:fs');
  const yml = fs.readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8');
  // mount 配置只允许出现 dbPath 与 route；任何预算/上限都必须在 config.js 里定义
  for (const forbidden of [
    'ratios:', 'context_components:', 'episode:', 'output:', 'retrieval:', 'global_scan:', 'maintenance:',
  ]) {
    assert.ok(!yml.includes(forbidden), `cordis.patch.yml 不应重复定义 ${forbidden}`);
  }
  assert.ok(yml.includes('dbPath:'), '挂载配置应显式给出 dbPath（可为 null）');
  assert.ok(yml.includes('provider:'), '挂载配置应显式给出 provider 路由键');

  // DEFAULTS 自身关键值（唯一来源）
  const cfg = resolveConfig({});
  assert.equal(cfg.ratios.normal_target_input, 0.458);
  assert.equal(cfg.ratios.heavy_target_input, 0.5);
  assert.equal(cfg.ratios.hard_input_cap, 0.55);
  assert.equal(cfg.ratios.preflight_ratio_assumed, 1.693);
  assert.equal(cfg.global_scan.chunk_target_ratio, DEFAULTS.global_scan.chunk_target_ratio);
});

test('偏序被破坏时拒绝启动', () => {
  const a = resolveConfig({ ratios: { heavy_target_input: 0.4 } }); // heavy < normal
  assert.throws(() => validateInvariants(a), /偏序|必须 </);
  const b = resolveConfig({ ratios: { hard_input_cap: 0.45 } }); // cap < heavy
  assert.throws(() => validateInvariants(b), /必须 </);
  const c = resolveConfig({ global_scan: { chunk_target_ratio: 0.5 } }); // chunk > normal
  assert.throws(() => validateInvariants(c), /必须 </);
});

test('组件上界之和超过 hard cap 时拒绝启动（§9.2）', () => {
  const cfg = resolveConfig({ ratios: { context_components: { current_artifact_max: 0.3 } } });
  assert.throws(() => validateInvariants(cfg), /组件上界之和/);
});

test('episode 区间矛盾时拒绝启动（§6.1）', () => {
  const cfg = resolveConfig({ episode: { raw_bounds: { target: [90000, 100000] } } });
  assert.throws(() => validateInvariants(cfg), /raw_bounds/);
});

test('hard_input_cap 超过实测可服务比例时拒绝启动（§19.1 不变量 6）', () => {
  const cfg = resolveConfig({});
  assert.throws(() => validateInvariants(cfg, { measuredMaxRatio: 0.5 }), /实测可服务上限/);
});

test('W=262144 下派生预算与规范 §9.1 参考值一致', () => {
  const cfg = resolveConfig({});
  const b = deriveBudgets(cfg, W);
  assert.equal(b.normalTargetInput, Math.floor(0.458 * W)); // 120062
  assert.equal(b.heavyTargetInput, Math.floor(0.5 * W)); // 131072
  assert.equal(b.hardInputCap, Math.floor(0.55 * W)); // 144179
  assert.equal(b.chunkTarget, Math.floor(0.305 * W)); // 79954
  assert.equal(b.orderingOk, true);
});

test('hard cap 取两条约束中较紧的一条（§9.6）', () => {
  const cfg = resolveConfig({});
  const b = deriveBudgets(cfg, W);
  const byPreflight = Math.floor(W / 1.693 - cfg.output.default_max_output_tokens);
  const byDeclared = Math.floor(W - cfg.output.default_max_output_tokens - 0.1 * W);
  assert.equal(b.hardInputCap, Math.min(Math.floor(0.55 * W), byPreflight, byDeclared));
  // 实测下预检约束更紧
  assert.ok(byPreflight < byDeclared);
});

test('episode 尺寸带保真度区间，窗口变大时不线性外推（§6.1）', () => {
  const cfg = resolveConfig({});
  const small = deriveBudgets(cfg, W).episode;
  assert.equal(small.targetRaw, Math.floor(0.153 * W)); // 40108
  assert.equal(small.minRaw, Math.floor(0.076 * W)); // 19922
  assert.equal(small.maxRaw, Math.floor(0.229 * W)); // 60030

  const big = deriveBudgets(cfg, 1048576).episode;
  assert.equal(big.targetRaw, 64000, '大窗口下应被保真度上界截住');
  assert.equal(big.minRaw, 32000);
  assert.equal(big.maxRaw, 80000);
  // 关键性质：不随 W 线性外推
  assert.ok(big.targetRaw < 0.153 * 1048576);
});

test('§9.6 两条硬断言：临界值行为', () => {
  const cfg = resolveConfig({});
  const b = deriveBudgets(cfg, W);

  // 140k 真实 token：预检 237020 <= 0.98W，且 <= hard cap
  assert.deepEqual(assertCompileFits(b, { estimatedInput: 140000, requestedMaxTokens: 4096 }), { ok: true });

  // 152k：预检 1.693*152000 = 257336 > 0.98W(256901) —— 约束②（实际约束）失败
  assert.throws(
    () => assertCompileFits(b, { estimatedInput: 152000, requestedMaxTokens: 4096 }),
    /约束②/,
  );

  // 超出 hard cap 也失败
  assert.throws(
    () => assertCompileFits(b, { estimatedInput: 147000, requestedMaxTokens: 4096 }),
    /hard_input_cap/,
  );

  // 约束①：请求超大输出会挤爆信封。
  // 注意：deriveBudgets 在结构上已保证 hard cap <= 0.9W - outputReserve，
  // 故约束①只能由"调用方传入过大 maxTokens"触发，不能由配置构造出来。
  assert.throws(
    () => assertCompileFits(b, { estimatedInput: 100000, requestedMaxTokens: 200000 }),
    /约束①/,
  );
});

test('不可满足的配置组合被偏序检查拦下（而非产出坏预算）', () => {
  // heavy 比例高于预检允许的 hard cap：派生后偏序必破，应在派生期即报错
  const cfg = resolveConfig({ ratios: { heavy_target_input: 0.9, hard_input_cap: 0.95 } });
  assert.throws(() => deriveBudgets(cfg, W), /偏序被破坏/);
});

test('W 非法时直接报错，不静默取默认值', () => {
  const cfg = resolveConfig({});
  assert.throws(() => deriveBudgets(cfg, 0), /正的 W/);
  assert.throws(() => deriveBudgets(cfg, NaN), /正的 W/);
});

test('未知配置项不致静默通过（保留显式拒绝能力）', () => {
  assert.throws(() => resolveConfig({ posture: 'x' }), /未知配置项/);
});

// ---------------- 配置键访问守卫 ----------------
//
// 真机教训：`maxTokensFor('episode_summary')` 读的是 `output.episode_summary_hard_max_tokens`，
// 而配置里的键叫 `episode.summary_hard_max_tokens` —— 读了一个**不存在的键**，
// 拿到 undefined 一路传下去，摘要调用的输出上限静默变成宿主的默认值。
// 这类错误在任何"跑得通"的测试里都不会暴露，只有把代码里的键与 DEFAULTS 对表才能发现。
// 做法与窗口头那条守卫一致：先认出"哪个变量是哪个配置段"，再只查该变量上的直接键访问。

function configKeyViolations(code) {
  const sections = new Set(Object.keys(DEFAULTS));
  const bad = [];
  for (const m of code.matchAll(/\b(?:this\.)?config\.([a-z_]+)\.([a-z_]+)\b/g)) {
    const [, sec, key] = m;
    if (!sections.has(sec)) bad.push(`${sec}（段不存在）`);
    else if (!(key in DEFAULTS[sec])) bad.push(`${sec}.${key}`);
  }
  // 别名：const o = this.config.output（或二级 const c = config.ratios.context_components）
  // → 之后 o.<key> / c.<key> 都必须存在于**该层**对象里
  const aliases = new Map();
  for (const m of code.matchAll(
    /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:this\.)?config\.([a-z_]+)(?:\.([a-z_]+))?\b/g,
  )) {
    const scope = m[3] ? DEFAULTS[m[2]]?.[m[3]] : DEFAULTS[m[2]];
    aliases.set(m[1], { path: m[3] ? `${m[2]}.${m[3]}` : m[2], scope });
  }
  for (const [v, { path: scopePath, scope }] of aliases) {
    if (!scope || typeof scope !== 'object') continue;
    // 注意：模板字符串里的 `\b` 是**退格字符**而不是词边界，必须写 `\\b`；
    // 否则这条检查永远匹配不到任何东西 —— 一个"看着在查、其实永远通过"的守卫。
    // （本条由阳性对照抓出：主断言全绿，而植入的错键名却没被报出。）
    const re = new RegExp(`\\b${v}\\.([a-z_]+)\\b`, 'g');
    for (const m of code.matchAll(re)) {
      if (!(m[1] in scope)) bad.push(`${scopePath}.${m[1]}（经别名 ${v}）`);
    }
  }
  return bad;
}

test('配置键访问守卫：代码里读的每个配置键都必须在 DEFAULTS 中存在', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) files.push(p);
    }
  };
  walk('lib');

  const violations = [];
  for (const f of files) {
    const code = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    const bad = configKeyViolations(code);
    if (bad.length) violations.push(`${f}: ${[...new Set(bad)].join(', ')}`);
  }
  assert.deepEqual(violations, [], `读到了 DEFAULTS 中不存在的配置键：\n${violations.join('\n')}`);

  // 阳性对照：守卫必须能抓到"键名写错"这一形态
  const planted = configKeyViolations('const o = this.config.output; return o.episode_summary_hard_max_tokens;');
  assert.ok(planted.some((x) => x.includes('episode_summary_hard_max_tokens')), '守卫必须能抓到不存在的键');
});
