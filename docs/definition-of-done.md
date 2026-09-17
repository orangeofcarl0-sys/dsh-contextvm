# Definition of Done 核对（规范 §29）

逐条对照规范 §29 的 14 项完成条件，给出**可复跑的**证据。命令统一为：

```bash
npm test                        # 211 项审计与验收测试
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
| 1 | **输出预算被隐藏推理耗尽**：目标模型有一部分生成既不流式送出、也不计入 `reasoning_tokens`，却计入 `output_tokens`（实测差额 300–1658，方差大）。`max_tokens=500` 时整份预算被吃光：正文 **0 字**、`finish=max-tokens`、流里只剩 `usage`+`finish` —— delta 永远抽不出内容 | 假宿主不产生推理；§2.1.1 曾把"看不见 CoT"读成"没有推理开销"；"unparseable" 的命名把成因指向了错误的解析器 | 上限改为覆盖"隐藏推理开销 + 目标正文"并留方差余量：`state_delta` 500/800 → **3000/4000**、worker 300/500 → **1000/1500**、摘要 1600 → **2400**。上游 `max_completion_tokens=131072`、`default_parameters` 为空，小上限纯属本项目假设所致 |
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

`maxTokensFor` 也修了一处同类问题：它此前是 `if (override) return override` ——
调用方传多少就发多少，配置里的 `*_hard_max_tokens` **没有任何消费者**（与已删的
`global_scan.worker_output_max_tokens` 同类死字段）。现改为 `min(请求值, 硬上限)`，
并删除从未被提示词或代码表达过的 `state_delta_target_tokens`。

两个守卫都做了**变异验证**：植入 `argumentsText` + `input_tokens` 后 B/C 段同时 FAIL；
植入错键名后配置键守卫 FAIL。其中配置键守卫的第一版还自带一个 bug ——
模板字符串里的 `` 是**退格字符**而非词边界，导致别名检查永远匹配不到任何东西；
**是阳性对照把它抓出来的**（主断言全绿而植入的错键名未被报出）。

规范同步升到 **v1.4**：新增变更摘要 16–19、§21.7.1「宿主流契约」（chunk 词汇表与字段名，
含"MUST NOT 凭记忆或凭假宿主推断"）、§1.3 澄清"不依赖 CoT ≠ 不会遇到推理"，
并把 §17.1 的输出上限清单改为**标注落点**以消除规范与实现的命名不一致。
`benchmark/verify-spec.mjs` 新增**规范↔实现交叉核对**：直接读 `DEFAULTS` 逐项比对，
而不是在脚本里再抄一遍数字（抄一遍就等于又开了一个来源）。

## 补充：第二次交互测试 —— 注入质量（2026-09-17 续二）

再次按用户路径实测（三步任务同时压写入与读取路径），**核心闭环这次是活的**：

- 写入：查库确认 `[active] constraint laser_wavelength` 落库，**provenance 指向用户消息**
  （约束的真正出处），`state_delta` 事件可追溯，待处理队列 0；
- 读取：编译该会话，约束确实出现在 `Active constraints` 段；
- 工具：模型调用 `search_memory("1064")` 并引用真实命中原文，还如实指出该命中就是它自己的指令；
- 模型自述与库一致（这次不是空话）。

但注入质量暴露了真问题 —— **注入的 5860 token 里只有 31 token 是权威状态**：

| 注入段 | 改前 | 改后 |
|---|---|---|
| Recent verbatim | 2894 | **58** |
| Retrieved evidence | 2912 | **76** |
| Active constraints + facts | 31 | 31 |
| Output contract | 23 | 23 |
| **合计** | **5860** | **188** |

根因：§4.1 那次修复只解决了**分类**（不冒充用户消息、authority 正确），没解决**是否注入**。
本会话镜像内容的 **98% 是宿主托管上下文**（运行时快照三条共 7491 token + 技能目录 483 token），
而它们照样进 recent、照样参与证据打分，于是榜首证据（0.871）的来源事件是
「技能目录 + 运行时快照 + 本插件自己的 `state_delta`」——完全不含对话内容。

修法（§4.1.1，判定唯一实现在 `lib/core/injectability.js`）：宿主托管上下文
（`form ∈ {snapshot, catalog}` 或 `kind ∈ {plugin, skill-catalog}`）与自身记账事件
（`state_delta`）**进索引、不进注入**，三处都拦：recent verbatim、检索候选、§7.3 邻居扩展。
判定方向是**黑名单**（与 §4.1 的反转判定相反）：误注入只是浪费有界预算，误丢真实内容
则是静默丢失，故未知形态一律按可注入处理。跳过数量可观测
（`notes.skippedNonContent` / `notes.excludedNonContent`）。

中间试过一版"只降权不排除"（系数 0.2）：排序对了（真实内容 0.732 / 0.495 排在样板 0.174 之前），
但**注入量仍有 3024 token** —— 因为邻居扩展会把 19245 字符的快照拖进证据束。
实测证明降权不够，才改成排除；随之变死的 `retrieval.host_context_penalty` 一并删除。

4 项新测试均经**变异验证**（判定恒为 content / 取消邻居过滤 / 取消降权，均 FAIL）。

## 补充：两个状态层缺陷（2026-09-17 续三）

第二次交互测试的验证环节又挖出两个问题，都是**真机才有、假宿主测不出**的：

| # | 缺陷 | 为何没被发现 | 修法 |
|---|---|---|---|
| 1 | **`next_action` 会累积且零 provenance**：以 `key: null`（null key 不参与版本链）＋ `sourceEventIds: []` 落库 → 每轮新增一条 active、旧版永不取代；真机实测同一句话两条，且 `countWithoutProvenance = 2`（§24.3 要求 0） | **验收语料从不包含 `next_action`**，那条 provenance 断言一直是空转的 —— 指标绿得毫无意义 | 稳定 key `current`（版本链自动取代）＋ provenance 取本轮候选事件 id（先剔除宿主托管上下文）＋ 无来源即拒收（`next_action_without_source`）＋ 自愈清理遗留的 null key 项（`next_action_replaced`）；验收语料改为**包含** `next_action`，让该断言真正覆盖此路径 |
| 2 | **宿主样板被抽取成"项目事实"**：模型把宿主注入的运行时上下文（文件沙箱策略、审批策略）记为 durable fact，来源指向宿主快照（`kind=plugin form=snapshot`），随后又被当作权威事实注入 —— 宿主样板绕成自指环 | 注入侧排除挡不住它：它进的是**宿主的**提示词 | 在状态写入边界复用同一判定：一条 upsert/open 的来源若**全部**是宿主托管上下文或自身记账事件，MUST 被拒（`source_is_host_context`）；混引时以内容为准。提示词另加劝阻，但**结构校验才是保证** |

顺带消除一处重复定义：`NEEDS_SOURCE` 列表原本在 `state_store.js` 与 `delta.js` 各有一份
（注释写着"与 state_store 一致"），两份一旦漂移就会出现"编排层拦、存储层放行"的静默缺口。
现由 `state_store.js` 导出唯一一份，并把 `next_action` 纳入。

5 项测试在变异下全部失败（旧语义 + 取消来源拒绝 + 移除存储层强制），还原后全过。

真机验证（同一用户库）：
- 新会话：`countWithoutProvenance = 0`、`next_action` 带 content 来源且只有一条、
  宿主样板来源的 fact **0 条**（此前 2 条）；
- 遗留会话：`applyDelta` 自愈取代 2 条 null key 项（`next_action_replaced`），
  `countWithoutProvenance` 由 2 回到 0；
- 遗留污染：新增的第 5 项审计检查发现 2 条 `source_is_host_context`，开启安全修复后
  降级为 `uncertain`（条目总数 6 不变，**未删除任何项**），该会话重新编译后
  `Active decisions / facts` 为空、注入量 123 token。

**顺带发现规范自己跟自己不一致**：§17.1 有两个陈述处（摘要块与 `absolute` 清单），
摘要块长期停在旧值（`soft 500 / hard 800`、`EPISODE_SUMMARY_MAX 1600`、
`GLOBAL_WORKER_MAX_OUTPUT 300`），而 verify-spec 的逐项核对只认 `absolute` 清单的格式
—— 于是这处不一致整整漏过一轮。已对齐，并给 verify-spec 增加"陈旧写法"守卫
（植入旧值即 3 项 FAIL）。

## 补充：dsh web 交互审计 + 长对话/压缩干扰（2026-09-17 续四）

### 命令在 web 里根本不可用（真机缺陷）

web profile 里装好插件后，**指令菜单里没有 `contextvm`**；输入 `/contextvm` 回车会被当成
**普通消息发给模型**（会话列表出现"进行中 /contextvm"，对话区显示"系统提示词 /contextvm …
深度求索中"）。而其他插件的命令（fresh / goal / compact / room …）在同一菜单里正常工作。

根因：注册用了 `ctx.get('commands')` —— 拿到的是**远程代理**，`register` 不抛错却
**注册不进全局表**，于是挂载日志写着"命令 /contextvm"而实际无效。生态既有约定写在
`dsh-fresh-start` 的源码注释里："命令须在 root ctx 用 `ctx.commands.register` 注册才进入
全局命令列表"。

修法：改为 `ctx.commands`，并用 `ctx.inject(['commands'], …)` 等服务就绪后再注册 ——
**不**把 `commands` 列进插件级 `inject`（那是必需语义，会让整个插件等待该服务；命令只是
可选的人读能力，不该有这种代价）。挂载日志也不再提前宣称命令状态（注册现在是异步的，
早报就是撒谎）。真机复验：菜单出现 `contextvm`，执行后正常渲染状态；输入框清空、未发给模型。

### 长对话 + 自动压缩干扰

环境里的压缩相关插件：第三方 `auto-compact`（每步前 + 回合结束按用量比例触发）＋ 宿主
`dsh-compaction` 家族（`-basic` / `-tool-result-pruner`）＋ `/compact` 命令。测试方式：
新建会话（模型已确认是 **Union Alpha**），把该会话的自动压缩阈值经插件自己的 API
（`/auto-compact/api/thresholds.set`）调到 5%，逼出压缩。

结果：

- **压缩确实触发**：UI 显示"已压缩 6 条历史记录（约 1308 tokens）"。
- **宿主的检查点消息被正确排除注入**：`This is an automatically generated checkpoint …`
  以 `system_note` + `kind=plugin` 落库 → 判定 `host_managed` → 不进 recent/候选/邻居
  （§4.1.1 的黑名单按 kind 命中，不依赖 form）。✓
- **ContextVM 的索引不受压缩影响**：宿主遮蔽了历史，我们的 raw 全在；注入（82 token）
  仍同时带着 `Active decisions / facts`（含 provenance）与原文 recent。
- **但这次无法把功劳归给 ContextVM**：宿主的压缩摘要**逐字保留**了那两个事实
  （`<compacted-summary>` 里引用了原请求），所以模型答对不能说明是插件救回来的。
  要隔离验证需要长到摘要会丢细节的会话，本轮没达到。
- **副作用（值得记录）**：压缩的目的正是腾出上下文，而 ContextVM 会把自己索引里的原文
  重新注入 —— 这是"保真优先于压缩"的设计取舍。本例净效果仍是省（注入 82 token vs
  被压缩的 1308 token），但该交互 MUST 被知晓。

### 一次回合里 5 次工具调用（已修）

真机 web 一轮里模型调用了 `contextvm_commit_state` **5 次**：1 次缺 `source_event_ids`
被拒、1 次成功、之后 3 次空 delta；宿主自己都注入了
`You are repeating the exact same tool call with id...`。

成因是注入契约与工具描述都写着"没有变化就提交空增量"，而契约**每步重新注入** ——
听话的模型于是反复提交。在免费慢模型上，每次多余往返就是几十秒。
改为"**每轮最多提交一次** + 空 delta 不是必须（许可而非要求）"。
真机复验：成功提交 **5 → 2**，宿主不再发重复调用提示。

### 两条 delta 路径写重（未修，需决策）

同一轮里**工具路径**与**后台文本抽取路径**各写一份状态，同一事实以不同 key 存了两份：

```
06:42:22  fact key=acceptance_number                  ← 抽取器（英文 key 风格）
06:42:22  fact key=calibration_reference_wavelength
06:42:27  fact key=验收编号                            ← 模型的工具调用（中文 key）
06:42:27  fact key=标定基准波长
```

抽取器拿到了 `stateSummary`（里面已有那两条），但用了不同 key，键级去重拦不住；冲突检测
目前只覆盖 `constraint`。建议方向：工具路径**优先且唯一** —— 本轮已有成功的工具提交时
跳过后台抽取；同时强化抽取器"状态摘要里已有等价事实时 MUST NOT 换 key 重记"。
这属于新的范围，故只报不改。

### 另一个发现：工具调用/结果完全没进记忆

全库事件类型只有 `system_note / assistant_message / user_message / state_delta` ——
**没有任何 `tool_result` / `tool_request`**。宿主事件流里似乎没有（或我们的映射漏了），
于是长任务里"做过什么、工具返回了什么"这条记忆在 ContextVM 里是空的，而规范 §4.1 的
事件类型表里是有 `tool_result` 的。需单独排查（是宿主不送，还是我们没映射）。

## 补充：污染隔离 —— 工具按会话注册、默认休眠（2026-09-17 续五）

回答"是否符合期望：不给用户额外操作负担？不污染正常对话/工具上下文？"时量出一件事：
**工具 schema 才是最大的污染源**。

| 项 | token | 说明 |
|---|---|---|
| 8 个工具 schema 合计 | **1200–1433** | 随注册进入该 profile 下**每个会话**的每个请求 |
| 其中 JSON **结构** | **922** | 键名与嵌套包装，占 77% |
| 其中描述文字 | 280 | 8 条合计，已是信息密度较高的写法 |
| `commit_state` 的枚举 | 64 | 且它是"未知 item_type 被拒"的校验依据，不该删 |
| 对照：插件注入的上下文 | 82–257 | 已被 §4.1.1 压到很低 |

结论：**"压缩描述/枚举"几乎没有收益**（我此前的建议是猜的，实测推翻了它）；真杠杆是合并工具
（6 个记忆工具并成 2 个，预计省 ~270 token），但那会改工具面（§14），未做。

真正的解法是**结构性隔离**（§13.2.1）：

- **默认休眠**：不注册任何工具、不注入、不做轮末抽取；
- **`/contextvm on`**：工具经 `agent.ctx.tools` 注册进**该会话自己的作用域**（宿主支持按 agent
  注册与 `restrict` 屏蔽，实测可行），注入与抽取同时生效；`/contextvm off` 释放；
- 拿不到 agent 作用域时**如实失败，MUST NOT 全局兜底**；
- **输出契约与工具同生共死**：工具未注册时不注入"如何调用该工具"的指令段；
- 模式按会话持久化，宿主重启后由首次请求的懒注册补回。

真机验证（headless，两种模式各跑一轮）：

| | 工具注册 | 注入 | 轮末抽取 |
|---|---|---|---|
| 休眠（默认） | **0** | **0**（无 `context_compiled`） | **0** |
| 开启 | **8**（日志：`已为会话 … 注册 8 个工具（仅本会话可见）`） | 1 | 2 |

附带修掉一个诊断缺陷：**成功路径没有日志** —— 我 grep 的是一行已被删除的"已注册 8 个工具"，
于是把成功误判成失败。现已补上成功日志（"工具到底注册上没有"不该靠猜）。

开启那轮还顺带验证了失败分类：aux 抽取第一次撞上上游 **429 限流**，被正确报为
`delta_provider_error` 并带出上游原文与 `RATE_LIMIT` 码；重试成功。

新增 6 项测试（`tests/session-mode.test.mjs`）守住三条不变量：休眠零足迹、开启三者同时生效、
拿不到作用域不得兜底且不得写"已开启"的假状态；并做变异验证（取消门控即失败）。

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
