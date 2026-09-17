# ContextVM — 低 TPS／小窗口模型的外部上下文虚拟化层（DSH 插件）

给"调用成本近似为零、但 decode TPS 低、原生窗口有限、不回传思维链"的模型提供
接近 1M+ 历史的连续工作体验。实现基线见 [context_virtualization_spec_v1.md](./context_virtualization_spec_v1.md)（v1.3）。

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

1. 把本包放进 profile 的 `node_modules`（或作为依赖安装），使其可被 `dsh.bundle.patch` 解析。
2. 宿主会自动消费 [cordis.patch.yml](./cordis.patch.yml) 完成挂载。该文件**只**声明
   `dbPath` 与 `route`；预算比例、输出上限等一律由 `lib/app/config.js` 的 `DEFAULTS` 提供
   （单一定义处，避免两处默认值漂移）。
3. `route.provider` 必须与 `settings.yaml` 中已注册的 provider 路由键一致
   （当前基线为 `openrouter-stealth` / `stealth/union-alpha`）。

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

## 测试

```bash
npm test                # 全部审计与验收测试（177 项，默认串行）
npm run test:parallel   # 同上但并行（更快，供快速迭代）
npm run test:acceptance # 只跑 1M 语料与 Phase A 验收
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
