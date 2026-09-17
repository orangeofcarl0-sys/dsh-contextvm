// opencode zen/go + Anthropic Messages 路由测量：
//  1) 真实可服务输入上限（是否存在类似 OpenRouter 的预检闸门）
//  2) usage.input_tokens 是否随输入规模线性增长（决定 §9.6 在线校准是否可行）
//  3) decode TPS 与 TTFT（与 OpenRouter 路由可比）
import fs from 'node:fs';
import path from 'node:path';
import {
  loadCredential, genFiller, OPENCODE_BASE, OPENCODE_SESSION,
} from './shared/fixtures.mjs';

const KEY = loadCredential('OPENCODE_GO_API_KEY');
const SESSION = OPENCODE_SESSION;
const URL_ = `${OPENCODE_BASE}/messages`;
const H = { 'Content-Type': 'application/json', 'x-api-key': KEY, 'x-opencode-session': SESSION, 'anthropic-version': '2023-06-01' };

const CPT = 6.77;   // OpenRouter 上同模型实测；用于换算目标规模，随后用回报的 input_tokens 校正

async function send(label, { chars = 0, maxTokens = 16, stream = false, extra = {} } = {}) {
  const content = chars ? genFiller(chars, 12345) + '\n\nReply with the single word: ok' : 'Reply with exactly: ok';
  const body = { model: 'union-alpha', max_tokens: maxTokens, messages: [{ role: 'user', content }], ...extra };
  const t0 = Date.now();
  try {
    const r = await fetch(URL_, { method: 'POST', headers: H, body: JSON.stringify(body), signal: AbortSignal.timeout(900_000) });
    if (!stream) {
      const txt = await r.text(); const ms = Date.now() - t0;
      let j = null; try { j = JSON.parse(txt); } catch { /* raw */ }
      return { label, status: r.status, ms, err: j?.error ? (j.error.message || JSON.stringify(j.error)).slice(0, 200) : null, usage: j?.usage ?? null, stop: j?.stop_reason ?? null, chars };
    }
    // 流式：记录 TTFT 与 usage
    if (r.status !== 200) { const txt = await r.text(); return { label, status: r.status, ms: Date.now() - t0, err: txt.slice(0, 200), chars }; }
    const reader = r.body.getReader(); const dec = new TextDecoder();
    let buf = '', ttft = null, field = null, usage = null, blocks = new Set(), stop = null;
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        const p = line.slice(5).trim(); if (!p || p === '[DONE]') continue;
        let ev; try { ev = JSON.parse(p); } catch { continue; }
        if (ev.type === 'message_start' && ev.message?.usage) usage = ev.message.usage;
        if (ev.type === 'message_delta') { if (ev.usage) usage = { ...(usage || {}), ...ev.usage }; if (ev.delta?.stop_reason) stop = ev.delta.stop_reason; }
        if (ev.type === 'content_block_start') blocks.add(ev.content_block?.type);
        if (ev.type === 'content_block_delta' && ev.delta) {
          for (const f of ['text', 'thinking', 'partial_json']) {
            if (typeof ev.delta[f] === 'string' && ev.delta[f]) { if (ttft === null) { ttft = Date.now() - t0; field = ev.delta.type || f; } break; }
          }
        }
      }
    }
    return { label, status: 200, ms: Date.now() - t0, ttft_ms: ttft, ttft_field: field, usage, stop, blocks: [...blocks], chars, err: null };
  } catch (e) { return { label, status: null, ms: Date.now() - t0, err: 'fetch:' + e.name, chars }; }
}

const rows = [];
const rec = (r) => {
  rows.push(r);
  const u = r.usage || {};
  console.log(`  ${r.label.padEnd(24)} ${String(r.status).padEnd(4)} ${(r.ms / 1000).toFixed(1).padStart(6)}s ` +
    `in=${u.input_tokens ?? '-'} cache=${u.cache_read_input_tokens ?? '-'} out=${u.output_tokens ?? '-'} ` +
    `stop=${r.stop ?? '-'}${r.ttft_ms ? ' TTFT=' + (r.ttft_ms / 1000).toFixed(1) + 's@' + r.ttft_field : ''}` +
    (r.blocks?.length ? ' blocks=' + r.blocks.join('+') : '') + (r.err ? '  ERR: ' + r.err : ''));
};

console.log('########## A. 小调用基线 + usage 是否可信 ##########');
rec(await send('tiny'));
rec(await send('tiny-with-system', { extra: { system: '你是一个简洁的助手。' } }));

console.log('\n########## B. 输入规模扫描（找上限 + 验 usage 线性） ##########');
for (const target of [2000, 20000, 60000, 120000, 200000, 250000]) {
  const chars = Math.round(target * CPT);
  const r = await send(`~${target} tok (${chars} chars)`, { chars, maxTokens: 16, stream: true });
  rec(r);
  if (r.err && /context|too long|maximum|limit/i.test(r.err)) {
    console.log(`  -> 出现容量类拒绝，继续向上确认是否为硬上限`);
  }
  await new Promise(res => setTimeout(res, 2000));
}

console.log('\n########## C. decode TPS（256 输出，与 OpenRouter 可比） ##########');
{
  const tps = [];
  for (let i = 1; i <= 2; i++) {
    const r = await send(`tps#${i}`, { maxTokens: 256, stream: true });
    rec(r);
    const out = r.usage?.output_tokens ?? 0;
    if (out && r.ttft_ms) { const t = out / ((r.ms - r.ttft_ms) / 1000); tps.push(t); console.log(`     -> decode TPS=${t.toFixed(2)}（扣除 TTFT）`); }
  }
  if (tps.length) console.log(`  TPS 中位=${(tps.sort((a, b) => a - b)[Math.floor(tps.length / 2)]).toFixed(2)}`);
}

fs.writeFileSync(path.resolve(import.meta.dirname, 'opencode-union-measure.json'),
  JSON.stringify({ url: URL_, model: 'union-alpha', measured_at: new Date().toISOString(), rows }, null, 2), 'utf8');
console.log('\n已写入 benchmark/opencode-union-measure.json');
