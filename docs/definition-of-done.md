# Definition of Done 核对（规范 §29）

逐条对照规范 §29 的 14 项完成条件，给出**可复跑的**证据。命令统一为：

```bash
npm test                        # 193 项审计与验收测试
npm run audit:host              # 宿主契约实机审计（需本机安装 DSH）
node benchmark/verify-spec.mjs  # 规范数值不变量与陈旧数值终检
```

| # | §29 完成条件 | 状态 | 证据 |
|---|---|---|---|
| 1 | 原始事件 append-only 且可持久恢复 | ✅ | `storage.test.mjs`「append-only：store 不暴露任何修改或删除原 content 的接口」；`acceptance.phase-a.test.mjs`「崩溃后状态与原日志可恢复」；`phase-d.test.mjs`「崩溃后索引可重建、状态可恢复」 |
| 2 | 1M token synthetic history 可正常存储与检索 | ✅ | `acceptance.1m.test.mjs`：**5055 事件 / 1,043,637 token**，构建 679ms，检索与扫描全程可用 |
| 3 | 早期精确数字/ID 可从 raw evidence 追溯 | ✅ | `acceptance.1m.test.mjs`：200 个探针（100 数字约束 + 100 编号）**Exact identifier recall = 100.0%**（阈值 ≥99%）；相似但不同的参数（1064.00/1064.01/1064.10/1064.11nm）正确项均排首位 |
| 4 | superseded decision 不会作为当前 state 使用 | ✅ | `acceptance.1m.test.mjs`：50 组决定 **active-vs-superseded 正确率 = 100%**（阈值 ≥99%）；`storage.test.mjs`「同 key 变更产生新版本并 supersede 旧版本」 |
| 5 | normal context 不超过 hard cap | ✅ | `config.test.mjs`「§9.6 两条硬断言」「W=262144 下派生预算与规范 §9.1 参考值一致」；`context.test.mjs`「估计输入超硬上限时抛错」；`acceptance.1m.test.mjs`：LOCAL/BROAD/GLOBAL 三模式均 ≤ hard cap |
| 6 | episode summary 失败不会破坏主对话 | ✅ | `phase-b.test.mjs`「摘要失败：保持 summary_pending，原始事件不受影响」「摘要重试：上游恢复后 pending 转为 summarized」 |
| 7 | embedding 关闭时系统仍可工作 | ✅ | `retrieval-strategy.test.mjs`「embedding 缺失是默认状态：权重重归一化，不新增分支、不降功能」；`acceptance.1m.test.mjs` 的 §22.3 断言：端口抛错后状态 **ok → degraded**、关键词检索不受影响、失败分量退出打分 |
| 8 | GLOBAL 模式覆盖完整 scope 并验证 coverage | ✅ | `phase-c.test.mjs`「多块并行、覆盖完整」「单块失败 → coverage 不完整，且不掩盖」「worker 自报范围错误 → 记为缺口」；`acceptance.1m.test.mjs`：**coverage 14/14 = 100%**，GLOBAL 编译 `reason=exhaustive_scan` |
| 9 | worker 输出受限且 reducer 可正确合并 | ✅ | `phase-c.test.mjs`「worker 输出受限：每次调用都带 config 中的硬上限」（默认 300 / complex 500）「findings 去重，冲突双方均保留」；`acceptance.1m.test.mjs`：**finding recall = 100%**（阈值 ≥98%） |
| 10 | state delta schema validation 完整 | ✅ | `schemas.test.mjs`（12 项）逐条覆盖**四类失败**：JSON 语法错误（含夹带文字/代码围栏/嵌套花括号）、字段缺失、类型错误、幻觉字段；`delta.test.mjs`（8 项）覆盖来源校验、无依据取代约束、冲突转 uncertain |
| 11 | crash 后可恢复 | ✅ | 同第 1 项；另 `phase-d.test.mjs`「崩溃后索引可重建、状态可恢复、审计无 dangling」 |
| 12 | benchmark 已完成并生成推荐参数 | ✅ | `benchmark/benchmark_report.json`（实测：TPS 中位 9.855、并发 n=4 达 27.899 TPS）+ `preflight-limit.json`（预检系数 1.693、实测可服务 0.5601W）；`benchmark/rebuild-report.mjs` 做**确定性合并重算**（无上游调用）；`autotune.test.mjs` 验证报告 → 比例式配置覆盖（含夹取与 §9.1/§9.2 级联） |
| 13 | 所有关键 memory 均具有 source provenance | ✅ | `acceptance.1m.test.mjs`：`countWithoutProvenance = 0`；证据 **traceable 115/115 = 100%**；`storage.test.mjs`「无 source 的项不得成为 active」 |
| 14 | README 含启动、配置、测试、重建步骤 | ✅ | `README.md` 的「安装与启用 / 配置 / 测试 / 重建」四节；本文件与 `docs/store-evidence.md` 为补充证据 |

