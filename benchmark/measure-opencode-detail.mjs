// 补齐三项：1) 容量拒绝的完整正文（确认闸门阈值）
//          2) 流式响应的真实事件格式（为何 usage 缺失）
//          3) 非流式 256 输出的 decode TPS
import {
  loadCredential, genFiller, OPENCODE_BASE, OPENCODE_SESSION,
} from './shared/fixtures.mjs';

const KEY = loadCredential('OPENCODE_GO_API_KEY');
const SESSION = OPENCODE_SESSION;
const URL_ = `${OPENCODE_BASE}/messages`;
const H = { 'Content-Type': 'application/json', 'x-api-key': KEY, 'x-opencode-session': SESSION, 'anthropic-version': '2023-06-01' };

console.log('########## 1. 容量拒绝的完整正文 ##########');
{
  const chars = Math.round(200000 * 6.77);
  const r = await fetch(URL_, {
    method: 'POST', headers: H,
    body: JSON.stringify({ model: 'union-alpha', max_tokens: 16, messages: [{ role: 'user', content: genFiller(chars, 12345) + '\n\nReply ok' }] }),
    signal: AbortSignal.timeout(300000),
  });
  console.log('  http =', r.status, '| chars =', chars, '| 该估算器声称 5.0 chars/token 推算 =', Math.round(chars / 5.0));
  console.log('  完整正文:');
  console.log('  ' + (await r.text()).replace(/\n/g, '\n  '));
}

console.log('\n########## 2. 流式响应真实格式（前 2000 字节原始） ##########');
{
  const r = await fetch(URL_, {
    method: 'POST', headers: H,
    body: JSON.stringify({ model: 'union-alpha', max_tokens: 32, stream: true, messages: [{ role: 'user', content: 'Count 1 to 5.' }] }),
    signal: AbortSignal.timeout(300000),
  });
  console.log('  http =', r.status, '| content-type =', r.headers.get('content-type'));
  const reader = r.body.getReader(); const dec = new TextDecoder();
  let buf = '';
  const t0 = Date.now();
  while (buf.length < 2000) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
  }
  console.log(`  首 ${buf.length} 字节（${Date.now() - t0}ms 内）：`);
  console.log('  ' + buf.slice(0, 2000).replace(/\n/g, '\n  '));
  try { reader.cancel(); } catch { /* ignore */ }
}

console.log('\n########## 3. 非流式 256 输出的 decode TPS（usage 可信路径） ##########');
{
  const tps = [];
  for (let i = 1; i <= 2; i++) {
    const t0 = Date.now();
    const r = await fetch(URL_, {
      method: 'POST', headers: H,
      body: JSON.stringify({ model: 'union-alpha', max_tokens: 256, messages: [{ role: 'user', content: 'Count upward from 1, one number per line. Keep going.' }] }),
      signal: AbortSignal.timeout(600000),
    });
    const j = await r.json(); const ms = Date.now() - t0;
    const out = j.usage?.output_tokens ?? 0;
    const t = out / (ms / 1000);
    tps.push(t);
    console.log(`  #${i} http=${r.status} out=${out} total=${(ms / 1000).toFixed(1)}s stop=${j.stop_reason} TPS(含TTFT)=${t.toFixed(2)} cost=${JSON.stringify(j.cost ?? null)}`);
  }
  console.log(`  上界 TPS 中位 = ${tps.sort((a, b) => a - b)[Math.floor(tps.length / 2)].toFixed(2)}（含固定开销，故为下界）`);
}
