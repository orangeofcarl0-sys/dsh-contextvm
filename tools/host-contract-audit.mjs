/**
 * 宿主契约实机审计（只读）。
 *
 * 目的：本项目此前只用假宿主测试，所有宿主接口都是**照类型声明假设**的。
 * 本脚本加载**真实的宿主包**来验证这些假设，重点两件事：
 *   1) 用真的 `defineTool` 编译我们 8 个工具定义（假的 defineTool 只做透传，
 *      永远发现不了 schema 形状错误）；
 *   2) 逐条核对我在代码里调用的宿主成员是否真实存在、字段名是否与假设一致。
 *
 * 用法：node tools/host-contract-audit.mjs
 * 退出码非 0 表示存在契约不符。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const DSH_HOME = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh');
const PKG_ROOT = path.join(DSH_HOME, 'profiles', 'node_modules', '@deepseek-ai');
const require = createRequire(path.join(DSH_HOME, 'profiles', 'node_modules', 'noop.js'));

let failures = 0;
const ok = (msg) => console.log(`  ok    ${msg}`);
const bad = (msg) => {
  failures += 1;
  console.log(`  FAIL  ${msg}`);
};

console.log(`宿主包位置: ${PKG_ROOT}`);

// 该审计**依赖本机安装的宿主包**，因此不放进 npm test（那必须能在任何机器上跑）。
// 找不到宿主时明确跳过，并说明原因，而不是报一堆假失败。
if (!fs.existsSync(PKG_ROOT)) {
  console.log(`  跳过：未找到宿主包 ${PKG_ROOT}`);
  console.log('  该脚本用于核对"代码调用的宿主接口"与"宿主实际提供的接口"是否一致，');
  console.log('  需要本机安装 DSH（或设置 DSH_HOME 指向安装位置）后才能执行。');
  process.exit(0);
}

// ---------------------------------------------------------------- A. 真实 defineTool

console.log('\n═══ A. 用宿主真实 defineTool 编译我们的工具定义 ═══');
const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8'));
let defineToolReal = null;
try {
  const toolsMod = require('@deepseek-ai/dsh-tools');
  defineToolReal = toolsMod.defineTool;
  ok(`已加载 @deepseek-ai/dsh-tools（${toolsMod.supportedProtocols ? '含协议表' : '基础导出'}）`);
} catch (err) {
  bad(`无法加载 @deepseek-ai/dsh-tools：${err.message}`);
}

if (defineToolReal) {
  // 造一个最小 runtime：工具定义编译只读 schema 与元数据，不执行 execute
  const stubRuntime = {
    tokenizer: { estimate: () => 1 },
    config: { output: {} },
    raw: {}, state: {}, artifacts: {}, episodes: {},
  };
  const { commitStateTool } = await import('../lib/tools/commit_state.js');
  const { exhaustiveScanTool } = await import('../lib/tools/exhaustive_scan.js');
  const { memoryTools } = await import('../lib/tools/memory_tools.js');

  const defs = [
    commitStateTool(stubRuntime, { defineTool: defineToolReal }),
    exhaustiveScanTool(stubRuntime, { defineTool: defineToolReal }),
    ...memoryTools(stubRuntime, { defineTool: defineToolReal }),
  ];
  for (const d of defs) {
    try {
      const name = d?.name ?? d?.definition?.name;
      if (name) ok(`defineTool 接受了 ${name}`);
      else bad('defineTool 返回值不含 name，需核对其返回结构');
    } catch (err) {
      bad(`defineTool 拒绝了一个定义：${err.message}`);
    }
  }
  console.log(`  合计 ${defs.length} 个工具定义通过宿主编译`);
}

// ---------------------------------------------------------------- B. 静态契约核对

console.log('\n═══ B. 我调用的宿主成员是否真实存在 ═══');

/**
 * 在宿主 .d.ts 里查找成员声明。
 *
 * 内部强制补 `g`：`matchAll` 要求全局正则，而各条契约的写法不一定会带上它——
 * 早期版本因此有 6 条检查以"检查本身出错"告终（假失败比漏检更误导）。
 */