## 补充：§8.3「否决项不得重新推荐」的保证方式

`rejected` 与「每个键最新一次 `superseded`」构成一份**非 active 状态清单**，随上下文注入
（规范 §9.2.1，费用计入 `authoritative_state` 组件，限幅 35% / 最多 12 条）。这使得
"不得重新推荐已否决方案"从"state 里恰好没有它"升级为"明确告知已被否决"。
覆盖测试：`tests/context.test.mjs`「非 active 清单进入上下文」「非 active 清单受预算限幅」。


## 补充：实机测试审计（2026-09-17）

此前所有验证都跑在**假宿主**上，宿主接口是照类型声明假设的。本轮补了实机审计，
共三层，逐层加深：

### 第 1 层：宿主契约审计（`npm run audit:host`）

- **A 段**：用宿主**真实的 `defineTool`** 编译我们全部 8 个工具定义 —— 假宿主只做透传，
  永远发现不了 schema 形状错误（宿主还会校验 `additionalProperties` 必须显式声明）。
- **B 段**：逐条核对我在代码里调用的 16 个宿主成员是否真实存在、字段名是否与假设一致。
- **C 段**：反向检查代码里是否出现已知的错误访问方式（含注释剥离，避免把"记录坑的文档"误判为缺陷）。
- **D 段**：用 ajv 把**提示词里文档化的调用参数**拿去校验宿主编译后的 schema。

### 第 2 层：真实 DSH 进程加载（`dsh --profile headless --patch <probe.yml>`）

插件装入 `headless` profile 的 node_modules，用一次性叠加层插入（与 `_probe-surface.yml` 同约定），
`--dump-config` 先确认补丁合成，再跑真实一轮。证据：

- 插件随宿主启动成功，探针指定的 `dbPath`（`$DSH_HOME/_scratch/cvm-audit.db`）被建立（167KB）；
- 迁移 v1 应用，11 张表建成（raw_events / raw_fts 及其影子表 / state_items / episodes / artifacts / kv）；
- 真实会话事件被镜像入索引且 FTS 行数一致；`episodes` 出现 1 条（轮末缝确实跑了）。

### 第 3 层：实机抓到的三个真缺陷（假宿主全都没测出）

| # | 缺陷 | 为何假宿主测不出 | 修法 |
|---|---|---|---|
| 1 | 提示词要求空增量写 `next_action: null`，但工具 schema 写的是 `{type:'string'}`，模型照提示词调用被**宿主参数校验拒绝**（`invalid arguments: "next_action" must be a string`） | 假 `defineTool` 只透传，从不校验参数 | 参数规格改为**从提示词的 JSON schema 派生**（`lib/tools/spec.js`），并加 D 段守卫 |
| 2 | 窗口解析读 `requestHeader().provider`，而 `EpochHeader` 的真实字段在 `.config` 之下 —— 永远取不到值，静默回退到插件配置路由，**会话跑在别的模型上时预算就算错了** | 假 session 的 `requestHeader()` 返回的是我臆想的形状 | 改读 `header?.config?.provider/model`，并加 C 段守卫 |
| 3 | 宿主注入的合成上下文（`Current runtime context` 快照、`<system-reminder>` 技能目录）被记成 `user_message`，以最高 authority 参与打分并挤占 recent verbatim 预算 | 假事件没有 `source.kind` 字段 | 反转判定：只有 `kind === 'user'` 才算用户消息（§4.1） |

第 3 项还有一个二阶发现：`<system-reminder>` 的 `source.kind` 是 **`skill-catalog`** ——
一个我此前不知道的 kind。宿主文档写明 kind 词汇表是 **merge-extensible** 的（插件可自行登记），
因此**白名单写法注定落后**，必须反过来判定。实测该轮镜像结果：用户输入 **5 token**，
宿主样板 **1,206 token** 全部归为 `system_note`（比值 240:1）。

### 每个守卫都做了阳性对照

新加的守卫都用"故意植入原缺陷"验证过确实会失败（D 段重现了实机那条错误原文，
C 段与隐私守卫同样验证），避免"看起来在检查、实际永远通过"。

