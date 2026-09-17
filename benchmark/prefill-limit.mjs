// 尺寸相关性探针：判定大 prefill 的 502 provider_unavailable 是"尺寸相关"还是"偶发"。
// 这是规范 §9.1 预算体系能否成立的前提——若 ≥64k prefill 不可稳定服务，
// normal/heavy/hard 三档比例必须整体下调。
import fs from 'node:fs';
import path from 'node:path';
import { loadCredential, genFiller, W, OPENROUTER_ENDPOINT as ENDPOINT, OPENROUTER_MODEL as MODEL } from './shared/fixtures.mjs';

const KEY = loadCredential('OPENROUTER_API_KEY');

const CPT = 6.77;               // 实测伪随机填充词的 chars/token（见 bench-run.log 阶段 2）
const TARGETS = [0.122, 0.244, 0.488, 0.732];   // 32k / 64k / 128k / 192k
const ATTEMPTS = 3;
const results = [];

async function attempt(tokens) {
  const chars = Math.round(tokens * CPT);
  const body = {
    model: MODEL, max_tokens: 8, temperature: 0, stream: true,
    messages: [{ role: 'user', content: genFiller(chars, 99991) + '\n\nReply with the single word: ok' }],
  };
  const t0 = Date.now();
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify(body), signal: AbortSignal.timeout(600_000),
    });
    if (!res.ok) return { status: res.status, error: `http${res.status}`, ms: Date.now() - t0 };
    const dec = new TextDecoder(); const reader = res.body.getReader();
    let buf = '', ttft = null, usage = null, err = null, field = null;
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        const p = line.slice(5).trim(); if (p === '[DONE]') continue;
        let ev; try { ev = JSON.parse(p); } catch { continue; }
        if (ev.error) { err = `stream ${ev.error.code} ${ev.error.metadata?.error_type || ''}`; continue; }
        if (ev.usage) usage = ev.usage;
        const d = ev.choices?.[0]?.delta;
        if (d) for (const f of ['content', 'reasoning_content', 'reasoning']) {
          if (typeof d[f] === 'string' && d[f]) { if (ttft === null) { ttft = Date.now() - t0; field = f; } break; }
        }
      }
    }
    return { status: res.status, error: err, ttft_ms: ttft, ttft_field: field, prompt_tokens: usage?.prompt_tokens ?? null, ms: Date.now() - t0 };
  } catch (e) { return { status: null, error: 'fetch:' + e.name, ms: Date.now() - t0 }; }
}

console.log('目标 token  尝试  结果');
for (const ratio of TARGETS) {
  const target = Math.round(ratio * W);
  const row = { ratio_of_W: ratio, target_tokens: target, attempts: [] };
  for (let a = 1; a <= ATTEMPTS; a++) {
    const r = await attempt(target);
    row.attempts.push({ attempt: a, ...r });
    const ok = !r.error;
    console.log(`  ${String(target).padStart(7)}  #${a}   ${ok ? 'OK  ' : 'FAIL'} actual=${r.prompt_tokens ?? '?'} TTFT=${r.ttft_ms ? (r.ttft_ms / 1000).toFixed(1) + 's' : '-'} ${r.error || ''}`);
    if (ok) break;                       // 成功即止
    if (a < ATTEMPTS) await new Promise(r2 => setTimeout(r2, 8000));   // 退避后重试
  }
  row.succeeded = row.attempts.filter(x => !x.error).length;
  row.verdict = row.attempts[0] && !row.attempts[0].error ? 'first-try-ok'
    : row.succeeded ? 'ok-after-retry' : 'fail-all-attempts';
  results.push(row);
}

const out = { model: MODEL, context_window: W, measured_at: new Date().toISOString(), attempts_per_size: ATTEMPTS, results };
fs.writeFileSync(path.resolve(import.meta.dirname, 'prefill-limit.json'), JSON.stringify(out, null, 2), 'utf8');
console.log('\n结论：');
for (const r of results) console.log(`  ${(r.ratio_of_W * 100).toFixed(1)}%W (${r.target_tokens}): ${r.verdict}`);