function findInTypes(pkgs, pattern) {
  const re = pattern.global
    ? pattern
    : new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g');
  const hits = [];
  for (const pkg of pkgs) {
    const dir = path.join(PKG_ROOT, pkg, 'lib', 'types');
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.d.ts')) continue;
      const text = fs.readFileSync(path.join(dir, f), 'utf8');
      for (const m of text.matchAll(re)) hits.push({ pkg, file: f, snippet: m[0].replace(/\s+/g, ' ').trim() });
    }
  }
  return hits;
}

/** 一条契约：描述 + 期望的声明 + 检查。 */
const contracts = [
  {
    what: 'Agent 上有 session（工具据此确定会话）',
    check: () => findInTypes(['dsh-agent'], /readonly session:\s*Session/g).length > 0,
    evidence: 'dsh-agent/lib/types/runtime-types.d.ts 对 Agent 的增强',
  },
  {
    what: 'ToolExecutionInput 上没有 session（故只能经 agent.session 取）',
    check: () => findInTypes(['dsh-tools'], /interface ToolExecutionInput[\s\S]{0,400}?readonly session/).length === 0,
    evidence: 'dsh-tools/lib/types/index.d.ts ToolExecutionInput 的字段清单',
  },
  {
    what: 'EpochHeader 的 provider/model 位于 .config 之下',
    check: () => findInTypes(['dsh-session'], /interface EpochHeader[\s\S]{0,300}?config:\s*LlmCallConfig/).length > 0,
    evidence: 'dsh-session/lib/types/types.d.ts',
  },
  {
    what: 'LlmCallConfig 含 provider 与 model',
    check: () => findInTypes(['dsh-llm'], /interface LlmCallConfig[\s\S]{0,400}?provider:\s*string[\s\S]{0,200}?model:\s*string/).length > 0,
    evidence: 'dsh-llm/lib/types/call-config.d.ts',
  },
  {
    what: 'llm.resolveModelInfo 返回带 contextWindow 的解析结果',
    check: () => findInTypes(['dsh-llm'], /string, signal\?:\s*AbortSignal\):\s*Promise<LlmResolvedModelInfo>/g).length > 0,
    evidence: 'dsh-llm/lib/types/index.d.ts',
  },
  {
    what: 'LlmModelContext.contextWindow 为必填',
    check: () => findInTypes(['dsh-llm'], /interface LlmModelContext[\s\S]{0,200}?contextWindow:\s*number/).length > 0,
    evidence: 'dsh-llm/lib/types/types.d.ts',
  },
  {
    what: 'system-prompt/assemble 的第二参带 agent',
    check: () => findInTypes(['dsh-agent'], /interface AssembleContext[\s\S]{0,200}?agent\?:\s*Agent/).length > 0,
    evidence: 'dsh-agent/lib/types/runtime-types.d.ts',
  },
  {
    what: 'PromptAssembly.contexts 元素形状为 {name, text}',
    check: () => findInTypes(['dsh-system-prompt'], /interface AssembledContext[\s\S]{0,200}?name:\s*string[\s\S]{0,200}?text:\s*string/).length > 0,
    evidence: 'dsh-system-prompt/lib/types/index.d.ts',
  },
  {
    what: 'session/event 的签名是 (session, event)',
    check: () => findInTypes(['dsh-session'], /'session\/event'\(this:\s*Scoped<Session>,\s*session:\s*Session,\s*event:\s*SessionEvent\)/g).length > 0,
    evidence: 'dsh-session/lib/types/index.d.ts',
  },
  {
    what: 'agent/request-error 可返回 {kind:"retry"}',
    check: () => findInTypes(['dsh-agent'], /RequestErrorAction\s*=\s*\{\s*kind:\s*'retry'/g).length > 0,
    evidence: 'dsh-agent/lib/types/runtime-types.d.ts',
  },
  {
    what: 'session.snapshotEvents() / deriveMessages() 存在',
    check: () => findInTypes(['dsh-session'], /snapshotEvents\(/g).length > 0 && findInTypes(['dsh-session'], /deriveMessages\(/g).length > 0,
    evidence: 'dsh-session/lib/types/index.d.ts',
  },
  {
    what: 'ToolRunContext 继承 ToolExecution（含 agent 与 signal）',
    check: () => findInTypes(['dsh-tools'], /interface ToolRunContext extends ToolExecution/g).length > 0,
    evidence: 'dsh-tools/lib/types/index.d.ts',
  },
  {
    what: 'MessageSourceMap 的 kind 含 user/plugin/model/tool（我据 kind 分流镜像）',
    check: () =>
      ['user', 'plugin', 'model', 'tool'].every((k) =>
        // 用普通字符串而非模板字面量：模板里 `\s` 会被当成无效转义而退化成 `s`，
        // 正则便永远匹配不到（这个坑在本次审计里出现过）。
        findInTypes(['dsh-llm'], new RegExp("kind:\\s*'" + k + "'")).length > 0,
      ),
    evidence: 'dsh-llm/lib/types/message.d.ts MessageSourceMap',
  },
  {
    what: 'ContextForm 含 snapshot（宿主注入的快照语义）',
    check: () => findInTypes(['dsh-llm'], /\|\s*'snapshot'/).length > 0,
    evidence: 'dsh-llm/lib/types/message.d.ts ContextForm',
  },
  {
    what: 'ToolSchema 形状为 {name, description, parameters}',
    check: () => findInTypes(['dsh-llm'], /interface ToolSchema[\s\S]{0,300}?parameters:\s*Record<string,\s*unknown>/g).length > 0,
    evidence: 'dsh-llm/lib/types/types.d.ts',
  },
  {
    what: "ContentBlockMap 的块类型是 'tool-call' / 'tool-result'（连字符）",
    check: () =>
      findInTypes(['dsh-llm'], /'tool-call':\s*ToolCallBlock/).length > 0 &&
      findInTypes(['dsh-llm'], /'tool-result':\s*ToolResultBlock/).length > 0,
    evidence: 'dsh-llm/lib/types/types.d.ts ContentBlockMap',
  },
  {
    what: "ToolResultBlock 形如 {type:'tool-result', toolCallId, content: ContentBlock[]}",
    check: () =>
      findInTypes(['dsh-llm'], /type:\s*'tool-result';[\s\S]{0,160}?toolCallId:[\s\S]{0,80}?content:\s*ContentBlock\[\]/)
        .length > 0,
    evidence: 'dsh-llm/lib/types/types.d.ts ToolResultBlock',
  },
  {
    what: "ToolCallBlock 的参数是 arguments（原始 JSON 串），不是 input",
    check: () =>
      findInTypes(['dsh-llm'], /type:\s*'tool-call';[\s\S]{0,200}?arguments:\s*string/).length > 0,
    evidence: 'dsh-llm/lib/types/types.d.ts ToolCallBlock',
  },
  {
    what: "session 的 tool/result 事件负载在 message（不是 content）",
    check: () =>
      findInTypes(['dsh-session'], /'tool\/result':[\s\S]{0,200}?message:\s*ToolResultMessage/).length > 0,
    evidence: 'dsh-session/lib/types/types.d.ts SurfaceEventMap',
  },
  {
    what: 'StreamChunk 含 text-delta（我据此聚合文本）',
    check: () => findInTypes(['dsh-llm'], /type:\s*'text-delta'/g).length > 0,
    evidence: 'dsh-llm/lib/types/types.d.ts',
  },
  {
    what: 'tool-call-delta 携带的是 argumentsDelta（不是 argumentsText）',
    check: () =>
      findInTypes(['dsh-llm'], /type:\s*'tool-call-delta';[\s\S]{0,200}?argumentsDelta:\s*string/).length > 0,
    evidence: 'dsh-llm/lib/types/types.d.ts StreamChunk',
  },
  {
    what: "usage 与 finish 是**独立**的 chunk 类型（不挂在某个 done 上）",
    check: () =>
      findInTypes(['dsh-llm'], /type:\s*'usage';[\s\S]{0,80}?usage:\s*TokenUsage/).length > 0 &&
      findInTypes(['dsh-llm'], /type:\s*'finish';[\s\S]{0,120}?reason:\s*FinishReason/).length > 0,
    evidence: 'dsh-llm/lib/types/types.d.ts StreamChunk',
  },
  {
    what: 'TokenUsage 的字段是 camelCase（inputTokens / outputTokens）',
    check: () =>
      findInTypes(['dsh-llm'], /interface TokenUsage[\s\S]{0,200}?inputTokens:\s*number[\s\S]{0,80}?outputTokens:\s*number/)
        .length > 0,
    evidence: 'dsh-llm/lib/types/types.d.ts TokenUsage',
  },
  {
    what: "流里的块结束类型是 block-end（不是 block-stop）",
    check: () => findInTypes(['dsh-llm'], /type:\s*'block-end'/g).length > 0,
    evidence: 'dsh-llm/lib/types/types.d.ts StreamChunk',
  },
];

for (const c of contracts) {
  let passed = false;
  try {
    passed = c.check();
  } catch (err) {
    bad(`${c.what} —— 检查本身出错：${err.message}`);
    continue;
  }
  if (passed) ok(c.what);
  else bad(`${c.what}（依据：${c.evidence}）`);
}

// ---------------------------------------------------------------- C. 代码里的用法核对

console.log('\n═══ C. 代码中是否存在与契约不符的字段访问 ═══');
const srcFiles = [];
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.js')) srcFiles.push(p);
  }
};
walk('lib');

