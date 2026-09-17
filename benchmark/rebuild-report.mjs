/**
 * 合并预检标定并重建 benchmark_report.json 的推荐值。
 *
 * 背景：`api-bench.mjs` 与 `preflight-limit.mjs` 是两次独立运行，前者写
 * `benchmark_report.json`，后者写 `preflight-limit.json`。若不合并，报告里的
 * `recommended_ratios` 会停留在**未受预检夹取**的旧值，与规范 §9.1 采用的取值矛盾
 * ——读到报告的人会拿到已被推翻的数字。
 *
 * 本脚本只读已有实测数据、确定性重算，**不发起任何上游调用**。
 * 推导逻辑复用 lib/benchmark/recommend.js（与 api-bench 同一实现）。
 *
 * 用法：node benchmark/rebuild-report.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { deriveRecommendations } from '../lib/benchmark/recommend.js';
import { resolveConfig } from '../lib/app/config.js';

const dir = import.meta.dirname;
const reportPath = path.join(dir, 'benchmark_report.json');
const preflightPath = path.join(dir, 'preflight-limit.json');

if (!fs.existsSync(reportPath)) {
  console.error(`未找到 ${reportPath}：请先运行 node benchmark/api-bench.mjs`);
  process.exit(1);
}
const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));

// 合并预检标定（若存在）
let merged = false;
if (fs.existsSync(preflightPath)) {
  const pf = JSON.parse(fs.readFileSync(preflightPath, 'utf8'));
  report.preflight_calibration = {
    ...(report.preflight_calibration ?? {}),
    gatekeeper_over_real_ratio: pf.preflight_estimator_over_real_ratio ?? null,
    observed_max_servable_real_tokens: pf.observed_max_servable_real_tokens ?? null,
    observed_max_servable_ratio_of_W: pf.observed_max_servable_ratio_of_W ?? null,
    note: pf.interpretation ?? null,
  };
  merged = true;
}

// 组件上界之和取自当前配置（§9.2 的夹取补偿需要它）
const cfg = resolveConfig({});
const c = cfg.ratios.context_components;
const componentSum =
  c.system_protocol[1] + c.authoritative_state_max + c.recent_verbatim[1] +
  c.episode_navigator_max + c.retrieved_evidence[1] + c.current_artifact_max;

const rec = deriveRecommendations(report, { componentSum });
report.recommended_ratios = { ...rec.recommended_ratios, basis: '受 §9.1.1 网关预检夹取；见 preflight_calibration' };
report.recommended_absolute = rec.recommended_absolute;
report.derivation_notes = rec.notes;
report.rebuilt_at = new Date().toISOString();
report.rebuild_note = merged
  ? '已合并 preflight-limit.json 的预检标定并重算推荐比例（确定性，无上游调用）'
  : '未找到 preflight-limit.json：推荐比例未受预检夹取，请先运行 node benchmark/preflight-limit.mjs';

fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');

console.log(`已重建 ${path.relative(process.cwd(), reportPath)}`);
console.log(`  normal=${report.recommended_ratios.normal_target_input} heavy=${report.recommended_ratios.heavy_target_input} cap=${report.recommended_ratios.hard_input_cap}`);
console.log(`  max_concurrency=${report.recommended_absolute.max_concurrency}`);
if (report.preflight_calibration) {
  console.log(`  预检系数=${report.preflight_calibration.gatekeeper_over_real_ratio} 实测可服务=${report.preflight_calibration.observed_max_servable_ratio_of_W}`);
}
for (const n of rec.notes) console.log(`  · ${n}`);
if (!merged) {
  console.error('警告：未合并预检标定，推荐值可能与规范 §9.1 不一致');
  process.exit(2);
}
