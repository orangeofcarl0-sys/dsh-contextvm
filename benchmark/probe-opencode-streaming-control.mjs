// 决定性对照：union-alpha 的流式空流，是"模型/免费档限制"还是"网关路由问题"。
//  A) union-alpha 补齐 SDK 完整请求头后是否仍空流
//  B) 同路由上的另一个 anthropic-messages 模型（minimax-m3）流式是否正常
import { loadCredential, loadOpencodeSession } from './shared/fixtures.mjs';
const KEY = loadCredential('OPENCODE_GO_API_KEY');
const SESSION = loadOpencodeSession();
const URL_ = 'https://opencode.ai/zen/go/v1/messages';

// 复刻 @anthropic-ai/sdk 的请求头集合
const SDK_H = {
  'Content-Type': 'application/json',
  accept: 'application/json',
  'anthropic-version': '2023-06-01',
  'anthropic-dangerous-direct-browser-access': 'true',
  'x-api-key': KEY,
  'x-opencode-session': SESSION,
  'user-agent': 'Anthropic/JS 0.68.0',
};

async function streamTest(label, model, headers) {
  const t0 = Date.now();
  let r;
  try {
    r = await fetch(URL_, {
      method: 'POST', headers,
      body: JSON.stringify({ model, max_tokens: 48, stream: true, messages: [{ role: 'user', content: 'Count 1 to 5.' }] }),
      signal: AbortSignal.timeout(240000),
    });
  } catch (e) { console.log(`  [${label}] fetch 失败 ${e.name}`); return; }
  if (r.status !== 200) { console.log(`  [${label}] http=${r.status} ${(await r.text()).slice(0, 200)}`); return; }
  const reader = r.body.getReader(); const dec = new TextDecoder();
  let buf = '', chunks = 0, firstAt = null;
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    chunks++; if (firstAt === null) firstAt = Date.now() - t0;
    buf += dec.decode(value, { stream: true });
  }
  const ms = Date.now() - t0;
  const types = [...new Set((buf.match(/"type"\s*:\s*"([a-z_]+)"/g) || []).map(s => s.split('"')[3]))];
  console.log(`  [${label}] chunks=${chunks} 首块=${firstAt ?? 'n/a'}ms 字节=${buf.length} 用时=${ms}ms`);
  console.log(`      事件类型: ${types.length ? types.join(', ') : '（无）'} | 含 usage: ${/usage/.test(buf)}`);
  if (buf.length) console.log(`      片段: ${buf.slice(0, 200).replace(/\n/g, ' ')}`);
}

console.log('A) union-alpha（SDK 完整头）');
await streamTest('union-alpha/SDK头', 'union-alpha', SDK_H);

console.log('\nB) 同路由对照模型 minimax-m3（目录声明走 anthropic-messages）');
await streamTest('minimax-m3/SDK头', 'minimax-m3', { ...SDK_H });
await streamTest('minimax-m3/精简头', 'minimax-m3', { 'Content-Type': 'application/json', 'x-api-key': KEY, 'x-opencode-session': SESSION, 'anthropic-version': '2023-06-01' });

console.log('\nC) union-alpha 非流式复核（确认非流式仍正常）');
{
  const t0 = Date.now();
  const r = await fetch(URL_, {
    method: 'POST', headers: SDK_H,
    body: JSON.stringify({ model: 'union-alpha', max_tokens: 32, messages: [{ role: 'user', content: 'Reply ok' }] }),
    signal: AbortSignal.timeout(240000),
  });
  const j = await r.json().catch(() => null);
  console.log(`  http=${r.status} ${Date.now() - t0}ms content=${JSON.stringify(String(j?.content?.[0]?.text ?? '').slice(0, 60))} usage=${JSON.stringify(j?.usage ?? null)}`);
}
