// ContextVM §2.3 基准测试：TTFT / decode TPS / 并发 / 输出长度 / token 估算校准
//
// 产出 benchmark_report.json（规范 §25）。目标模型 OpenRouter stealth/union-alpha。
//
// 用法：
//   node benchmark/api-bench.mjs                      # 全部阶段
//   node benchmark/api-bench.mjs --phases=prefill     # 只跑指定阶段，结果合并进已有报告
//   node benchmark/api-bench.mjs --extended           # 追加 1024/2048 输出与 0.732W prefill
//
// 设计约束（对应规范条文）：
//  - §2.1.1 TPS 方差极大 → 每档多样本，报告分位数而非单值。
//  - §25 estimator_calibration 按语种分别记录 → CJK 与 ASCII 分别采样。
//  - §25 推荐值以比例形式存储 → prefill 档位按 W 的比例定义。
//  - §22 故障恢复 → 每阶段结束即落盘，单阶段失败不丢已完成结果。
//
// 方法学注意（v1 实现踩过的坑，已修正）：
//  1) 填充文本若为重复句，BPE 会显著压缩，实测 6.35 字符/token（预期 3.55），
//     导致 prefill 档位整体打偏。故填充文本用伪随机词序（无长重复子串），
//     并做自适应尺寸校准：迭代调整字符数直到实际 token 数落在目标 ±8%。
//  2) 该模型的流式增量不保证出现在 delta.content，故 TTFT 取任意非空
//     delta 字段（content/reasoning）的首次到达时间，并记录来源字段。
//  3) 密钥只从 .credentials.yaml 读取，不落盘、不打印。

import fs from 'node:fs';
import path from 'node:path';
import {
  loadCredential, genFiller, pct, round, W, OPENROUTER_ENDPOINT as ENDPOINT,
  OPENROUTER_MODEL as MODEL, REQ_TIMEOUT_MS,
} from './shared/fixtures.mjs';

const OUT = path.resolve(import.meta.dirname, 'benchmark_report.json');
const EXTENDED = process.argv.includes('--extended');
const phaseArg = process.argv.find(a => a.startsWith('--phases='));
const PHASES = phaseArg ? phaseArg.slice(9).split(',') : ['calib', 'tps', 'prefill', 'concurrency'];
const want = (p) => PHASES.includes(p);

const KEY = loadCredential('OPENROUTER_API_KEY');

// 已有报告（支持分阶段续跑）
let report = { model: MODEL, context_window: W, benchmark_version: 2, phases_run: [] };
if (fs.existsSync(OUT)) {
  try { report = JSON.parse(fs.readFileSync(OUT, 'utf8')); report.phases_run = report.phases_run || []; } catch { /* start fresh */ }
}
report.measured_at = new Date().toISOString();
report.partial_run = !EXTENDED;
const errors = [];
let requests = 0;
const save = () => fs.writeFileSync(OUT, JSON.stringify(report, null, 2), 'utf8');
const log = (...a) => { console.log(...a); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** 发一次请求。stream=true 时测 TTFT（取任意非空 delta 字段）。 */
async function call({ messages, maxTokens = 64, stream = false, temperature = 0 }) {
  requests++;
  const t0 = Date.now();
  let ttft = null, ttftField = null, text = '', usage = null, err = null, status = null;
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ model: MODEL, messages, max_tokens: maxTokens, temperature, stream }),
      signal: AbortSignal.timeout(REQ_TIMEOUT_MS),
    });
    status = res.status;
    if (!stream) {
      const j = await res.json();
      if (j.error) err = `http${status} ${j.error.code} ${j.error.metadata?.error_type || ''}`;
      else { usage = j.usage; text = String(j.choices?.[0]?.message?.content ?? ''); ttft = Date.now() - t0; ttftField = 'non-stream'; }
    } else if (!res.ok) {
      err = `http${status}`;
    } else {
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') continue;
          let ev; try { ev = JSON.parse(payload); } catch { continue; }
          if (ev.error) { err = `stream ${ev.error.code} ${ev.error.metadata?.error_type || ''}`; continue; }
          if (ev.usage) usage = ev.usage;
          const d = ev.choices?.[0]?.delta;
          if (!d) continue;
          for (const f of ['content', 'reasoning', 'reasoning_content']) {
            if (typeof d[f] === 'string' && d[f].length > 0) {
              if (ttft === null) { ttft = Date.now() - t0; ttftField = f; }
              if (f === 'content') text += d[f];
              break;
            }
          }
        }
      }
    }
  } catch (e) { err = 'fetch:' + e.name; }
  const total = Date.now() - t0;
  if (err) errors.push({ err, status });
  return { ttft_ms: ttft, ttft_field: ttftField, total_ms: total, text, usage, err, status };
}



