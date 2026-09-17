# ContextVM — 低 TPS／小窗口模型的外部上下文虚拟化层（DSH 插件）

给"调用成本近似为零、但 decode TPS 低、原生窗口有限、不回传思维链"的模型提供
接近 1M+ 历史的连续工作体验。实现基线见 [context_virtualization_spec_v1.md](./context_virtualization_spec_v1.md)（v1.4）。

## 它做什么

| 能力 | 对应规范 |
|---|---|
| 原始历史只追加、永不因压缩删除；真相源是宿主 session log，本插件只建索引 | §4.1 / §18.3 |
| 权威状态显式版本化：变更产生新版本并 supersede 旧版本，绝不原地覆盖 | §4.2 / §16 |
| 普通请求走"小工作集 + 按需检索"，上下文按比例预算装箱 | §7 / §9 |
| "全部/无遗漏/查矛盾"类请求走**分块并行穷举扫描**，并如实报告覆盖情况 | §8.3 / §11 |
| 所有 LLM 输出经本地 schema 校验；不依赖、不使用隐藏 CoT | §27.3 / §27.4 |

**它不做什么**：不修改模型权重，不恢复或伪造思维链，不把摘要当事实来源，
不因为存在摘要而删除原始历史，不把 prompt 默认填满物理窗口。

## 安装与启用

一条命令即可（已在真机验证，13.4s 完成，宿主会自动把本包登记进该 profile 的
`dsh.profile.bundles`）：

```bash
dsh plugin --profile <profile> add "github:orangeofcarl0-sys/dsh-contextvm"
```

也可以手动放置：

1. 把本包放进 profile 的 `node_modules`（或作为依赖安装），使其可被 `dsh.bundle.patch` 解析。
2. 宿主会自动消费 [cordis.patch.yml](./cordis.patch.yml) 完成挂载。该文件**只**声明
   `dbPath` 与 `route`；预算比例、输出上限等一律由 `lib/app/config.js` 的 `DEFAULTS` 提供
   （单一定义处，避免两处默认值漂移）。
3. `route.provider` 必须与 `settings.yaml` 中已注册的 provider 路由键一致
   （当前基线为 `openrouter-stealth` / `stealth/union-alpha`）。

**零配置即可用**，且**默认会真的落盘**到 `$DSH_HOME/contextvm/contextvm.db`
（`DSH_HOME` 缺省为 `~/.dsh`）。只有显式写 `dbPath: ':memory:'` 才是内存库。

> 注意：安装成 bundle 之后**不要**再用 `--patch` 以 `insert` 方式插同一个 id，
> 宿主会报 `duplicate loader entry id` 并拒绝启动插件树。需要覆盖配置时，
> 在 profile 自己的 `cordis.patch.yml` 里按 id 写 `config` 段。

## 怎么知道它在工作

插件把诊断写到 **stderr**（不用 stdout：headless 把 stdout 当"最终回答"的通道，
写那里会污染结果），每行带 `[contextvm]` 前缀。挂载时三行即可回答最常见的问题：

```
[contextvm] 已挂载 · schema v1 · 命令 /contextvm
[contextvm] 库: /home/you/.dsh/contextvm/contextvm.db
[contextvm] 已注册 8 个工具：contextvm_commit_state, contextvm_exhaustive_scan, search_memory, ...
```

首次解析到某条路由时会记一行它的**声明窗口**（以及适配器默认输出上限、可选推理档位，若提供）：

```
[contextvm] 路由 openrouter-stealth/stealth/union-alpha: 声明窗口 262,144
```

**宿主托管上下文不会被重复注入。** 宿主自己注入的运行时上下文快照与技能目录会被正常索引
（可检索、可追溯），但**不会**再作为"最近原文"或"检索证据"注入回去——它们本就在宿主的提示词里。
真机实测这些样板曾占某会话镜像内容的 98%，使注入的 5860 token 中只有 31 token 是真正的
权威状态；修正后同一会话降到 **188 token**，且全部是真实内容。

**状态只记"真正谈过的内容"。** 宿主每轮自带的环境信息（文件沙箱策略、审批策略、技能目录）
不会被记成项目事实——真机上模型曾把它们记下来，来源指向宿主快照，再当作权威事实注入回来。
现在这类来源会被状态写入直接拒绝（提示词层面的劝阻只是辅助，校验才是保证）。
`next_action` 也用稳定 key 落库并带 provenance，任何时候只保留一条。

在 web / tui 里输入 **`/contextvm`**（指令菜单里也能找到）可随时查看当前窗口与预算、索引与状态规模、待处理增量、
语义索引状态、容量拒绝计数等（该命令取不到项时写"未知"，自身绝不抛错）。

## 运行时要求

- Node.js ≥ 22.5（使用内置 `node:sqlite`，实测 Node 24.14.1 提供 SQLite 3.51.2 且 FTS5 + `bm25()` 可用，**无原生依赖**）。
- 需要宿主提供 `ctx.tools`（工具注册）。`llm` 服务用于窗口解析与辅助调用，缺失时如实降级并在日志中说明。

## 配置