/**
 * 去掉注释后再匹配：注释里会**刻意写出**这些反模式（用于记录踩过的坑），
 * 若把注释算作违规，就会把"记录坑的文档"误判为缺陷。
 */
const stripComments = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const all = srcFiles.map((f) => ({ f, code: stripComments(fs.readFileSync(f, 'utf8')) }));

// —— 反向检查：不得出现已知的错误访问方式
//
// 精确到"变量"而不是"距离"：早期版本用 `requestHeader().*?\.provider` 这类窗口匹配，
// 会把**正确**的 `header?.config?.provider` 也一并报出（`config?.` 之后的 `.provider`
// 落在窗口里）。会误报正确代码的检查器与会漏检的检查器同样有害，故这里先识别
// `requestHeader` 被赋给了哪个标识符，再只查该标识符上的**直接**字段访问。
function findDirectHeaderFieldAccess(code) {
  const receivers = new Set();
  for (const m of code.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[\s\S]{0,40}?requestHeader\?/g)) {
    receivers.add(m[1]);
  }
  for (const m of code.matchAll(/([A-Za-z_$][\w$]*)\s*=\s*[\s\S]{0,40}?requestHeader\?/g)) {
    receivers.add(m[1]);
  }
  const bad = [];
  for (const r of receivers) {
    // 直接访问：R?.provider / R.model，且前面不是 config?. 或 config.
    const re = new RegExp(`(?<!config\\??\\.)\\b${r}\\??\\.\\s*(provider|model)\\b`, 'g');
    for (const m of code.matchAll(re)) bad.push(`${r}.${m[1]}`);
  }
  return bad;
}

