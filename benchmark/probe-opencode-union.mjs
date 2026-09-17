// 侦察 opencode zen/go 上的 Union Alpha（Anthropic Messages 协议）
// 目标：确认模型 id、协议、鉴权头、usage 是否可读、是否回传 thinking、
//       以及该网关是否有类似 OpenRouter 的预检上限。
// 密钥取自 .credentials.yaml 的 OPENCODE_GO_API_KEY，不打印。
import { loadCredential, loadOpencodeSession } from './shared/fixtures.mjs';
const KEY = loadCredential('OPENCODE_GO_API_KEY');

const SESSION = loadOpencodeSession();
const BASE = 'https://opencode.ai/zen/go/v1';

const H = {
  'Content-Type': 'application/json',
  Authorization: `Bearer ${KEY}`,
  'x-opencode-session': SESSION,
  'anthropic-version': '2023-06-01',
};

async function get(path, headers = H) {
  const t0 = Date.now();
  try {
    const r = await fetch(BASE + path, { headers, signal: AbortSignal.timeout(60000) });
    const txt = await r.text();
    return { status: r.status, ms: Date.now() - t0, txt };
  } catch (e) { return { status: null, ms: Date.now() - t0, txt: 'ERR ' + e.name + ': ' + e.message }; }
}

console.log('########## 1. 枚举模型（找 union-alpha 与上下文长度） ##########');
for (const p of ['/models', '/models?limit=200']) {
  const r = await get(p);
  console.log(`GET ${p} -> ${r.status} ${r.ms}ms (${r.txt.length} bytes)`);
  if (r.status === 200) {
    try {
      const j = JSON.parse(r.txt);
      const arr = j.data || j.models || j;
      if (Array.isArray(arr)) {
        console.log('  模型数:', arr.length);
        const hits = arr.filter(m => /union/i.test(JSON.stringify(m)));
        console.log('  含 union 的条目:');
        for (const h of hits) console.log('   ', JSON.stringify(h));
        if (!hits.length) console.log('  样本:', JSON.stringify(arr.slice(0, 3)));
      } else console.log('  非数组:', JSON.stringify(j).slice(0, 300));
    } catch { console.log('  非 JSON:', r.txt.slice(0, 300)); }
    break;
  } else {
    console.log('  正文:', r.txt.slice(0, 200));
  }
}

console.log('\n########## 2. 最小 messages 调用（校验协议与鉴权） ##########');
async function msg(label, body, { stream = false, headers = H } = {}) {
  const t0 = Date.now();
  try {
    const r = await fetch(BASE + '/messages', {
      method: 'POST', headers,
      body: JSON.stringify({ model: 'union-alpha', max_tokens: 64, ...body }),
      signal: AbortSignal.timeout(300000),
    });
    const txt = await r.text();
    const ms = Date.now() - t0;
    console.log(`\n[${label}] http=${r.status} ${ms}ms`);
    if (r.status !== 200) { console.log('  正文:', txt.slice(0, 400)); return null; }
    if (stream) { console.log('  流式响应前 400 字节:', txt.slice(0, 400)); return { txt, ms }; }
    let j; try { j = JSON.parse(txt); } catch { console.log('  非 JSON:', txt.slice(0, 300)); return null; }
    console.log('  顶层字段:', Object.keys(j).join(','));
    console.log('  model:', j.model, '| stop_reason:', j.stop_reason);
    console.log('  usage:', JSON.stringify(j.usage));
    for (const b of j.content || []) {
      console.log(`  block type=${b.type}`, b.type === 'text' ? JSON.stringify(String(b.text).slice(0, 120))
        : b.type === 'thinking' ? 'THINKING len=' + String(b.thinking || '').length : '');
    }
    return j;
  } catch (e) { console.log(`[${label}] fetch 失败: ${e.name} ${e.message}`); return null; }
}

// 2a 不带 x-opencode-session，看是否 400 MissingSessionID（对齐已知的 go 路由行为）
{
  const noSess = { ...H }; delete noSess['x-opencode-session'];
  await msg('无 session 头（对照）', { messages: [{ role: 'user', content: 'hi' }] }, { headers: noSess });
}
// 2b 正常调用
const ok = await msg('基本调用', { messages: [{ role: 'user', content: 'Reply with exactly: ok' }] });
// 2c system + 中文
await msg('system + 中文', {
  system: '你是一个简洁的助手。',
  messages: [{ role: 'user', content: '用一句话说明上下文虚拟化的目的。' }],
});

console.log('\n########## 3. tools（Anthropic 格式） ##########');
await msg('tools', {
  messages: [{ role: 'user', content: '上海天气如何？请调用工具。' }],
  tools: [{
    name: 'get_weather', description: 'Get weather for a city',
    input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  }],
});

console.log('\n########## 4. 流式 ##########');
await msg('stream', { messages: [{ role: 'user', content: 'Count 1 to 5.' }], stream: true }, { stream: true });