## 补充：交互审计 —— 用户能不能方便地用（2026-09-17）

前三层回答的是"插件能不能在真机上跑对"，这一层回答"人能不能装、能不能看出它在工作"。
走的是**用户路径**（`dsh plugin add` + 直接跑，不带 patch、不带配置），不是开发者路径。
抓到 7 个问题，其中 2 个是会让用户直接失去核心功能的真缺陷。

| # | 问题 | 用户会看到什么 | 修法 |
|---|---|---|---|
| 1 | **零配置不落盘**：`opts.dbPath ?? config.dbPath ?? ':memory:'`，而默认配置就是 `dbPath: null` → `null ?? ':memory:'` 得到内存库 | 文档推荐的零配置用法**重启即丢失全部状态**（authoritative state / episode 摘要 / artifact 都来自模型 delta，无法从宿主 session log 重建） | `null` 与 `undefined` 都走 `defaultDbPath()`；`':memory:'` 需显式写。`interaction.test.mjs` 覆盖 |
| 2 | **诊断说谎**：调用方读 `r.warnings`，而 `registerTool` 只返回 `{registered}` → 每次挂载抛 `r.warnings is not iterable`，被 catch 吞成"未注册状态提交工具" | 8 个工具**全部注册成功**，日志却报降级。诊断说谎比没有诊断更坏 | `registerTool` 回传**本次**新增的 warnings；补契约测试（含成功路径不得有告警的阳性对照） |
| 3 | **人对插件完全不可见**：工具面向模型、遥测只在内存、`ctx.logger` 在 headless 与 web 都不落任何用户可读的地方（同一次运行里其他插件用 `console` 打的日志出现在 `web-latest.err.log` 与 headless 的 stderr） | 装完了不知道有没有生效、库在哪、注入有没有发生 | 诊断走 **stderr** 并带 `[contextvm]` 前缀（不用 stdout：headless 把 stdout 当"最终回答"的通道）；挂载时打印库路径与工具数；新增 **`/contextvm`** 命令 |
| 4 | **待处理队列跨会话卡死**：队列是全局的且现在真的持久化，上一进程遗留的条目会在下次运行被取出，而其会话已结束 → `window()` 按设计抛错 → `flushPendingDeltas` 整体抛出，连 `kvSet(remain)` 都到不了 | "第一次失败之后，状态就再也不更新了"（当前会话的 delta 永远排不上队） | `prunePending()` 剪掉"会话已结束 / 重试超限"的条目并如实上报 + 每条**独立容错** + 重试上限 5 次。3 个新测试在注入原缺陷后**全部失败**（变异测试验证） |
| 5 | delta 反复 `unparseable` | 状态长期不积累 | 真相不是解析器：union-alpha **偶发返回完全空的响应**（实测 683ms、`text_chars:0`、无 tool call、无 usage、`stopReason` 为 null），重试后 7.8s 返回 70 字符并成功应用。遥测加 `text_chars` 以区分"模型什么都没回"与"回了非 JSON" |
| 6 | `编译统计: 0 次（）` | 空括号，像是渲染坏了 | `by_mode` 为空时不渲染括号；加断言禁止空括号 |
| 7 | `待处理状态增量: 1 条` 不解释来源 | 非零数字让人以为卡住了 | 标明其中多少条属于**已结束的会话**（下次维护清理，raw 事件仍可检索） |

两条与安装方式有关的实地结论：

- `dsh plugin --profile headless add "github:orangeofcarl0-sys/dsh-contextvm"` **一条命令可用**（13.4s），
  宿主会自动把本包登记进该 profile 的 `dsh.profile.bundles`；
- 因此**不要**再用 `--patch` 以 `insert` 方式插同一个 id —— 宿主报
  `duplicate loader entry id: dsh-contextvm` 并拒绝启动插件树。二者二选一（已写入 README）。

另外记一条宿主的边界，以免下次误判为插件缺陷：`headless` 是"回答一个任务就退出"的
一次性应用，它把参数当提示词，**不**解析 `/contextvm` 这类斜杠命令（实测该字符串被原样发给模型，
模型于是自己去读仓库、跑测试并汇报）。命令入口属于 `tui` / `web` 这类交互 profile；
`/contextvm` 的注册在本机有真机证据 —— 挂载日志那行只在 `commands.register` 未抛错时才打印。

## 补充：交互审计的后续 —— 目标模型上的核心缺陷（2026-09-17 续）

交互审计修完显性缺陷后，delta 仍在真机上反复 `unparseable`。深挖下去发现这**不是**交互问题，
而是**针对目标模型的核心功能缺陷**，且全部是静默失效：