const wrongHeader = [];
for (const { f, code } of all) {
  const hits = findDirectHeaderFieldAccess(code);
  if (hits.length) wrongHeader.push(`${f}（${[...new Set(hits)].join(', ')}）`);
}
if (wrongHeader.length) {
  bad(`直接读窗口头的 provider/model：${wrongHeader.join('; ')} —— 真实形状在 .config 之下`);
} else ok('未出现直接读窗口头 provider/model 的写法');

const wrongExec = all.filter(({ code }) => /exec\?\.session\b/.test(code));
if (wrongExec.length) {
  bad(`引用宿主不存在的 exec.session：${wrongExec.map((x) => x.f).join(', ')}`);
} else ok('未引用宿主不存在的 exec.session');

// —— 宿主流词汇：这一组是"凭猜测写宿主字段名"的守卫
//
// 真机教训：适配器里写的是 `chunk.argumentsText`，而宿主给的是 `argumentsDelta` ——
// 于是工具调用的参数**永远是空的**，每次 delta 都变成"空增量已应用"，
// 表面上一切正常、状态却从不积累。同理漏读独立的 usage/finish chunk 让用量与
// 结束原因恒为 null。假宿主（自己写的）永远测不出这类错，只有类型声明能证伪。
const wrongVocab = [
  { re: /argumentsText/, msg: 'argumentsText（宿主是 argumentsDelta）' },
  { re: /block-stop/, msg: "block-stop（宿主是 block-end）" },
  { re: /case\s*'(done|end)'\s*:/, msg: "case 'done'/'end'（宿主没有这两种 chunk 类型）" },
];
for (const { re, msg } of wrongVocab) {
  const hits = all.filter(({ code }) => re.test(code));
  if (hits.length) bad(`使用了宿主不存在的流词汇 ${msg}：${hits.map((x) => x.f).join(', ')}`);
  else ok(`未使用宿主不存在的流词汇 ${msg.split('（')[0]}`);
}

