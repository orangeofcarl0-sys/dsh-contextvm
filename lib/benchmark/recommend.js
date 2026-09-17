/**
 * 从实测阶段数据推导推荐参数（§2.3 / §17.2 / §25）。
 *
 * **唯一实现**：`benchmark/api-bench.mjs` 在跑完各阶段后调用它，
 * `benchmark/rebuild-report.mjs` 在合并预检标定后也调用它。MUST NOT 各写一份推导。
 *
 * 纪律（§25）：
 *   - 推荐值以**比例**形式给出（绝对值随路由失效，比例不会）；
 *   - hard cap MUST 受实测可服务上限夹取（§9.1.1）；
 *   - 输出上限由 TPS 决定，MUST NOT 随 W 缩放（§17.1）。
 *
 * @module dsh-contextvm/benchmark/recommend
 */

const isPos = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;
const round = (v, d = 3) => (isPos(v) ? Number(v.toFixed(d)) : null);

/** 实测上限夹取的安全系数默认值。 */
export const DEFAULT_SAFETY = 0.98;

/**
 * 把某个输入侧比例夹取到"实测可服务上限 × 安全系数"以内。**唯一实现**：
 * `deriveRecommendations` 与 `lib/benchmark/autotune.js` 都用它，
 * 否则同一个 hard cap 会因取整精度不同而出现两个值（曾出现 0.5489 / 0.55 并存）。
 *
 * @param {number} ratio 期望采用的比例
 * @param {number|null} measuredRatio 实测可服务比例（§9.1.1）
 * @param {number} [safety]
 * @returns {{value: number, clamped: boolean, ceiling: number|null}}
 */
export function clampToMeasuredCeiling(ratio, measuredRatio, safety = DEFAULT_SAFETY) {
  if (!isPos(measuredRatio)) return { value: ratio, clamped: false, ceiling: null };
  const ceiling = Number((measuredRatio * safety).toFixed(2));
  if (!isPos(ratio) || ratio <= ceiling) return { value: ratio, clamped: false, ceiling };
  return { value: ceiling, clamped: true, ceiling };
}

/**
 * @param {{
 *   decode_tps?: {median?: number},
 *   prefill_tests?: Array<{ratio_of_W: number, ttft_ms?: number|null}>,
 *   concurrency_tests?: Array<{concurrency: number, aggregate_tps?: number}>,
 *   preflight_calibration?: {gatekeeper_over_real_ratio?: number, observed_max_servable_ratio_of_W?: number},
 * }} input
 * @param {{safety?: number, componentSum?: number}} [opts]
 * @returns {{recommended_ratios: object, recommended_absolute: object, notes: string[]}}
 */
export function deriveRecommendations(input = {}, opts = {}) {
  const notes = [];
  const ttft = (input.prefill_tests ?? [])
    .filter((p) => isPos(p.ttft_ms))
    .map((p) => ({ r: p.ratio_of_W, ms: p.ttft_ms }));
  const at = (r) => ttft.find((x) => x.r === r)?.ms ?? null;

  // ---- §17.2：按 TTFT 增长曲线选 normal ----
  let normal = 0.458;
  let rule = '保留文档基线的 normal（TTFT 数据不足，§17.2 策略未触发）';
  const t64 = at(0.244);
  const t128 = at(0.488);
  if (t64 && t128) {
    if (t128 <= 1.5 * t64) {
      normal = 0.458;
      rule = 'TTFT(0.488W) <= 1.5×TTFT(0.244W) → 保持 0.458';
    } else {
      normal = 0.37;
      rule = 'TTFT 增长过快 → 降到 0.37';
    }
  }
  notes.push(rule);

  // ---- heavy：以预检上限为界，取安全的一半余量 ----
  const pf = input.preflight_calibration ?? {};
  const measured = opts.measuredMaxServableRatio ?? pf.observed_max_servable_ratio_of_W ?? null;
  const gateRatio = pf.gatekeeper_over_real_ratio ?? 1.693;

  let hardCap = 0.55;
  let heavy = 0.5;
  if (isPos(measured)) {
    const safety = opts.safety ?? DEFAULT_SAFETY;
    // 经唯一的夹取实现取整到两位小数：让报告推荐值与配置取值**是同一个数**
    hardCap = clampToMeasuredCeiling(1, measured, safety).ceiling;
    heavy = Math.min(0.5, Number((hardCap * 0.9).toFixed(2)));
    notes.push(
      `实测可服务 ${measured} → hard cap = ${hardCap}（× 安全系数 ${safety}，§9.1.1）；heavy 取 hard 的 0.9 以维持偏序（§9.1）`,
    );
    // §9.2：组件上界之和不得反超 hard cap
    const componentSum = opts.componentSum;
    if (isPos(componentSum) && componentSum > hardCap) {
      notes.push(
        `组件上界之和 ${componentSum} 超过 hard cap ${hardCap}：需按 ${(hardCap / componentSum).toFixed(4)} 等比缩放组件（§9.2，安全夹取优先）`,
      );
    }
  } else {
    notes.push('缺少实测可服务上限（§9.1.1）：hard cap 沿用文档基线并 MUST 在切换路由后重标');
  }

  // ---- 输出上限：由 TPS 决定，不随 W 缩放（§17.1） ----
  const medTps = input.decode_tps?.median ?? null;
  const workerCap = isPos(medTps) && medTps >= 5 ? 300 : 300; // §17.1 基线；TPS 低时不放宽
  if (isPos(medTps)) notes.push(`decode TPS 中位 ${medTps} → worker 输出上限保持 ${workerCap}（§17.1）`);

  // ---- 并发：取聚合吞吐不再显著增长的档位 ----
  const conc = (input.concurrency_tests ?? []).filter((c) => isPos(c.aggregate_tps));
  let maxConcurrency = 4;
  if (conc.length) {
    let best = 1;
    let bestTps = 0;
    for (const c of conc) {
      if (c.aggregate_tps >= bestTps * 0.98) {
        bestTps = Math.max(bestTps, c.aggregate_tps);
        best = c.concurrency;
      }
    }
    maxConcurrency = best;
    notes.push(`并发聚合吞吐在 n=${best} 达峰（${round(bestTps)} TPS）→ max_concurrency=${best}`);
  }

  return {
    recommended_ratios: {
      normal_target_input: normal,
      heavy_target_input: heavy,
      hard_input_cap: hardCap,
      global_chunk_target: 0.305,
      preflight_ratio_assumed: gateRatio,
    },
    recommended_absolute: {
      max_concurrency: maxConcurrency,
      global_worker_output_max_tokens: workerCap,
      episode_raw_ceiling: [64000, 32000, 80000],
    },
    notes,
  };
}
