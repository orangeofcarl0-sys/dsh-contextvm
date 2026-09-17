// 定位"网关预检"造成的实际可用输入上限，并验证预检估算器与真实分词器的比值。
// 结论用于修订 §9.1：声明窗口 262144 不可直接用作预算基准，真正的约束来自预检估算器。
import fs from 'node:fs';
import path from 'node:path';
import { loadCredential, genFiller, W, OPENROUTER_ENDPOINT as ENDPOINT, OPENROUTER_MODEL as MODEL } from './shared/fixtures.mjs';

const KEY = loadCredential('OPENROUTER_API_KEY');

const REAL_CPT = 6.77;   // 实测真实分词器的 chars/token（阶段 2）

async function probe(chars) {
  const t0 = Date.now();
  const res = await fetch(ENDPOINT, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: MODEL, max_tokens: 8, temperature: 0, stream: false,
      messages: [{ role: 'user', content: genFiller(chars, 12345) + '\n\nReply with the single word: ok' }],
    }),
    signal: AbortSignal.timeout(600_000),
  });
  const txt = await res.text();
  let j = null; try { j = JSON.parse(txt); } catch { /* raw */ }
  const ms = Date.now() - t0;
  if (j?.error) {
    const m = /requested about (\d+) tokens/.exec(j.error.message || '');
    return { chars, status: res.status, ok: false, ms,
             gatekeeper_tokens: m ? Number(m[1]) : null,
             estimated_real_tokens: Math.round(chars / REAL_CPT),
             message: (j.error.message || '').slice(0, 160) };
  }
  return { chars, status: res.status, ok: true, ms, real_prompt_tokens: j?.usage?.prompt_tokens ?? null };
}

console.log('chars 越多越接近预检上限；预检计数 >= 262144 时被拒\n');
const rows = [];
for (const chars of [900_000, 950_000, 1_000_000, 1_030_000, 1_050_000]) {
  const r = await probe(chars);
  rows.push(r);
  if (r.ok) {
    console.log(`  chars=${chars.toLocaleString()} OK  real_tokens=${r.real_prompt_tokens} (${(r.real_prompt_tokens / W * 100).toFixed(1)}%W) ${(r.ms / 1000).toFixed(1)}s`);
  } else {
    const ratio = r.gatekeeper_tokens ? (r.gatekeeper_tokens / r.estimated_real_tokens).toFixed(3) : 'n/a';
    console.log(`  chars=${chars.toLocaleString()} REJ 预检=${r.gatekeeper_tokens} 估算真实=${r.estimated_real_tokens} 预检/真实=${ratio} ${(r.ms / 1000).toFixed(1)}s`);
  }
}

const ok = rows.filter(r => r.ok);
const rej = rows.filter(r => !r.ok && r.gatekeeper_tokens);
const maxOkReal = ok.length ? Math.max(...ok.map(r => r.real_prompt_tokens)) : null;
const ratios = rej.map(r => r.gatekeeper_tokens / r.estimated_real_tokens);
const out = {
  model: MODEL, context_window: W, measured_at: new Date().toISOString(),
  real_chars_per_token: REAL_CPT,
  preflight_estimator_over_real_ratio: ratios.length ? Number((ratios.reduce((a, b) => a + b, 0) / ratios.length).toFixed(3)) : null,
  observed_max_servable_real_tokens: maxOkReal,
  observed_max_servable_ratio_of_W: maxOkReal ? Number((maxOkReal / W).toFixed(4)) : null,
  interpretation:
    'OpenRouter 预检以独立估算器计 token，对同一文本比真实分词器保守约 1.7 倍（该模型 tokenizer 为 Other，网关无从得知真实分词）。' +
    '故声明窗口 262144 不是可用输入上限；可用输入由预检估算器决定，且随文本可压缩性变化。',
  rows,
};
fs.writeFileSync(path.resolve(import.meta.dirname, 'preflight-limit.json'), JSON.stringify(out, null, 2), 'utf8');
console.log(`\n预检/真实 比值 = ${out.preflight_estimator_over_real_ratio}`);
console.log(`观测最大可服务真实输入 = ${maxOkReal} tokens (${out.observed_max_servable_ratio_of_W} W)`);
