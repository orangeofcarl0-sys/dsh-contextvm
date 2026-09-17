# Definition of Done 核对（规范 §29）

逐条对照规范 §29 的 14 项完成条件，给出**可复跑的**证据。命令统一为：

```bash
npm test                        # 177 项审计与验收测试
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
4. **真实 DSH 进程内运行**：本环境无宿主进程，全部验证走假宿主（含端到端启动冒烟
   `boot.smoke.test.mjs`：apply → 五条宿主缝 → 编译 → delta → episode → 维护 → 拆解）。
   宿主包 `@deepseek-ai/dsh-tools` 可解析时会注册 8 个工具，本环境走的是降级路径，两条路径均有测试覆盖。
