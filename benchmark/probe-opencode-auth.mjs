// 修正鉴权头：Anthropic Messages 协议用 x-api-key，非 Authorization: Bearer。
import fs from 'node:fs';
import { loadCredential, loadOpencodeSession } from './shared/fixtures.mjs';
const KEY = loadCredential('OPENCODE_GO_API_KEY');
const SESSION = loadOpencodeSession();
const BASE = 'https://opencode.ai/zen/go/v1';

console.log('########## A. /models 是否需要鉴权 ##########');
{
  const r = await fetch(BASE + '/models', { signal: AbortSignal.timeout(30000) });
  console.log('  无任何鉴权头 GET /models ->', r.status, '(200 说明该端点公开，前次 200 不能证明密钥有效)');
}

console.log('\n########## B. 鉴权头组合矩阵 ##########');
const variants = [
  ['x-api-key + session', { 'x-api-key': KEY, 'x-opencode-session': SESSION, 'anthropic-version': '2023-06-01' }],
  ['x-api-key 无 session', { 'x-api-key': KEY, 'anthropic-version': '2023-06-01' }],
  ['Bearer + session（前次失败）', { Authorization: `Bearer ${KEY}`, 'x-opencode-session': SESSION, 'anthropic-version': '2023-06-01' }],
  ['两者都给 + session', { 'x-api-key': KEY, Authorization: `Bearer ${KEY}`, 'x-opencode-session': SESSION, 'anthropic-version': '2023-06-01' }],
];
let working = null;
for (const [label, h] of variants) {
  const t0 = Date.now();
  const r = await fetch(BASE + '/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...h },
    body: JSON.stringify({ model: 'union-alpha', max_tokens: 32, messages: [{ role: 'user', content: 'Reply with exactly: ok' }] }),
    signal: AbortSignal.timeout(180000),
  });
  const txt = await r.text();
  const ms = Date.now() - t0;
  let j = null; try { j = JSON.parse(txt); } catch { /* raw */ }
  const okCall = r.status === 200 && !j?.error;
  console.log(`  ${label.padEnd(30)} -> ${r.status} ${ms}ms ${okCall ? 'OK' : (j?.error?.message || txt.slice(0, 120))}`);
  if (okCall) {
    if (!working) working = { label, headers: h };
    console.log(`      model=${j.model} stop_reason=${j.stop_reason} usage=${JSON.stringify(j.usage)}`);
    console.log(`      content blocks: ${(j.content || []).map(b => b.type).join(',')} text=${JSON.stringify(String((j.content || []).find(b => b.type === 'text')?.text || '').slice(0, 80))}`);
  }
}

if (!working) { console.log('\n没有任何组合成功，需要其它凭据。'); process.exit(1); }
console.log(`\n可用鉴权方式：${working.label}`);

const H = { 'Content-Type': 'application/json', ...working.headers };
const call = async (label, body, stream = false) => {
  const t0 = Date.now();
  const r = await fetch(BASE + '/messages', { method: 'POST', headers: H, body: JSON.stringify({ model: 'union-alpha', max_tokens: 64, ...body }), signal: AbortSignal.timeout(300000) });
  const txt = await r.text(); const ms = Date.now() - t0;
  console.log(`\n[${label}] http=${r.status} ${ms}ms`);
  if (r.status !== 200) { console.log('  ', txt.slice(0, 300)); return null; }
  if (stream) { console.log('  流式前 500 字节:'); console.log('  ' + txt.slice(0, 500).replace(/\n/g, '\n  ')); return null; }
  const j = JSON.parse(txt);
  console.log('  顶层:', Object.keys(j).join(','), '| model:', j.model, '| stop_reason:', j.stop_reason);
  console.log('  usage:', JSON.stringify(j.usage));
  for (const b of j.content || []) {
    if (b.type === 'text') console.log('  text:', JSON.stringify(String(b.text).slice(0, 150)));
    else if (b.type === 'thinking') console.log(`  THINKING 块 len=${String(b.thinking || '').length} 样本=${JSON.stringify(String(b.thinking || '').slice(0, 100))}`);
    else if (b.type === 'tool_use') console.log('  tool_use:', JSON.stringify(b));
    else console.log('  block:', b.type);
  }
  return j;
};

console.log('\n########## C. 能力探测 ##########');
await call('system + 中文', { system: '你是一个简洁的助手。', messages: [{ role: 'user', content: '用一句话说明上下文虚拟化的目的。' }] });
await call('tools', {
  messages: [{ role: 'user', content: '上海天气如何？请调用工具。' }],
  tools: [{ name: 'get_weather', description: 'Get weather for a city', input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }],
});
console.log('\n########## D. 流式（看 thinking 是否在流里出现） ##########');
await call('stream', { messages: [{ role: 'user', content: 'Count 1 to 5.' }], stream: true }, true);

fs.writeFileSync(new URL('./opencode-union-auth.json', import.meta.url),
  JSON.stringify({ working_auth: working.label, tested: variants.map(v => v[0]), model: 'union-alpha', base: BASE }, null, 2));