| # | 缺陷 | 为何一直没被发现 | 修法 |
|---|---|---|---|
| 1 | **输出预算被推理耗尽**：目标模型回传推理，推理计入输出上限。`max_tokens=500` 时实测 `output_tokens=500`、正文 **0 字**、`finish=max-tokens` —— delta 永远抽不出内容 | 假宿主不产生推理；"unparseable" 的命名把成因指向了错误的解析器 | 上限提到覆盖"推理开销 + 目标正文"：`state_delta` 500/800 → **1500/2000**、worker 300/500 → **1000/1500**、摘要 1600 → **2400**。实测同一任务两次成功（用量 316/672），**耗时从 17s 降到 4.2s** |
| 2 | **工具调用参数恒为空**：适配器读 `chunk.argumentsText`，宿主给的是 **`argumentsDelta`** | 假宿主是我自己写的，喂的正是我臆想的字段名 —— 测试通过得毫无意义 | 按宿主类型声明改用 `argumentsDelta`，并加**反向守卫**（代码里出现 `argumentsText` / `block-stop` / `case 'done'` 即 FAIL）与**正向守卫**（适配器必须按宿主词汇取值） |
| 3 | **用量与结束原因恒为 null**：`usage` 与 `finish` 是**独立 chunk 类型**，我假设它们挂在某个 `done` 上；且 `TokenUsage` 字段是 camelCase（`inputTokens`），我读的是 `input_tokens` | 同上：假宿主按我的臆想实现。代价是 §9.6 的真实 usage 标定从未拿到过数据 | 显式处理 `usage` / `finish`；端口对外统一 snake_case，**转换只在 `lib/host/llm.js` 一处** |
| 4 | **读了一个不存在的配置键**：`maxTokensFor('episode_summary')` 读 `output.episode_summary_hard_max_tokens`，而该键在实现里叫 `episode.summary_hard_max_tokens` → 返回 `undefined` | "跑得通"的测试不会暴露 undefined 上限 | 改为读 `episode.summary_hard_max_tokens`；删除死配置 `global_scan.worker_output_max_tokens`；新增**配置键访问守卫**测试（代码里读的每个配置键都必须在 `DEFAULTS` 中存在） |
| 5 | **未识别的流 chunk 被静默丢弃** | 无 | 未识别类型 MUST 上报（日志 + 遥测）。真机上正是这条立刻点出了 `usage, finish` |

第 1 项的诊断也一并改到位：`max-tokens` 且正文为空时上报 **`delta_budget_exhausted`**（含"请调大
哪一项"的提示），与"上游偶发空响应"的 `delta_unparseable` 分开 —— 前者重试无用，故不入队，
避免在慢模型上白烧 5 次调用。

失败分类也补全了：辅助调用的失败按宿主的 finish reason 逐类上报 ——
`error`（上游报错，带 `code`/`status`/`message` 与 `providerRetryAfterMs`）→ 入队重试；
`aborted`（我们自己中止）→ 不入队；`max-tokens` + 正文空 → 预算耗尽，不入队并指出该调哪一项；
其余 → 偶发空响应，入队。此前这四种都被笼统叫 `unparseable`，把成因指向了错误的解析器。

**观察优先于猜测**：宿主 `GenerateOptions` 里确实有 `reasoningEffort`，看起来是对症旋钮，
于是先把解析到的模型信息打出来 —— 结果该路由**不暴露任何推理档位**（`reasoning.efforts` 为空），
这个旋钮根本用不上。若不看数据直接实现，就会写出一个静默无效的"优化"。
同一处还发现：**挂载期探测配置的回退路由会打出假警报**（挂载时适配器尚未注册，
`resolveModelInfo` 抛 `no adapter registered for provider ...`，而同一路由在会话期解析正常），
故该探测已撤除，改为在真实路由首次解析时逐路由记录窗口与档位。

两个守卫都做了**变异验证**：植入 `argumentsText` + `input_tokens` 后 B/C 段同时 FAIL；
植入错键名后配置键守卫 FAIL。其中配置键守卫的第一版还自带一个 bug ——
模板字符串里的 `` 是**退格字符**而非词边界，导致别名检查永远匹配不到任何东西；
**是阳性对照把它抓出来的**（主断言全绿而植入的错键名未被报出）。