const INITIAL_CPT = 4.0;
/** 自适应校准：迭代调整字符数，使实际 prompt_tokens 落在目标 ±8%。末次调用同时提供 TTFT。 */
async function measurePrefill(targetTokens) {
  let chars = Math.round(targetTokens * INITIAL_CPT);
  let last = null;
  for (let i = 1; i <= 3; i++) {
    const filler = genFiller(chars);
    const r = await call({
      messages: [{ role: 'user', content: filler + '\n\nReply with the single word: ok' }],
      maxTokens: 16, stream: true,
    });
    if (r.err || !r.usage?.prompt_tokens) {
      return { target_tokens: targetTokens, chars, iteration: i, error: r.err ?? 'no usage', status: r.status, total_ms: r.total_ms };
    }
    const actual = r.usage.prompt_tokens;
    last = {
      target_tokens: targetTokens, chars, iteration: i,
      actual_prompt_tokens: actual,
      actual_chars_per_token: round(filler.length / actual, 3),
      deviation: round(actual / targetTokens - 1, 4),
      ttft_ms: r.ttft_ms, ttft_field: r.ttft_field,
      total_ms: r.total_ms, status: r.status, error: null,
    };
    log(`    iter${i}: chars=${chars} actual_tokens=${actual} (目标 ${targetTokens}, 偏差 ${(last.deviation * 100).toFixed(1)}%) ` +
        `TTFT=${r.ttft_ms ? (r.ttft_ms / 1000).toFixed(1) + 's@' + r.ttft_field : 'n/a'} total=${(r.total_ms / 1000).toFixed(1)}s`);
    if (Math.abs(last.deviation) <= 0.08) break;
    chars = Math.round(chars / (actual / targetTokens));
    await sleep(1500);
  }
  return last;
}

// ------------------------------------------------------------------ 阶段 0：估算校准
if (want('calib')) {
  log('\n########## 阶段 0：token 估算校准（§25 按语种） ##########');
  const asciiUnit = 'The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs. ';
  const cjkUnit = '上下文虚拟化系统需要在低吞吐量的免费模型上维持长期任务的连续性，因此必须显式保存状态而不是依赖隐藏的推理链。';
  const samples = { ascii: [], cjk: [] };
  for (let i = 0; i < 6; i++) {
    for (const [lang, unit, reps] of [['ascii', asciiUnit, 4], ['cjk', cjkUnit, 6]]) {
      const s = unit.repeat(reps);
      const r = await call({ messages: [{ role: 'user', content: s }], maxTokens: 4 });
      if (r.usage?.prompt_tokens) samples[lang].push({ chars: s.length, tokens: r.usage.prompt_tokens, cpt: s.length / r.usage.prompt_tokens });
    }
  }
  const calib = {};
  for (const lang of ['ascii', 'cjk']) {
    const cpts = samples[lang].map(x => x.cpt);
    calib[lang] = {
      samples: samples[lang].length,
      chars_per_token_median: round(pct(cpts, 50)),
      chars_per_token_min: round(Math.min(...cpts)),
      chars_per_token_max: round(Math.max(...cpts)),
      naive_chars_div_4_underestimate_ratio: round((1 / pct(cpts, 50)) / 0.25),
    };
    log(` ${lang}: chars/token median=${calib[lang].chars_per_token_median} range=[${calib[lang].chars_per_token_min}, ${calib[lang].chars_per_token_max}] n=${calib[lang].samples}`);
    log(`   chars/4 相对实际 token 数的低估倍数 = ${calib[lang].naive_chars_div_4_underestimate_ratio}`);
  }
  // 推荐余量：以最坏语种下 chars/4 的低估幅度为准（含 8% 安全边界），上限 0.5
  const worst = Math.max(calib.ascii.naive_chars_div_4_underestimate_ratio, calib.cjk.naive_chars_div_4_underestimate_ratio);
  calib.recommended_estimator_margin = round(Math.min(0.5, (worst - 1) + 0.08));
  calib.note = 'chars/token 含 role 模板开销。margin 为"chars/4 输入下避免溢出所需的最小余量"，' +
    '生产实现应改用宿主 tokenMeter + 语种系数并在线滚动校准（§9.6），不应依赖本余量。';
  report.estimator_calibration = calib;
  report._ascii_cpt = calib.ascii.chars_per_token_median;
  log(` 推荐 estimator_margin（chars/4 输入下）= ${calib.recommended_estimator_margin}`);
  if (!report.phases_run.includes('calib')) report.phases_run.push('calib');
  save();
}