```yaml
# cordis.patch.yml 的 config 段；未列出的项取 lib/app/config.js 的 DEFAULTS
dbPath: null                     # null → <dshHome>/contextvm/contextvm.db
route:
  provider: openrouter-stealth
  model: stealth/union-alpha
```

需要覆盖某项预算时，在 `config` 下按字段写即可（深合并按字段覆盖）。例如：

```yaml
ratios:
  heavy_target_input: 0.52
```

启动时会校验 §19.1 的全部不变量（偏序、组件上界之和、预检系数等），
**任一条失败即拒绝启动**并指出具体条目，不会用默认值静默继续。

**辅助调用的输出上限（`output.*`）要覆盖"隐藏推理开销 + 目标正文"**：目标模型有一部分
生成**既不流式送出、也不在 `reasoning_tokens` 里报告，却计入 `output_tokens`**（实测差额
300–1658 token，方差很大）。真机实测 `max_tokens=500` 时整份预算被它吃光：正文 0 字、`finish=max-tokens`、
流里只剩 `usage`+`finish` 两个 chunk —— 状态抽取因此永远拿不到内容（表现为"插件在跑但状态
从不积累"）。

注意这**不是上游限制**：上游 `top_provider.max_completion_tokens = 131072`，
`default_parameters` 为空，没有任何外部约束要求几百 token 的上限。默认值已按实测上调
（`state_delta` 3000，硬上限 4000）；若你换到推理开销更大的模型，优先调大
`output.state_delta_soft_max_tokens` 与 `output.global_worker_output_max_tokens`。
`*_hard_max_tokens` 是**不可被 override 突破**的兜底。撞上限时插件会打出
`delta_budget_exhausted` 并直接指出该调哪一项（这种失败重试无用，故不入队）。

## 测试

```bash
npm test                # 全部审计与验收测试（204 项，默认串行）
npm run test:parallel   # 同上但并行（更快，供快速迭代）
npm run test:acceptance # 只跑 1M 语料与 Phase A 验收
npm run audit:host      # 宿主契约实机审计（需本机安装 DSH；核对接口、工具 schema、文档化参数）
npm run audit:code      # 结构复杂度审计（函数规模/嵌套/重复块/依赖环）
npm run audit:dead      # 死代码与"上帝对象"检查
npm run check           # 入口语法检查
```

默认**串行**执行：并行时曾观察到一次 1M 验收测试的资源峰值挤掉轻量测试文件的 worker
（少报 10 个测试）。审计项目的默认档必须可信，故默认串行（约 14s），并行档留给快速迭代。

测试完全使用内存库与假端口，**不需要 DSH 进程**。测试分层：

| 文件 | 覆盖 |
|---|---|
| `config.test.mjs` | §19.1 不变量、预算派生、§9.6 两条硬断言 |
| `storage.test.mjs` | 追加-only 语义、版本链、provenance、迁移 |
| `retrieval.test.mjs` | CJK 检索、exact-first、邻域、去重、预算严格性 |
| `context.test.mjs` | 模式分类、优先级装箱、编译器产物与 §9.5 顺序 |
| `host.test.mjs` | 宿主缝五条接线、§9.1.1 收缩重试、LLM 端口适配 |
| `phase-b.test.mjs` | episode 边界与分段、摘要失败重试、BROAD 导航、分层摘要 |
| `phase-c.test.mjs` | 分块覆盖、worker 幻觉拦截、reducer 冲突保留、GLOBAL 编译 |
| `phase-d.test.mjs` | 维护队列、状态审计、索引重建、遥测 |
| `retrieval-strategy.test.mjs` | 关键词为主/embedding 降级、摘要桥接召回、摘要不得挤掉原始证据 |
| `memory-tools.test.mjs` | §14 六个工具的行为、跨会话拒绝、长内容截断标注 |
| `fixtures.test.mjs` | 基准语料金标准 + 脚本卫生（import 完整性、禁止跨脚本源码耦合） |
| `schemas.test.mjs` | LLM 输出校验的四类失败 + JSON 配平扫描器 |
| `artifacts.test.mjs` | artifact 版本链与 supersede、只存引用不存正文、§9.5 产物段 |
| `autotune.test.mjs` | 基准→配置覆盖（比例形式）、hard cap 夹取、§9.2 组件缩放补偿 |
| `delta.test.mjs` | delta 应用规则：来源校验、无依据取代约束、冲突转 uncertain、next_action 落库 |
| `acceptance.phase-a.test.mjs` | §26 Phase A 通过条件（0.19W–0.38W）、崩溃恢复、delta 不丢回答 |
| `acceptance.1m.test.mjs` | §24.2 的 1M+ 合成语料与 §24.3 全部目标指标 |
| `boot.smoke.test.mjs` | 端到端：apply → 五条宿主缝 → 编译 → delta → episode → 维护 → 拆解 |

## 重建

只要 `raw_events` 表还在，检索索引可重建：

```js
vm.rebuildSearchIndex(sessionId);          // 从 raw 重建 FTS
vm.verifyRebuildability(sampleSize);       // 校验 raw 与 FTS 一致且可自我检索
```