// 内容块词汇：这三个名字都曾被我猜错，且错了都是**静默丢内容**
const wrongBlocks = [
  { re: /case\s*'tool_use'\s*:/, msg: "case 'tool_use'（宿主是 'tool-call'）" },
  { re: /case\s*'tool_result'\s*:/, msg: "case 'tool_result'（宿主是 'tool-result'）" },
];
for (const { re, msg } of wrongBlocks) {
  const hits = all.filter(({ code }) => re.test(code));
  if (hits.length) bad(`使用了宿主不存在的内容块类型 ${msg}：${hits.map((x) => x.f).join(', ')}`);
  else ok(`未使用宿主不存在的内容块类型 ${msg.split('（')[0]}`);
}
const blockReader = all.find(({ f }) => f.endsWith(path.join('host', 'seams.js')));
if (!blockReader) bad('未找到 host/seams.js');
else {
  const need = [
    [/case\s*'tool-call'\s*:/, "'tool-call' 块"],
    [/case\s*'tool-result'\s*:/, "'tool-result' 块"],
    [/data\.message\?\.content[\s\S]{0,80}data\.content/, 'assistant/tool 事件从 data.message 取内容'],
  ];
  const missing = need.filter(([re]) => !re.test(blockReader.code)).map(([, m]) => m);
  missing.length
    ? bad(`host/seams.js 未按宿主词汇处理内容块：${missing.join('、')}`)
    : ok("host/seams.js 按 ContentBlockMap 处理内容块（tool-call / tool-result）");
}

// 正向：适配器必须真的按宿主词汇取值（只查"没有错"会漏掉"根本没读"）
const adapter = all.find(({ f }) => f.endsWith(path.join('host', 'llm.js')));
const adapterNeeds = [
  [/chunk\.argumentsDelta/, 'tool-call-delta 的参数增量'],
  [/case\s*'usage'/, 'usage chunk'],
  [/case\s*'finish'/, 'finish chunk'],
  [/u\.inputTokens/, 'TokenUsage 的 camelCase 字段'],
];
if (!adapter) bad('未找到 host/llm.js 适配器');
else {
  const missing = adapterNeeds.filter(([re]) => !re.test(adapter.code)).map(([, m]) => m);
  missing.length ? bad(`host/llm.js 未按宿主词汇取值：${missing.join('、')}`) : ok('host/llm.js 按宿主词汇取值（argumentsDelta / usage / finish / inputTokens）');
}

// —— 正向检查：必须真的用了正确写法（只查"没有错"会漏掉"根本没做"）
const usesConfigHeader = all.filter(({ code }) => /header\?\.config\?\.(provider|model)/.test(code));
usesConfigHeader.length
  ? ok(`窗口解析读的是 header.config：${usesConfigHeader.map((x) => x.f).join(', ')}`)
  : bad('没有任何地方从 header.config 取路由 —— 窗口解析可能永远走配置回退');

const sessionAccessors = all.filter(({ code, f }) => f.includes('tools') && /sessionIdOf|agent\?\.session/.test(code));
sessionAccessors.length
  ? ok(`工具经 agent.session 取会话：${sessionAccessors.length} 个文件`)
  : bad('工具未体现经 agent.session 取会话的写法');

