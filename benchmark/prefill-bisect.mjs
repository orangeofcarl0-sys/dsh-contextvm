// 定位真实可服务输入上限：192k 稳定 400（校验拒绝，非服务不可用），
// 需查明边界与上游给出的原因，因为它决定 §9.1 的 heavy/hard 两档比例能否成立。
import fs from 'node:fs';
import path from 'node:path';
import { loadCredential, genFiller, W, OPENROUTER_ENDPOINT as ENDPOINT, OPENROUTER_MODEL as MODEL } from './shared/fixtures.mjs';

const KEY = loadCredential('OPENROUTER_API_KEY');

const CPT = 6.77;
async function probe(tokens) {
  const chars = Math.round(tokens * CPT);
  const t0 = Date.now();
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        model: MODEL, max_tokens: 8, temperature: 0, stream: false,
        messages: [{ role: 'user', content: genFiller(chars, 4242) + '\n\nReply with the single word: ok' }],
      }),
      signal: AbortSignal.timeout(600_000),
    });
    const txt = await res.text();
    let j = null; try { j = JSON.parse(txt); } catch { /* raw */ }
    const ms = Date.now() - t0;
    if (j?.error) {
      return { requested: tokens, status: res.status, ok: false, ms, message: j.error.message, raw: JSON.stringify(j.error.metadata ?? {}).slice(0, 300) };
    }
    return { requested: tokens, status: res.status, ok: true, ms, actual_prompt_tokens: j?.usage?.prompt_tokens ?? null };
  } catch (e) { return { requested: tokens, status: null, ok: false, ms: Date.now() - t0, message: 'fetch:' + e.name }; }
}

const out = { model: MODEL, context_window: W, measured_at: new Date().toISOString(), probes: [] };

// 1) 先取 192k 的完整报错正文（失败快）
console.log('=== 192k 报错正文（定位上游声明的原因） ===');
const e192 = await probe(191889);
out.probes.push(e192);
console.log(JSON.stringify(e192, null, 2));

// 2) 二分：128k 已知可服务，192k 已知拒，取中间
console.log('\n=== 二分定位边界 ===');
for (const t of [140000, 160000, 170000, 176000, 184000]) {
  const r = await probe(t);
  out.probes.push(r);
  console.log(`  ${String(t).padStart(6)} tokens: ${r.ok ? 'OK' : 'FAIL ' + r.status} actual=${r.actual_prompt_tokens ?? '-'} ${(r.ms / 1000).toFixed(1)}s ${r.message ? JSON.stringify(r.message).slice(0, 200) : ''}`);
  if (!r.ok && r.status === 400) { /* 继续测更小的 */ }
}

const okMax = Math.max(0, ...out.probes.filter(p => p.ok).map(p => p.actual_prompt_tokens ?? p.requested));
const failMin = Math.min(Infinity, ...out.probes.filter(p => !p.ok).map(p => p.requested));
out.observed_max_servable_input_tokens = okMax;
out.observed_min_rejected_input_tokens = Number.isFinite(failMin) ? failMin : null;
out.implied_max_servable_ratio_of_W = Number((okMax / W).toFixed(4));
fs.writeFileSync(path.resolve(import.meta.dirname, 'prefill-limit.json'), JSON.stringify(out, null, 2), 'utf8');
console.log(`\n观测：最大可服务输入 ≈ ${okMax} tokens（${(okMax / W * 100).toFixed(1)}%W）；最小被拒输入 = ${Number.isFinite(failMin) ? failMin : 'n/a'}`);
