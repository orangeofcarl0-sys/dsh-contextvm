/**
 * 基准结果 → 配置覆盖（§17.2 / §25 / §26 Phase D 的 benchmark auto tuning）。
 *
 * 纪律（§25 说明 1 / §17.2 末句）：**推荐值 MUST 以比例形式写回**，
 * MUST NOT 写回绝对 token 数 —— 绝对值随路由失效，比例不会。
 * 且 hard cap MUST 受实测可服务上限夹取（§9.1.1），不得因为基准报告里
 * 出现更大的数字就放宽。
 *
 * @module dsh-contextvm/benchmark/autotune
 */

import { clampToMeasuredCeiling, DEFAULT_SAFETY } from './recommend.js';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const isPos = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;

/** 偏序下界：chunk 比例必须小于 normal（§9.1）。 */
function overrides_chunkFloor(opts) {
  return opts.config?.global_scan?.chunk_target_ratio ?? 0.305;
}

/** §9.2 的组件上界之和。 */
function sumComponents(config) {
  const c = config.ratios.context_components;
  return (
    c.system_protocol[1] +
    c.authoritative_state_max +
    c.recent_verbatim[1] +
    c.episode_navigator_max +
    c.retrieved_evidence[1] +
    c.current_artifact_max
  );
}

/**
 * 从 `benchmark_report.json` 派生配置覆盖。
 *
 * @param {object} report §25 的报告（api-bench.mjs 的产物）
 * @param {{
 *   config?: object,           // 当前生效配置（resolveConfig 产物）。给出时本函数保证
 *                              // 返回值与 §9.1/§9.2 不变量相容（含组件缩放的自动补偿）。
 *   maxServableRatio?: number, // 实测可服务输入比例（§9.1.1）；缺省取报告中的值
 *   safety?: number,
 *   componentSum?: number,     // 显式指定组件上界之和（未给 config 时使用）
 * }} [opts]
 * @returns {{ratios: object, absolute: object, notes: string[], applied: string[]}}
 */
export function deriveOverrides(report, opts = {}) {
  const notes = [];
  const ratios = {};
  const absolute = {};
  const applied = [];

  if (!report || typeof report !== 'object') {
    return { ratios, absolute, notes: ['报告为空：不产生覆盖'], applied };
  }

  // ---- 输入侧比例：报告若已给出 recommended_ratios 则直接用（它已是比例形式）
  const rec = report.recommended_ratios ?? {};
  for (const key of ['normal_target_input', 'heavy_target_input', 'hard_input_cap', 'global_chunk_target']) {
    const v = rec[key];
    if (isPos(v) && v < 1) {
      ratios[key] = Number(v.toFixed(4));
      applied.push(`ratios.${key}`);
    }
  }

  // ---- 预检系数：从实测的 gatekeeper/real 比值取，仍按内容相关保留原值
  const pf = report.preflight_calibration?.gatekeeper_over_real_ratio;
  if (isPos(pf) && pf >= 1) {
    ratios.preflight_ratio_assumed = Number(pf.toFixed(4));
    applied.push('ratios.preflight_ratio_assumed');
  }

  // ---- §9.1.1：hard cap 必须被实测可服务上限夹取
  const measured =
    opts.maxServableRatio ??
    report.preflight_calibration?.observed_max_servable_ratio_of_W ??
    null;
  if (isPos(measured)) {
    const safety = opts.safety ?? DEFAULT_SAFETY;
    const cur = ratios.hard_input_cap;
    const { value, clamped, ceiling } = clampToMeasuredCeiling(cur, measured, safety);
    if (clamped) {
      ratios.hard_input_cap = value;
      notes.push(
        `hard_input_cap 由 ${cur} 夹取到 ${value}（实测可服务 ${measured} × 安全系数 ${safety}，§9.1.1）`,
      );
      applied.push('ratios.hard_input_cap(clamped)');
    }
    // heavy 必须严格小于 hard
    if (isPos(ratios.heavy_target_input) && ratios.heavy_target_input >= ratios.hard_input_cap) {
      const fixed = Number((ratios.hard_input_cap * 0.9).toFixed(3));
      notes.push(`heavy_target_input 由 ${ratios.heavy_target_input} 下调到 ${fixed} 以维持偏序（§9.1）`);
      ratios.heavy_target_input = fixed;
    }
    // 偏序必须**整条**成立：上限被压得很紧时，normal 也必须跟着下调，
    // 否则会产出"通过夹取但启动即失败"的配置（§9.1 偏序是启动期硬断言）。
    if (isPos(ratios.normal_target_input) && ratios.normal_target_input >= ratios.heavy_target_input) {
      const chunk = overrides_chunkFloor(opts);
      const fixed = Number(Math.max(chunk * 1.05, ratios.heavy_target_input * 0.9).toFixed(3));
      notes.push(
        `normal_target_input 由 ${ratios.normal_target_input} 下调到 ${fixed} ` +
          `以维持 normal < heavy 偏序（§9.1；上限夹取会向下传导）`,
      );
      ratios.normal_target_input = fixed;
    }
  } else {
    notes.push('报告缺少实测可服务上限：无法夹取 hard_input_cap，沿用原值（§9.1.1 要求在切换路由后重新标定）');
  }

  // ---- §9.2 一致性：夹取 hard cap 后，组件上界之和不得反超。
  // 两条都是 MUST；冲突时以安全优先（先服从 §9.1.1 的夹取），
  // 再把组件上界按比例缩放以恢复 §9.2 的不变量，并明确记录。
  const componentSum = opts.componentSum ?? (opts.config ? sumComponents(opts.config) : undefined);
  if (isPos(ratios.hard_input_cap) && componentSum !== undefined) {
    const sum = componentSum;
    if (sum > ratios.hard_input_cap) {
      const factor = Number((ratios.hard_input_cap / sum).toFixed(4));
      ratios.component_scale = factor;
      notes.push(
        `组件上界之和 ${sum} 超过夹取后的 hard cap ${ratios.hard_input_cap}；` +
          `按 ${factor} 等比缩放各组件上界以恢复 §9.2 不变量（hard cap 的安全夹取优先）`,
      );
      applied.push('ratios.component_scale');
    }
  }

  // ---- 输出侧与计数：绝对值，MUST NOT 随 W 缩放（§17.1），故只接受显式建议
  const abs = report.recommended_absolute ?? {};
  if (isPos(abs.max_concurrency)) {
    absolute.max_concurrency = Math.max(1, Math.min(16, Math.round(abs.max_concurrency)));
    applied.push('absolute.max_concurrency');
  }
  if (isPos(abs.global_worker_output_max_tokens)) {
    absolute.global_worker_output_max_tokens = Math.round(abs.global_worker_output_max_tokens);
    applied.push('absolute.global_worker_output_max_tokens');
  }
  if (Array.isArray(abs.episode_raw_ceiling) && abs.episode_raw_ceiling.length === 3 && abs.episode_raw_ceiling.every(isPos)) {
    absolute.episode_raw_ceiling = abs.episode_raw_ceiling.map((x) => Math.round(x));
    applied.push('absolute.episode_raw_ceiling');
  }

  if (applied.length === 0) notes.push('报告未包含可用的推荐值：不产生任何覆盖');
  return { ratios, absolute, notes, applied };
}