// ------------------------------------------------------------------ 阶段 1：输出长度 / decode TPS
if (want('tps')) {
  log('\n########## 阶段 1：输出长度与 decode TPS（§2.3） ##########');
  const langs = [128, 256, 512];
  if (EXTENDED) langs.push(1024, 2048);
  const tests = [];
  for (const mt of langs) {
    const reps = mt >= 1024 ? 1 : 2;
    const tps = [];
    for (let i = 0; i < reps; i++) {
      const r = await call({
        messages: [{ role: 'user', content: 'Count upward from 1, one number per line, no commentary. Keep going.' }],
        maxTokens: mt,
      });
      if (r.err) { log(`  max_tokens=${mt} try${i + 1}: ERR ${r.err}`); continue; }
      const ct = r.usage?.completion_tokens ?? 0;
      const t = ct / (r.total_ms / 1000);
      tps.push(t);
      log(`  max_tokens=${mt} try${i + 1}: out=${ct} total=${(r.total_ms / 1000).toFixed(1)}s tps=${t.toFixed(2)}`);
    }
    if (tps.length) tests.push({ max_tokens: mt, samples: tps.length, tps_median: round(pct(tps, 50)), tps_min: round(Math.min(...tps)), tps_max: round(Math.max(...tps)) });
  }
  report.output_length_tests = tests;
  const all = tests.flatMap(t => [t.tps_min, t.tps_median, t.tps_max]);
  report.decode_tps = { samples: tests.reduce((a, t) => a + t.samples, 0), min: round(Math.min(...all)), median: round(pct(all, 50)), max: round(Math.max(...all)) };
  log(` decode TPS: min=${report.decode_tps.min} median=${report.decode_tps.median} max=${report.decode_tps.max}`);
  if (!report.phases_run.includes('tps')) report.phases_run.push('tps');
  save();
}

// ------------------------------------------------------------------ 阶段 2：prefill / TTFT
if (want('prefill')) {
  log('\n########## 阶段 2：prefill / TTFT（比例档位，自适应校准尺寸） ##########');
  const ratios = [0.031, 0.122, 0.244, 0.488];
  if (EXTENDED) ratios.push(0.732);
  const out = [];
  for (const ratio of ratios) {
    const target = Math.round(ratio * W);
    log(`  ${(ratio * 100).toFixed(1)}%W -> 目标 ${target} tokens`);
    const r = await measurePrefill(target);
    out.push({ ratio_of_W: ratio, ...r });
    if (r.error) log(`    !! ${r.error}`);
    await sleep(2000);
  }
  report.prefill_tests = out;
  if (!report.phases_run.includes('prefill')) report.phases_run.push('prefill');
  save();
}

