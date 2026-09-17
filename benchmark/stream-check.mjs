// 判定 opencode 路由的流式行为：是"缓冲后一次性发出"还是"空流"。
import { loadCredential, loadOpencodeSession } from './shared/fixtures.mjs';
const KEY = loadCredential('OPENCODE_GO_API_KEY');
const r = await fetch('https://opencode.ai/zen/go/v1/messages', {
  method:'POST',
  headers:{'Content-Type':'application/json','x-api-key':KEY,'x-opencode-session':loadOpencodeSession(),'anthropic-version':'2023-06-01'},
  body: JSON.stringify({model:'union-alpha',max_tokens:32,stream:true,messages:[{role:'user',content:'Count 1 to 5.'}]}),
  signal: AbortSignal.timeout(300000),
});
console.log('http=',r.status,'ct=',r.headers.get('content-type'));
const reader=r.body.getReader(); const dec=new TextDecoder();
let buf='', chunks=0, firstAt=null; const t0=Date.now();
for(;;){
  const {done,value}=await reader.read(); if(done)break;
  chunks++; if(firstAt===null) firstAt=Date.now()-t0;
  buf+=dec.decode(value,{stream:true});
}
console.log('chunks=',chunks,'首个chunk在',firstAt,'ms','总长',buf.length,'用时',Date.now()-t0,'ms');
console.log('事件类型:', [...new Set((buf.match(/"type":"[a-z_]+"/g)||[]))].join(', '));
console.log('是否含 usage:', /usage/.test(buf), '| 是否含 input_tokens:', /input_tokens/.test(buf));
console.log('正文尾部 600 字节:'); console.log(buf.slice(-600));
