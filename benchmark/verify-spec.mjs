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
// 规范与实现的交叉核对：§17.1 的输出上限是规范性数值，两处 MUST 一致。
// 这里直接把 DEFAULTS 读出来比，而不是在脚本里再抄一遍数字 —— 抄一遍就等于又开了一个来源。
const { DEFAULTS } = await import('../lib/app/config.js');
const specCaps = [
  ['output.state_delta_soft_max_tokens', DEFAULTS.output.state_delta_soft_max_tokens],
  ['output.state_delta_hard_max_tokens', DEFAULTS.output.state_delta_hard_max_tokens],
  ['output.global_worker_output_max_tokens', DEFAULTS.output.global_worker_output_max_tokens],
  ['output.global_worker_output_complex_max_tokens', DEFAULTS.output.global_worker_output_complex_max_tokens],
  ['episode.summary_target_tokens', DEFAULTS.episode.summary_target_tokens],
  ['episode.summary_hard_max_tokens', DEFAULTS.episode.summary_hard_max_tokens],
];
// §17.1 有两个陈述处（摘要块与 absolute 清单），二者 MUST 一致。
// 这条守卫是被真机审计逼出来的：摘要块曾长期停在旧值（soft 500 / hard 800 /
// EPISODE_SUMMARY_MAX 1600 / GLOBAL_WORKER_MAX_OUTPUT 300），而下面的逐项核对只认
// absolute 清单的格式，于是"规范自己跟自己不一致"整整漏过一轮。
console.log('\n=== 规范 §17.1 陈旧数值（摘要块）===');
for (const stale of ['soft 500', 'hard 800', 'EPISODE_SUMMARY_MAX       = 1600', 'GLOBAL_WORKER_MAX_OUTPUT  = 300', 'STATE_DELTA_TARGET_OUTPUT']) {
  check(`不得残留陈旧写法「${stale}」`, !s.includes(stale));
}

console.log('\n=== 规范 §17.1 输出上限 vs 实现 DEFAULTS ===');
for (const [key, value] of specCaps) {
  check(`${key} = ${value} 在规范中一致`, new RegExp(`${key.replace('.', '\\.')}:\\s*${value}\\b`).test(s));
}

// 注入策略（§4.1.1）：规范必须写明"分类 ≠ 注入"，且必须有唯一判定实现
console.log('\n=== 注入策略（§4.1.1）===')
check('规范含 §4.1.1 且写明分类≠注入', /### 4\.1\.1 分类 ≠ 注入/.test(s));
check('规范规定宿主托管上下文 MUST NOT 进 recent/候选/邻居', /MUST NOT 进入 recent verbatim/.test(s) && /MUST NOT 成为检索候选/.test(s));
check('规范规定判定唯一实现', /lib\/core\/injectability\.js/.test(s));
const injPath = path.resolve(import.meta.dirname, '..', 'lib', 'core', 'injectability.js');
check('判定模块存在（唯一实现处）', fs.existsSync(injPath));

// 状态写入侧（§5.2.1）：规范必须写明 next_action 的三条落库语义与宿主来源拒绝
check('规范含 §5.2.1 next_action 落库语义', /### 5\.2\.1 `next_action` 的落库语义/.test(s));
check('规范要求 next_action 用稳定 key', /MUST 用固定 key/.test(s));
check('规范要求无来源即拒收', /next_action_without_source/.test(s));
check('规范要求拒绝宿主样板来源的 upsert', /source_is_host_context/.test(s));
check('规范指出验收语料必须覆盖 next_action', /验收语料 MUST 覆盖 `next_action` 路径/.test(s));

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
  ['版本 v1.4', '文档版本**：v1.4'],
];
for (const [label, pat] of need) check(label, s.includes(pat));

console.log(`\n${fail === 0 ? '全部通过' : fail + ' 项失败'}`);
process.exit(fail ? 1 : 0);