console.log('\n═══ D. 文档化的调用参数能否通过宿主编译后的 schema ═══');
//
// 这是本审计最有价值的一段：宿主 defineTool 会把参数规格编译成 JSON Schema，
// 并在真实派发时按它校验参数。因此"提示词里写的调用示例"必须能被该 schema 接受 ——
// 否则模型照着提示词调用就会被拒（真机上已发生过一次：next_action: null）。
if (defineToolReal && fs.existsSync(path.join(PKG_ROOT, 'dsh-tools'))) {
  let Ajv = null;
  try {
    Ajv = require('ajv');
  } catch {
    console.log('  跳过：未找到 ajv，无法做参数级校验');
  }
  if (Ajv) {
    const ajv = new Ajv({ strict: false, allErrors: true });
    const { deltaParametersSpec } = await import('../lib/tools/commit_state.js');
    const { DELTA_TOOL } = await import('../lib/llm/prompts.js');

    /** 编译一个工具并返回其参数 JSON Schema。 */
    const compileParams = (name, parameters) =>
      defineToolReal({
        name,
        description: 'audit',
        parameters,
        output: {
          schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, result: { type: 'string', required: true } } },
          render: () => [{ type: 'text', text: 'x' }],
        },
        async execute() { return { ok: true, result: 'x' }; },
      }).parameters;

    const check = (label, schema, payload, expectValid) => {
      const validate = ajv.compile(schema);
      const valid = validate(payload);
      if (valid === expectValid) ok(`${label} —— ${expectValid ? '接受' : '拒绝'}（符合预期）`);
      else {
        bad(
          `${label} —— 期望${expectValid ? '接受' : '拒绝'}，实际${valid ? '接受' : '拒绝'}` +
            (valid ? '' : `：${ajv.errorsText(validate.errors)}`),
        );
      }
    };

    // 提示词里明写的空增量（含 next_action: null）——曾被宿主拒绝
    const EMPTY_DELTA = { upsert: [], supersede: [], resolve: [], open: [], next_action: null };
    const deltaSchema = compileParams('audit_commit_state', deltaParametersSpec());
    check('DELTA_SYSTEM 文档化的空增量', deltaSchema, EMPTY_DELTA, true);
    check(
      '省略 next_action 的增量',
      deltaSchema,
      { upsert: [], supersede: [], resolve: [], open: [] },
      true,
    );
    check(
      '含 null key 与任意 JSON value 的增量',
      deltaSchema,
      {
        upsert: [{ type: 'constraint', key: null, value: { nested: [1, 2] }, source_event_ids: ['evt_1'] }],
        supersede: [{ state_id: 'st_1', reason: 'r' }],
        resolve: ['st_2'],
        open: [],
        next_action: '下一步',
      },
      true,
    );
    check(
      '缺 value 的 upsert（应被拒）',
      deltaSchema,
      { upsert: [{ type: 'fact', key: 'k' }], supersede: [], resolve: [], open: [], next_action: null },
      false,
    );
    check(
      '未知 item_type（应被拒）',
      deltaSchema,
      { upsert: [{ type: 'nonsense', value: 1 }], supersede: [], resolve: [], open: [], next_action: null },
      false,
    );

    // 字段集必须与提示词里的 JSON schema 一致（防止派生时静默丢字段）
    const derived = new Set(Object.keys(deltaSchema.properties ?? {}));
    const documented = new Set(Object.keys(DELTA_TOOL.parameters.properties ?? {}));
    const missing = [...documented].filter((k) => !derived.has(k));
    const extra = [...derived].filter((k) => !documented.has(k));
    missing.length === 0 && extra.length === 0
      ? ok(`工具参数字段集与提示词一致（${derived.size} 个字段）`)
      : bad(`参数字段集不一致：缺 ${missing.join(',') || '无'}；多 ${extra.join(',') || '无'}`);

    // 记录一个已知的宿主行为：参数对象不设 additionalProperties，
    // 因此拼错/外来的参数名会被**静默忽略**（dsh-computer-use 也踩过同一个坑）。
    const strayAccepted = ajv.compile(deltaSchema)({ ...EMPTY_DELTA, bogus_field: 1 });
    console.log(
      strayAccepted
        ? '  注意：宿主参数 schema 不含 additionalProperties，未知参数名会被静默忽略 ——' +
            '因此每个工具的 execute 都 MUST 自行校验不需要的输入'
        : '  未知参数名会被宿主拒绝',
    );
  }
}

console.log(`\n═══ 结论 ═══`);
console.log(failures === 0 ? '  全部契约核对通过' : `  ${failures} 项不符，见上方 FAIL`);
process.exit(failures === 0 ? 0 : 1);