// ------------------------------------------------------------------ 阶段 3：并发
if (want('concurrency')) {
  log('\n########## 阶段 3：并发（§2.3） ##########');
  const out = [];
  for (const n of [1, 2, 4]) {
    const t0 = Date.now();
    const rs = await Promise.all(Array.from({ length: n }, () =>
      call({ messages: [{ role: 'user', content: 'Write the numbers 1 to 20 separated by spaces.' }], maxTokens: 96 })));
    const wall = (Date.now() - t0) / 1000;
    const ok = rs.filter(r => !r.err);
    const tok = ok.reduce((a, r) => a + (r.usage?.completion_tokens ?? 0), 0);
    const e = {
      concurrency: n, wall_s: round(wall, 2), succeeded: ok.length, failed: n - ok.length,
      total_output_tokens: tok, aggregate_tps: round(tok / wall),
      per_request_latency_s: rs.map(r => round(r.total_ms / 1000, 1)),
      errors: rs.filter(r => r.err).map(r => r.err),
    };
    out.push(e);
    log(`  n=${n}: wall=${e.wall_s}s ok=${e.succeeded}/${n} agg_tps=${e.aggregate_tps} lat=[${e.per_request_latency_s}]`);
    await sleep(3000);
  }
  report.concurrency_tests = out;
  if (!report.phases_run.includes('concurrency')) report.phases_run.push('concurrency');
  save();
}

// ------------------------------------------------------------------ 推荐值（比例形式，§25）
{
  const medTps = report.decode_tps?.median || 2;
  const ttft = (report.prefill_tests || []).filter(p => p.ttft_ms).map(p => ({ r: p.ratio_of_W, ms: p.ttft_ms }));
  const at = (r) => { const f = ttft.find(x => x.r === r); return f ? f.ms : null; };
  let normal = 0.458, heavy = 0.649, rule = '文档默认（TTFT 数据不足，§17.2 策略未触发）';
  const t64 = at(0.244), t128 = at(0.488), t192 = at(0.732);
  if (t64 && t128) {
    normal = t128 <= 1.5 * t64 ? 0.49 : 0.37;
    rule = t128 <= 1.5 * t64 ? 'TTFT(0.49W) <= 1.5*TTFT(0.24W) -> 0.49' : 'TTFT 增长过快 -> 0.37';
  }
  if (t192) heavy = 0.73; else if (t128) heavy = 0.53;
  report.recommended_ratios = {
    normal_target_input: normal, heavy_target_input: heavy,
    hard_input_cap: 0.782, global_chunk_target: 0.305,
    evidence: { ttft_sweep: ttft.map(x => ({ ratio: x.r, ttft_s: round(x.ms / 1000, 1) })), rule },
  };
  const conc = (report.concurrency_tests || []).filter(c => c.aggregate_tps);
  let best = 1, bestTps = 0;
  for (const c of conc) if (c.aggregate_tps >= bestTps * 0.98) { bestTps = Math.max(bestTps, c.aggregate_tps); best = c.concurrency; }
  report.recommended_absolute = {
    max_concurrency: conc.length ? best : 8,
    default_max_output_tokens: 4096,
    global_worker_output_max_tokens: medTps < 5 ? 300 : 500,
    episode_raw_ceiling: [64000, 32000, 80000],
    note: '输出上限由 TPS 决定，不随 W 缩放（§17.1）。并发上限仅覆盖到 4，更高并发未测。',
  };
  delete report._ascii_cpt;
  report.error_rate = { requests, phase_errors: errors.length, rate: round(errors.length / Math.max(1, requests), 4), samples: errors.slice(0, 20) };
  save();
}

log(`\n########## 完成（phases: ${report.phases_run.join(',')}）##########`);
log(`requests=${requests} errors=${errors.length} -> ${OUT}`);
log(`ratios: normal=${report.recommended_ratios.normal_target_input} heavy=${report.recommended_ratios.heavy_target_input}`);
log(`max_concurrency=${report.recommended_absolute.max_concurrency} decode_tps.median=${report.decode_tps?.median}`);