/**
 * 把覆盖渲染成可直接写入挂载配置的 YAML 片段（比例形式）。
 * @param {{ratios: object, absolute: object}} overrides
 * @param {object} [currentConfig] 当前生效配置，用于标注将被覆盖的项
 * @returns {string}
 */
export function renderOverrideYaml(overrides, currentConfig = {}) {
  const lines = ['# 由 benchmark 自动生成；请在核对后合入挂载配置', 'ratios:'];
  for (const [k, v] of Object.entries(overrides.ratios ?? {})) {
    const prev = currentConfig.ratios?.[k];
    lines.push(`  ${k}: ${v}${prev !== undefined && prev !== v ? `   # 原值 ${prev}` : ''}`);
  }
  if (Object.keys(overrides.absolute ?? {}).length) {
    lines.push('absolute:');
    for (const [k, v] of Object.entries(overrides.absolute)) {
      lines.push(`  ${k}: ${Array.isArray(v) ? `[${v.join(', ')}]` : v}`);
    }
  }
  return lines.join('\n');
}

/**
 * 校验一份覆盖是否与当前配置相容（偏序 + 组件上界），不相容则抛错。
 * 这样"自动调参"不可能把系统推入启动即失败的状态。
 *
 * @param {{ratios: object}} overrides
 * @param {object} config resolveConfig() 的产物
 */
export function assertOverridesCompatible(overrides, config) {
  const next = { ...config.ratios, ...(overrides.ratios ?? {}) };
  const chunk = overrides.ratios?.global_chunk_target ?? config.global_scan.chunk_target_ratio;
  if (!(chunk < next.normal_target_input)) throw new Error('覆盖后 chunk 比例不再小于 normal（§9.1 偏序）');
  if (!(next.normal_target_input < next.heavy_target_input)) throw new Error('覆盖后 normal 不再小于 heavy（§9.1 偏序）');
  if (!(next.heavy_target_input < next.hard_input_cap)) throw new Error('覆盖后 heavy 不再小于 hard cap（§9.1 偏序）');
  const c = config.ratios.context_components;
  const sum =
    c.system_protocol[1] + c.authoritative_state_max + c.recent_verbatim[1] +
    c.episode_navigator_max + c.retrieved_evidence[1] + c.current_artifact_max;
  if (sum > next.hard_input_cap + 1e-9) {
    throw new Error(`覆盖后组件上界之和(${sum.toFixed(3)}) 超过 hard cap(${next.hard_input_cap})（§9.2）`);
  }
  return true;
}

/** 供测试与调用方使用的一致性消抖。 */
export { clamp };