`episodes` 摘要与 `state` 投影本身即为派生物，可重跑。
维护队列会在空闲时自动执行（`flush_pending_deltas` / `summarize_pending_episodes` /
`audit_state` / `verify_index`），全部为非关键路径且受时间预算约束。

## 目录

```
lib/
  index.js              插件入口（name / inject / apply）
  app/                  config · create · runtime · episodes · telemetry
  core/                 enums · ids · text · tokenization
  storage/              sqlite · raw_events · state_store · episodes
  indexing/             lexical（FTS5 + bm25）
  retrieval/            hybrid · neighborhood
  context/              classifier · budget · compiler · renderer · dedup
  llm/                  client · prompts · schemas
  memory/               delta · projection · summarizer · audit
  global_scan/          splitter · worker · reducer · scanner
  maintenance/          queue · rebuild
  benchmark/            autotune（基准→配置覆盖）
  host/                 ports（端口契约）· seams（宿主接线）· llm（端口适配）
  tools/                commit_state · exhaustive_scan
benchmark/              基准与探针（见 benchmark/README.md）
tests/                  审计与验收测试
tools/                  代码审计（code-audit.mjs / dead-code-check.mjs）
```

## 实机验证

假宿主测试覆盖不了宿主接口本身。`npm run audit:host` 用**真实宿主包**做四段核对
（工具定义能否被真 `defineTool` 编译、调用的成员是否真实存在、有无已知的错误访问、
提示词文档化的调用参数能否通过宿主编译后的 schema）。

在真实 DSH 进程里跑一轮：

```bash
# 最贴近用户的路径：按安装方式装好，直接跑（无 patch、无配置）
dsh plugin --profile headless add "github:orangeofcarl0-sys/dsh-contextvm"
dsh --profile headless "只回复两个字：收到。不要调用任何工具。"
# 看 stderr 里的 [contextvm] 行；再看 $DSH_HOME/contextvm/contextvm.db 是否落盘且体积增长

# 只想临时试、不改 profile 时，用一次性叠加层插入（insert 同一个 id）
cp -r lib package.json cordis.patch.yml "$DSH_HOME/profiles/headless/node_modules/dsh-contextvm/"
dsh --profile headless --patch _probe-contextvm.yml --dump-config   # 先确认补丁合成
dsh --profile headless --patch _probe-contextvm.yml "调用 contextvm_commit_state，把返回原文贴出来"
```

`--patch insert` 与"已装成 bundle"互斥（会 `duplicate loader entry id`）：二选一。

提示：`headless` 是"回答一个任务就退出"的一次性应用，它把参数当提示词，
**不**解析 `/contextvm` 这类斜杠命令；命令入口属于 `tui` / `web` 这类交互 profile。

## 完成度

规范 §29 的 14 项完成条件逐条核对与实测指标见
[docs/definition-of-done.md](./docs/definition-of-done.md)（含**有意未实现**的部分及理由）。

## 检索策略

**关键词检索为主，embedding 为辅**（规范 §7.1.1）。理由是本项目的检索需求以
精确匹配为主（数字/文件名/函数名/错误信息）、窗口稀缺使精确率优先于改写召回率，
且中文场景下"CJK 逐字索引 + 二元组短语查询"更可靠且完全确定。

embedding 是**可选分量**（权重 0.10，与其它辅助分量同级）：不可用时按唯一规则
重归一化权重自动降级，功能不减；接入时保持可关闭。

摘要检索承担了 embedding 原本最主要的收益——"换个说法也能召回"：episode 摘要由模型
生成，措辞与原始事件天然不同，故对同义改写有容忍度，且是本项目既有的零依赖派生物。
摘要命中作为导航单元注入（标注 episode 与原始范围，分值低于原始命中）。

## 基准

`benchmark/` 下的脚本产出规范 §2.3 / §25 所需的实测数据（对真实上游发起调用，
需要 `.credentials.yaml` 中的 `OPENROUTER_API_KEY`）：

```bash
node benchmark/api-bench.mjs               # TTFT / TPS / 并发 / 输出长度 / 语种校准
node benchmark/api-bench.mjs --extended    # 追加 1024/2048 输出与 0.732W prefill
node benchmark/preflight-limit.mjs         # 网关预检系数与真实输入上限
node benchmark/rebuild-report.mjs          # 合并预检标定并确定性重算推荐比例（不发起调用）
node benchmark/verify-spec.mjs             # 规范数值不变量与陈旧数值终检
```

已实测的关键结论（详见规范 §2.1.1 / §2.1.2 / §9.1.1）：

- decode TPS 中位约 **9.9**（4.83–12.51），并发 n=4 聚合约 **27.9 TPS**；
- **声明窗口不等于可用窗口**：OpenRouter 网关预检以独立估算器计数，比真实分词器保守
  约 **1.693 倍**，故真实可用输入上限约 **0.560W**（heavy/hard 两档据此从 v1.0 下调）；
- token 估算误差**随内容变化**（3.5–6.8 chars/token 跨度约 2 倍），固定系数 + 固定余量
  的做法不成立，必须以 `usage` 在线校准。
