// 规范数值不变量与陈旧数值终检（避免 shell 转义问题，写成文件）
import fs from 'node:fs';
import path from 'node:path';

const FILE = path.resolve(import.meta.dirname, '..', 'context_virtualization_spec_v1.md');
const s = fs.readFileSync(FILE, 'utf8');
const L = s.split(/\r?\n/);
const W = 262144;
let fail = 0;
const check = (label, ok, detail = '') => {
  if (!ok) fail++;
  console.log(`${ok ? 'ok      ' : '!! FAIL '} ${label}${detail ? '  ' + detail : ''}`);
};

console.log(`lines=${L.length} bytes=${Buffer.byteLength(s)}`);
const fences = L.filter(l => /^\s*```/.test(l)).length;
check('代码围栏配对', fences % 2 === 0, `fences=${fences}`);

console.log('\n=== 数值不变量 ===');
const r = { chunk: 0.305, normal: 0.458, heavy: 0.500, cap: 0.550 };
check('偏序 chunk<normal<heavy<cap', r.chunk < r.normal && r.normal < r.heavy && r.heavy < r.cap);
for (const [k, v] of Object.entries(r)) console.log(`         ${k.padEnd(7)} ${v} @262144 = ${Math.round(v * W)}`);
const comp = [0.020, 0.040, 0.135, 0.025, 0.160, 0.170];
const sum = comp.reduce((a, b) => a + b, 0);
check('组件上界之和 <= cap', sum <= r.cap, `sum=${sum.toFixed(3)} cap=${r.cap}`);
const pf = 1.693;
check('预检断言 ratio*cap <= 0.98', pf * r.cap <= 0.98, `${(pf * r.cap).toFixed(3)}`);
check('v1.0 两档落在预检上限外（故必然 400）', pf * 0.649 > 0.98 && pf * 0.782 > 0.98,
  `heavy ${(pf * 0.649).toFixed(3)} / cap ${(pf * 0.782).toFixed(3)}`);
check('实测可服务比例记录为 0.560', /146,?820/.test(s) && /0\.560/.test(s));

console.log('\n=== 陈旧数值扫描 ===');
// 必须彻底消失的（旧实现物 / 被推翻且不应再被陈述的结论）
const mustVanish = [
  ['旧 worker 耗时 50–375', '50–375'],
  ['旧组件上限 current_artifact_max 0.191', 'current_artifact_max: 0.191'],
  ['旧组件上限 authoritative_state_max 0.046', 'authoritative_state_max: 0.046'],
  ['旧估算结论「高估 29%」', '高估 29%'],
  ['旧 §18 Python 依赖块', 'Python 3.11+'],
  ['旧模块树 context_proxy', 'context_proxy/'],
  ['旧异步声明 asyncio', 'asyncio。'],
];
for (const [label, pat] of mustVanish) {
  const n = s.split(pat).length - 1;
  check(label + ' 已清除', n === 0, n ? `出现 ${n} 次` : '');
}
// 允许作为 v1.0 对照出现的（仅统计，不判失败），但不得出现在 §9.1/§19 的生效配置块中
const allowedAsReference = [
  ['v1.0 heavy 0.649', '0.649', 8],
  ['v1.0 hard cap 0.782', '0.782', 8],
  ['早期 TPS 0.8–6.2', '0.8–6.2', 3],
  ['早期「低估 46%」', '低估 46%', 1],
];
console.log('  （以下仅作 v1.0 对照，允许出现）');
for (const [label, pat, max] of allowedAsReference) {
  const n = s.split(pat).length - 1;
  check(label + ' 次数在预期内', n <= max, `出现 ${n} 次（上限 ${max}）`);
}

console.log('\n=== 关键新内容存在性 ===');
const need = [
  ['§2.1.1 实测验证', '### 2.1.1 实测验证'],
  ['§2.1.2 路由候选评估', '### 2.1.2 路由候选评估'],
  ['路由属性声明', '本节是路由属性，不是模型属性'],
  ['opencode 流式阻断项', '流式返回零字节'],
  ['opencode 估算系数 5.0', '5.0 chars/token'],
  ['opencode 上限 0.739W', '0.739W'],
  ['§9.1.1 网关预检', '## 9.1.1 网关预检'],
  ['§9.6 三口径分析', '三个互不相同的 token 计数口径'],
  ['§19.1 含预检不变量', 'preflight_ratio_assumed * estimated_input'],
  ['§25 preflight_calibration', 'preflight_calibration'],
  ['§12 并发实测', '27.9 TPS'],
  ['§9.1.1 自适应收缩 MUST', 'MUST 实现自适应收缩'],
  ['§13.1 宿主缝限制', '不暴露任何 `response_format`'],
  ['§7.1.1 关键词为主的理由', '为什么以关键词为主'],
  ['§7.1.2 embedding 降级定位', 'embedding 的定位：降级，而非移除'],
  ['摘要桥接声明', '承担了 embedding 原本最主要的收益'],
  ['版本 v1.3', '文档版本**：v1.3'],
];
for (const [label, pat] of need) check(label, s.includes(pat));

console.log(`\n${fail === 0 ? '全部通过' : fail + ' 项失败'}`);
process.exit(fail ? 1 : 0);
