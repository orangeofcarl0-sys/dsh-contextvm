// 关键验证：同一 zen/go 主机上，union-alpha 是否也能经 openai-completions 协议服务。
// 若可以，则直接复用你现有 opencode-go 路由的形态（Bearer 鉴权 + session 头 + 流式可用），
// 避开 Anthropic 通道的空流问题。
import { loadCredential, loadOpencodeSession } from './shared/fixtures.mjs';
const KEY = loadCredential('OPENCODE_GO_API_KEY');
const SESSION = loadOpencodeSession();
const URL_ = 'https://opencode.ai/zen/go/v1/chat/completions';

// 与现有 opencode-go 路由一致的鉴权形态
const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}`, 'x-opencode-session': SESSION };

console.log('########## 1. 非流式 ##########');
{
  const t0 = Date.now();
  const r = await fetch(URL_, {
    method: 'POST', headers: H,
    body: JSON.stringify({ model: 'union-alpha', max_tokens: 64, messages: [{ role: 'user', content: 'Reply with exactly: ok' }] }),
    signal: AbortSignal.timeout(300000),
  });
  const txt = await r.text(); const ms = Date.now() - t0;
  console.log(`  http=${r.status} ${ms}ms`);
  let j = null; try { j = JSON.parse(txt); } catch { /* raw */ }
  if (j?.error) console.log('  ERROR:', JSON.stringify(j.error).slice(0, 300));
  else {
    console.log('  model:', j.model, '| finish:', j.choices?.[0]?.finish_reason);
    console.log('  content:', JSON.stringify(String(j.choices?.[0]?.message?.content ?? '').slice(0, 120)));
    console.log('  usage:', JSON.stringify(j.usage));
    console.log('  cost:', JSON.stringify(j.cost ?? null));
  }
}

console.log('\n########## 2. 流式（判定是否与 Anthropic 通道一样是空流） ##########');
{
  const t0 = Date.now();
  const r = await fetch(URL_, {
    method: 'POST', headers: H,
    body: JSON.stringify({ model: 'union-alpha', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'Count 1 to 5.' }] }),
    signal: AbortSignal.timeout(300000),
  });
  console.log(`  http=${r.status} ct=${r.headers.get('content-type')}`);
  const reader = r.body.getReader(); const dec = new TextDecoder();
  let buf = '', chunks = 0, firstAt = null;
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    chunks++; if (firstAt === null) firstAt = Date.now() - t0;
    buf += dec.decode(value, { stream: true });
  }
  console.log(`  chunks=${chunks} 首块=${firstAt}ms 总长=${buf.length} 用时=${Date.now() - t0}ms`);
  if (buf.length) {
    console.log('  事件样本:', buf.slice(0, 300).replace(/\n/g, ' | '));
    console.log('  是否含 usage:', /usage/.test(buf));
  }
}

console.log('\n########## 3. tools（openai 形态） ##########');
{
  const r = await fetch(URL_, {
    method: 'POST', headers: H,
    body: JSON.stringify({
      model: 'union-alpha', max_tokens: 128,
      messages: [{ role: 'user', content: '上海天气如何？请调用工具。' }],
      tools: [{ type: 'function', function: { name: 'get_weather', description: 'Get weather', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } }],
    }),
    signal: AbortSignal.timeout(300000),
  });
  const j = await r.json().catch(() => null);
  console.log(`  http=${r.status} finish=${j?.choices?.[0]?.finish_reason} tool_calls=${JSON.stringify(j?.choices?.[0]?.message?.tool_calls ?? null).slice(0, 200)}`);
}
