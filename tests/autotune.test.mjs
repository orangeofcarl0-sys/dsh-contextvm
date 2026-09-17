/**
 * Phase D 补全审计：benchmark auto tuning（§17.2 / §25 / §26 Phase D）。
 *
 * 关键纪律：推荐值 MUST 以**比例**写回；hard cap MUST 受实测可服务上限夹取。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveOverrides, renderOverrideYaml, assertOverridesCompatible } from '../lib/benchmark/autotune.js';
import { resolveConfig } from '../lib/app/config.js';

const goodReport = {
  model: 'stealth/union-alpha',
  context_window: 262144,
  prefill_tests: [{ ratio_of_W: 0.244, ttft_ms: 27300 }, { ratio_of_W: 0.488, ttft_ms: 32800 }],
  decode_tps: { samples: 6, min: 4.83, median: 9.86, max: 12.51 },
  concurrency_tests: [{ concurrency: 1, aggregate_tps: 4.03 }, { concurrency: 2, aggregate_tps: 15.87 }, { concurrency: 4, aggregate_tps: 27.9 }],
  recommended_ratios: {
    normal_target_input: 0.458, heavy_target_input: 0.5, hard_input_cap: 0.55, global_chunk_target: 0.305,
    evidence: { rule: '§17.2' },
  },
  recommended_absolute: {
    max_concurrency: 4, global_worker_output_max_tokens: 300, episode_raw_ceiling: [64000, 32000, 80000],
  },
  preflight_calibration: { gatekeeper_over_real_ratio: 1.693, observed_max_servable_ratio_of_W: 0.5601 },
};

test('自动调参：比例形式写回，且绝对值只接受显式建议（§17.2 / §25）', () => {
  const o = deriveOverrides(goodReport);
  assert.equal(o.ratios.normal_target_input, 0.458);
  assert.equal(o.ratios.heavy_target_input, 0.5);
  assert.equal(o.ratios.preflight_ratio_assumed, 1.693);
  assert.equal(o.absolute.max_concurrency, 4);
  assert.deepEqual(o.absolute.episode_raw_ceiling, [64000, 32000, 80000]);
  // 不得出现绝对 token 数形式的输入侧预算
  for (const k of Object.keys(o.ratios)) {
    assert.ok(k !== 'normal_target_input_tokens', '输入侧预算不得以绝对 token 形式写回');
    if (k === 'preflight_ratio_assumed') {
      assert.ok(o.ratios[k] >= 1, '预检系数是倍数，应 >= 1');
    } else {
      assert.ok(o.ratios[k] < 1, `${k} 应 < 1`);
    }
  }
});

test('自动调参：hard cap 被实测可服务上限夹取（§9.1.1）', () => {
  const inflated = {
    ...goodReport,
    recommended_ratios: { ...goodReport.recommended_ratios, hard_input_cap: 0.9 },
  };
  const o = deriveOverrides(inflated);
  // 0.5601 * 0.98 = 0.5489 → 取两位小数 0.55（与配置同值）
  assert.equal(o.ratios.hard_input_cap, 0.55);
  assert.ok(o.notes.some((n) => n.includes('夹取')), '必须记录夹取原因');
  // heavy 必须仍严格小于 hard
  assert.ok(o.ratios.heavy_target_input < o.ratios.hard_input_cap);
});

test('自动调参：上限被压紧时，§9.2 组件缩放与 normal 下调必须一并传导', () => {
  const cfg = resolveConfig({});
  const c = cfg.ratios.context_components;
  const componentSum =
    c.system_protocol[1] + c.authoritative_state_max + c.recent_verbatim[1] +
    c.episode_navigator_max + c.retrieved_evidence[1] + c.current_artifact_max;
  assert.equal(componentSum, 0.55);

  // 实测可服务仅 0.50 → 夹取后 cap = 0.49，低于组件上界之和，且低于 normal 0.458 之上所需的 heavy
  const o = deriveOverrides(
    {
      ...goodReport,
      preflight_calibration: { gatekeeper_over_real_ratio: 1.7, observed_max_servable_ratio_of_W: 0.5 },
    },
    { config: cfg },
  );
  assert.equal(o.ratios.hard_input_cap, 0.49);
  assert.ok(o.ratios.hard_input_cap < componentSum, '前置：夹取后 hard cap 低于组件上界之和');
  assert.ok(isPos(o.ratios.component_scale), '必须给出组件缩放系数');
  assert.ok(o.ratios.component_scale * componentSum <= o.ratios.hard_input_cap + 1e-6, '缩放后应满足 §9.2');
  // normal 也必须跟着下调，否则 normal < heavy 偏序会破
  assert.ok(o.ratios.normal_target_input < o.ratios.heavy_target_input, 'normal 必须仍小于 heavy');
  assert.ok(o.ratios.normal_target_input > cfg.global_scan.chunk_target_ratio, 'normal 必须仍大于 chunk 比例');
  assert.ok(o.notes.some((n) => n.includes('§9.2')));
});

const isPos = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;

test('自动调参：报告缺少实测上限时明确说明不夹取（不假装安全）', () => {
  const noMeasured = { ...goodReport, preflight_calibration: { gatekeeper_over_real_ratio: 1.7 } };
  const o = deriveOverrides(noMeasured);
  assert.ok(o.notes.some((n) => n.includes('缺少实测可服务上限')));
  assert.equal(o.ratios.hard_input_cap, 0.55, '沿用原值而非臆测');
});

test('自动调参：不产生任何覆盖时给出说明而非静默空结果', () => {
  const o = deriveOverrides({});
  assert.deepEqual(o.ratios, {});
  assert.equal(o.applied.length, 0);
  assert.ok(o.notes.some((n) => n.includes('未包含可用的推荐值')));
  const o2 = deriveOverrides(null);
  assert.ok(o2.notes.some((n) => n.includes('报告为空')));
});

test('自动调参：覆盖后必须仍满足 §9.1/§9.2 不变量，否则抛错', () => {
  const cfg = resolveConfig({});
  // 相容的覆盖
  assert.equal(assertOverridesCompatible({ ratios: { heavy_target_input: 0.52 } }, cfg), true);

  // 破坏偏序：normal >= heavy
  assert.throws(
    () => assertOverridesCompatible({ ratios: { normal_target_input: 0.6 } }, cfg),
    /偏序/,
  );
  // 破坏组件上界之和：把 hard cap 压到低于组件和
  assert.throws(
    () => assertOverridesCompatible({ ratios: { hard_input_cap: 0.3, heavy_target_input: 0.2 } }, cfg),
    /组件上界之和|偏序/,
  );
});

test('自动调参：渲染出的 YAML 片段标注原值，便于人工核对', () => {
  const cfg = resolveConfig({});
  const o = deriveOverrides({ ...goodReport, recommended_ratios: { ...goodReport.recommended_ratios, heavy_target_input: 0.52 } });
  const yml = renderOverrideYaml(o, cfg);
  assert.ok(yml.includes('ratios:'));
  assert.ok(yml.includes('heavy_target_input: 0.52'));
  assert.ok(yml.includes('原值 0.5'), '被改动的项应标注原值');
  assert.ok(yml.includes('absolute:'));
});

test('自动调参 → 配置往返：给定当前配置时产出的覆盖必然相容（§9.1/§9.2）', async () => {
  const { validateInvariants, resolveConfig: resolve } = await import('../lib/app/config.js');
  const cfg = resolve({});
  // 实测可服务仅 0.50：夹取把 cap 压到 0.49，进而要求组件缩放与 normal 下调
  const o = deriveOverrides(
    {
      ...goodReport,
      preflight_calibration: { gatekeeper_over_real_ratio: 1.7, observed_max_servable_ratio_of_W: 0.5 },
    },
    { config: cfg },
  );
  assert.ok(isPos(o.ratios.component_scale), '应自动给出组件缩放以恢复 §9.2');

  const scale = o.ratios.component_scale;
  const scaledComponents = Object.fromEntries(
    Object.entries(cfg.ratios.context_components).map(([k, v]) => [
      k,
      Array.isArray(v) ? [v[0] * scale, v[1] * scale] : v * scale,
    ]),
  );
  const merged = resolve({
    ratios: {
      ...o.ratios,
      context_components: scaledComponents,
      component_scale: undefined,
    },
    global_scan: { max_concurrency: o.absolute.max_concurrency },
  });
  assert.equal(validateInvariants(merged), true, '往返后必须通过全部不变量');
  assert.equal(merged.global_scan.max_concurrency, 4);
});