规范同步升到 **v1.4**：新增变更摘要 16–19、§21.7.1「宿主流契约」（chunk 词汇表与字段名，
含"MUST NOT 凭记忆或凭假宿主推断"）、§1.3 澄清"不依赖 CoT ≠ 不会遇到推理"，
并把 §17.1 的输出上限清单改为**标注落点**以消除规范与实现的命名不一致。
`benchmark/verify-spec.mjs` 新增**规范↔实现交叉核对**：直接读 `DEFAULTS` 逐项比对，
而不是在脚本里再抄一遍数字（抄一遍就等于又开了一个来源）。

## 补充：本轮结构优化（代码审计驱动）

审计工具与结论见 `tools/code-audit.mjs` / `tools/dead-code-check.mjs`。已完成的拆分：

| 函数 | 拆分前 | 拆分后 | 拆法 |
|---|---|---|---|
| `Compiler.compile` | 196 行 / 11 件事 | **46 行** | 10 个 `_collectXxx` 采集器 + `_buildItems` + `_render` |
| `applySeams` | 165 行 | 注册层 + **5 个工厂** | 每条宿主缝一个工厂，共享 `seam` 状态对象 |
| `memoryTools` | 162 行 | **82 行** | 定义表 + 6 个 `runXxx` 实现 |
| `auditState` | 116 行 | **29 行** | 4 个可单独测试的 `checkXxx`（返回形状统一） |
| `applyDelta` | 102 行 | **19 行** | 4 个 `applyXxx` 操作函数，共享记账 `ctx` |
| `createLlmPort` | 113 行 / 嵌套 7 | 构造请求 + **`aggregateStream`** | 流聚合单独成函数 |
| `Retriever.candidates` | 98 行 | **`_gatherCandidates` + `_scoreCandidate`** | 采集与打分分离 |
| `parseJsonLoose` | 嵌套 9 | **`scanBalancedJson`** | 字符级状态机单独成函数 |

同时清理：10 个死导出（删 4 组、接线 4 组：非 active 清单、mode 校验、`MEMORY_TOOL_NAMES`
契约、`schemaVersion`）；工具输出 schema 3 处重复合并为 `lib/tools/output.js`；
11 个基准脚本的样板与 6 份 `genFiller` 合并为 `benchmark/shared/fixtures.mjs`；
删除 `router`/`reranker` 死配置。

## §24.3 目标指标实测

| 指标 | 目标 | 实测 |
|---|---|---|
| Exact identifier recall @ 1M history | ≥ 99% | **100.0%** |
| Active-vs-superseded state correctness | ≥ 99% | **100.0%** |
| Global exhaustive scan coverage | = 100% | **100%**（14/14 块） |
| Global finding recall on synthetic set | ≥ 98% | **100.0%** |
| Raw-source traceability | = 100% | **100%**（115/115） |
| State item with valid provenance | = 100% | **100%** |
| Normal context ≤ configured hard cap | = 100% | **100%**（三种模式） |
| Recovery from semantic index failure | pass | **pass**（status → degraded，关键词不受影响） |
| Recovery from summary failure | pass | **pass**（pending 可重试，主对话不受影响） |

## 有意未实现的部分（并说明理由）

1. **LLM 路由器与 LLM 重排器**：规范 v1.0 为其预留了输出预算，但模式分类（§8）与检索打分（§7.1）
   在本实现中都是确定性的，不发起模型调用。加 LLM 调用恰好违反 §2.2（优先减少串行生成 token），
   因此相应预算已从配置中移除，并在规范 §17.1 记录该决定。
2. **embedding 提供方**：按 §7.1.1/§7.1.2 降级为**可选分量**（权重 0.10），端口就位、缺失自动重归一化、
   失败自动转 degraded。摘要检索承担了"换个说法也能召回"的主要收益，零额外依赖。
3. **artifact 正文字节读取**：规范 §4.4 要求"用 artifact/version 而不是把整个对象塞进 state"，
   本实现存引用与摘要并暴露 uri；读取工作区文件属宿主文件能力，插件不越界（`fetch_artifact` 的返回里明确说明）。
4. ~~**真实 DSH 进程内运行**~~（**已实现，保留此条仅为记录**）：本机已有 DSH，
   实机审计见上文"实机测试审计"与"交互审计"两节 —— 插件在真实 `headless` profile 中加载、
   8 个工具经宿主真 `defineTool` 注册成功、真实会话事件被镜像入索引、delta 抽取与应用跑通。
   假宿主测试仍是日常回归的主力（`boot.smoke.test.mjs`：apply → 五条宿主缝 → 编译 → delta →
   episode → 维护 → 拆解），因为 CI 环境没有宿主进程。
