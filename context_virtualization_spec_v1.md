# Context Virtualization Layer
## 面向“免费、低 TPS、无可见 CoT”LLM API 的 1M+ 逻辑上下文代理系统实施规范

> 目标模型：OpenRouter `stealth/union-alpha`，物理窗口 `W = 262144`。
> **全部上下文预算按 `W` 的比例定义**（§9 / §19），262144 仅作为参考窗口出现，MUST NOT 硬编码。

**文档版本**：v1.3  
**状态**：Implementation Baseline / 可直接交由本地 Agent 实现  
**目标读者**：本地编码 Agent、系统工程实现者、测试 Agent  
**约束优先级**：本文档中 MUST > SHOULD > MAY。若实现与本文冲突，以 MUST 为准。  

---

## v1.1 变更摘要（相对 v1.0）

目标模型已确认为 OpenRouter `stealth/union-alpha`，实测规格见 §2.1。由此产生四处修订：

1. **§9.1 / §9.2 / §19 / §25 的上下文预算改为比例制**：所有**输入侧**预算表达为物理窗口 `W` 的比例。v1.0 的绝对值全部保留，作为 `W = 262144` 时的参考列。理由：该模型是 stealth 匿名模型（可能随时下架或更换窗口），且宿主允许会话中途切换 provider/model，因此 `W` MUST 按请求解析而非启动时固化（见 §9.6）。
2. **明确区分"随 W 缩放"与"由 TPS 决定"两类预算**（§9.1 / §17.1）：输入侧随 `W` 缩放；输出侧为绝对值，**不随 `W` 变化**。v1.0 将两类量并列于同一张表，易被误读为"窗口变大即可输出更长摘要"。
3. **§6.1 episode 尺寸改为带保真度上限的 clamp**：episode 原始尺寸不得随 `W` 线性外推，因为摘要保真度受压缩端能力限制，而非受目标窗口限制。
4. **据实测能力修订 §13 / §24**：`tools` 实测可用；`response_format` 的 `json_schema` 稳定 400、`json_object` 虽可用但**宿主缝未暴露该字段**，故辅助调用定为"提示词 JSON 契约 + 本地 schema 校验"（服务端不提供结构保证，§27.3 本地校验不可放松）；`seed` / `logprobs` 不可用，合成测试不可确定性重放。
5. **新增 §2.1.1 实测验证节**：实测发现接口自述与实际行为不一致（见上条），并据此强化 §2.2 / §9.6 / §12。注意：本节最初引用的 TPS 与 token 估算数字来自一次 5 样本探针，**已被第 8、9 条的正式基准与三口径分析取代**；凡有冲突，以第 8、9 条与 §2.1.1 正文为准。

7. **新增 §9.1.1（网关预检）并据实测下调 heavy / hard 两档比例**：实测发现上游网关以**独立估算器**预检 token 数，比真实分词器保守 **1.693 倍**，故声明窗口 262144 **不是可用窗口**——实测最大可服务输入为 **146,820 真实 token（0.560W）**。据此 `heavy_target_input` 由 0.649 降为 **0.500**、`hard_input_cap` 由 0.782 降为 **0.550**；v1.0 这两档在真实调用中稳定返回 400。同时新增"自适应收缩"MUST 与 §25 的 `preflight_calibration`。
8. **§2.1.1 与 §12 据 6 样本正式基准修正**：decode TPS 由早期单次探针的"0.8–6.2"修正为 **4.83–12.51（中位 9.86）**；并发实测 n=4 聚合 **27.9 TPS**（7 倍于 n=1）且单请求延迟未劣化，故并行 worker 在本路由上收益显著；TTFT 随长度增长平缓，§17.2 的降档分支未触发。
9. **§9.6 新增"三个 token 计数口径"分析**：真实分词器 / `chars/4` / 网关预检估算器三者的实测差异达 2 倍且**随内容变化**（英文自然句 3.5、中文 2.0、英文伪随机词序 6.8 chars/token），故"固定系数 + 固定余量"在原理上不成立；硬上限改为取两条约束（声明窗口、网关预检）中较紧的一条。
10. **新增 `benchmark/` 基准工具**：`api-bench.mjs`（分阶段、可续跑、结果落 `benchmark_report.json`）、`prefill-limit.mjs` / `preflight-limit.mjs`（输入上限与预检系数标定）、`verify-spec.mjs`（本文数值不变量与陈旧数值终检）。

## v1.2 变更摘要（相对 v1.1）

11. **新增 §2.1.2 路由候选评估**：对同一模型的第二条路由（opencode zen/go，Anthropic Messages 协议）做了完整实测。结论是**当前仍启用 OpenRouter 路由**，因为 opencode 路由存在一个致命阻断项——`union-alpha` 在该端点上的**流式返回零字节**（同路由的 `minimax-m3` 流式正常，故为模型特有），而宿主 pi-ai 的 `anthropic-messages` 实现**恒发 `stream: true`**，经 DSH 调用必然得到空响应。该路由的配置草案以注释态保留在宿主设置中，并附复核命令；MUST NOT 在未复核流式的情况下启用。
12. **§9.1.1 与 §9.1 明确"输入上限是路由属性，不是模型属性"**：两条路由的闸门估算系数不同（OpenRouter 约 4.0 chars/token → 真实上限 0.560W；opencode 确定性 5.0 → 0.739W），故输入上限 MUST 按路由分别标定，路由切换 MUST 触发预算重算。新增两条 MUST。

## v1.3 变更摘要（相对 v1.2）

13. **§7.1 改为"关键词检索为主、embedding 为辅"**。v1.1 把 semantic 排在首位（0.32 > lexical 0.28）的排序不再采用。新增 §7.1.1（为何以关键词为主：本项目检索需求以 exact-first 为主、窗口稀缺使**精确率优先于改写召回率**、中文场景下关键词检索更可靠且完全确定、免费/stealth 路由不宜再叠加第二个网络依赖）与 §7.1.2（**embedding 是降级而非移除**：权重降至 0.10 与其它辅助分量同级、缺失时按唯一规则自动重归一化、接入时须可关闭且状态可观测）。
14. **新增 `summary_search` 候选源**，承担 embedding 原本最主要的收益——"换个说法也能召回"：episode 摘要由模型生成，措辞与原始事件天然不同，故对同义改写有容忍度，且摘要本就是本项目的派生物，零额外依赖、零额外密钥。摘要命中作为**导航单元**注入并标注其 episode 与原始范围（§6.3：摘要不是真相源），分值刻意低于原始命中，且 MUST NOT 挤掉可追溯的原始证据。
15. **删除 §7.1 末尾与 §7.1.2 重复的降级声明**，使"embedding 不可用时的降级"只有一处陈述。

未改变的核心原则：raw 永不删、state 版本化、provenance 强制、GLOBAL 完整覆盖、不依赖 hidden CoT。

6. **§3.1 / §17.2 / §18 / §21 / §27.2 由 Python 改为宿主原生 Node.js**：运行时定为 Node.js ESM + 内置 `node:sqlite`（实测含 FTS5 + `bm25()`），MUST NOT 使用跨语言 sidecar。模块目录改为 DSH 插件形态，接口契约为 ESM，并新增 §21.6 宿主缝适配与 §21.7 辅助调用封装。§21.3 的编译产物由单一 `rendered_messages` 拆为 `renderedSections` + `admittedMessages` 两路，原因是宿主缝本身分离（system prompt 与准入消息改写入口不同）。

---

# 0. 执行摘要

本项目不是修改底层模型权重，也不是把原生窗口硬扩成 1M。目标是在不依赖可见 Chain-of-Thought（CoT）的前提下，为一个**调用成本近似为零、但 decode TPS 较低、原生上下文窗口有限**的模型（当前为 OpenRouter `stealth/union-alpha`，`W = 262144`）建立一层外部上下文虚拟化系统，使其在长对话、代码、研究、项目管理和多文档任务中获得接近 500k-1M 甚至更长历史的连续工作体验。

系统的核心原则为：

1. **Raw history 永不因压缩而删除**；所有摘要、状态和索引均为可重建派生物。
2. **当前模型工作集必须显著小于物理窗口**；`W` 是硬上限，不是正常运行目标。
3. **长期连续性依赖显式状态，而不是隐藏 CoT**；保存结论状态、约束、决策、证据、未决问题与下一步，不保存或伪造思维链。
4. **低 TPS 意味着应优先减少串行生成 token，而不是减少 API 调用次数**。
5. **普通请求走小工作集 + 检索；“全部/完整/无遗漏/查矛盾”类请求走分块并行穷举扫描**。
6. **长期事实优先抽取式保存；生成式 summary 主要用于导航，不作为唯一事实来源**。
7. **状态更新采用增量 delta，不允许每轮重写完整 memory/state**。
8. **所有可变状态版本化，旧决定被 supersede，而不是物理删除**。

目标架构：

```text
                         Immutable Raw Event Store
                       1M / 10M / 100M+ tokens
                                  |
              +-------------------+-------------------+
              |                   |                   |
          FTS/BM25            Vector Index       Metadata/Graph
              |                   |                   |
              +-------------------+-------------------+
                                  |
                          Context Compiler
                                  |
              +-------------------+-------------------+
              |                   |                   |
         Authoritative        Recent Raw        Retrieved Evidence
            State             Verbatim              / Episodes
              |                   |                   |
              +-------------------+-------------------+
                                  |
                   0.305W-0.573W Normal Prompt
                                  |
                        W (physical window)
                                  |
                     +------------+------------+
                     |                         |
                   Answer                  State Delta
                                             |
                                      Append / Version
```

对于全局任务：

```text
                    1M+ Raw History
                         / | | \
                        /  | |  \
                  Chunk1 Chunk2 ... ChunkN
                      |    |          |
                   Worker Worker    Worker
                   <=300t <=300t    <=300t
                        \   |       /
                         Reducer
                           |
                      Final Answer
```

---

# 1. 项目目标与非目标

## 1.1 MUST 实现的目标

系统 MUST：

- 支持单会话原始历史至少 **1,000,000 tokens**，且架构上不设置固定百万级上限。
- 在底层模型原生窗口 `W` 下，维持稳定的长期任务状态。
- 不要求底层 API 返回隐藏 CoT。
- 保留每一条原始用户消息、模型响应、工具结果和重要 artifact 引用。
- 为普通交互动态编译不超过配置预算的 active context。
- 能从早期原始历史恢复未进入 summary 的精确细节。
- 能区分 active / superseded / resolved / rejected 等状态。
- 支持 LOCAL、BROAD、GLOBAL 三种上下文读取模式。
- 对“全部、完整、无遗漏、检查全部历史矛盾”等任务提供 exhaustive scan，而不是仅依赖向量召回。
- 所有派生 memory 可从 raw event store 重建。
- 在进程崩溃后恢复会话状态。

## 1.2 SHOULD 实现的目标

系统 SHOULD：

- 支持并发 worker 以利用免费 API。
- 支持 BM25/FTS + embedding hybrid retrieval。
- 支持 episode 聚合与层级 summary。
- 支持 artifact/file 的 JIT retrieval。
- 支持检索证据 provenance，并能追溯至原始 event/span。
- 支持 memory consistency audit。
- 支持离线重建索引与 memory projection。
- 具备可观测性：token 使用、TTFT、TPS、召回命中、压缩率、全局扫描耗时。

## 1.3 明确非目标

V1 MUST NOT：

- 修改模型权重、RoPE、YaRN 或 position embedding。
- 试图恢复、推断或持久化隐藏 CoT。
- 把生成式 summary 视为最终真相源。
- 每轮调用都重新总结全部历史。
- 仅依赖向量数据库作为长期记忆。
- 因 summary 已存在而删除 raw history。
- 默认把 prompt 填满至物理窗口的 95% 以上。
- 允许模型直接覆盖历史事实而不留版本链。

---

# 2. 资源模型与优化目标

## 2.1 已知资源假设

目标模型已确认，以下为 OpenRouter 模型接口实测值（2026-09-17 取数）：

| 项 | 实测值 |
|---|---|
| provider / model | DSH 路由键 `openrouter-stealth` / 上游模型 id `stealth/union-alpha` |
| 物理窗口 `W`（context_length） | **262144**（= 256K）= v1.0 所述"262k"的来源 |
| 最大输出（max_completion_tokens） | 131072 |
| 定价 | prompt `0` / completion `0` —— 调用成本确认为 0 |
| 输入模态 | text + image |
| tokenizer | **`Other`** —— 上游未公开分词器，本地无法精确计数 |
| 可用参数 | `max_tokens, temperature, top_p, tools, tool_choice, response_format` |
| **不可用参数** | `reasoning`、`seed`、`logprobs`、`stop`、`top_k`、`presence/frequency_penalty` |
| 端点 | 单端点，provider 名 `Stealth`，30 分钟 uptime 99.9987% |
| 吞吐实测 | `throughput_last_30m: null` —— **无任何公开 TPS/TTFT 先例数据** |

由此确立三条约束：

1. **API 不返回可见 CoT**（无 `reasoning` 参数，响应亦无推理字段），与本文"不依赖 hidden CoT"的核心设计一致。
2. **窗口 `W` 是运行时变量，不是常量**。该模型为 stealth 匿名模型，可能随时下架或更换窗口；且宿主允许会话中途切换 provider/model。所有依赖窗口的预算 MUST 按请求解析 `W`，MUST NOT 在配置或代码中硬编码 `262144`。
3. **本地无法精确计数 token**。由于 tokenizer 为 `Other`，而宿主自身的 token meter 也是启发式估算（`estimateMessage` 为 heuristic pricing），系统 MUST 假设存在双向估算误差，并在硬上限中显式预留余量（见 §9.6）。

`W` 的取值来源：宿主模型信息接口 `llm.resolveModelInfo(provider, model)` 返回的 `contextWindow`（语义为"请求与响应的合计上下文上限"）。该字段为必填，故运行时必然可得。

**其他已知未知量**（MUST 由 §2.3 benchmark 测定）：Decode TPS、Prefill/TTFT、并发限制模式。

### 2.1.1 实测验证（2026-09-17）

上表来自模型接口的自述（declared），**自述与实际行为存在差异**，以下为真实调用实测结果。实现 MUST 以本节为准，MUST NOT 仅依据接口自述编程。

| 能力 | 接口自述 | 实测结果 |
|---|---|---|
| 基础补全 | 支持 | ✅ 正常，`cost: 0` 确认免费 |
| `tools` / `tool_choice` | 支持 | ✅ **可用**，`finish_reason: tool_calls`，参数正确 |
| `response_format: {type: json_object}` | 支持 | ✅ **可用**，返回合法 JSON |
| `response_format: {type: json_schema, strict}` | 支持 | ❌ **稳定失败**，HTTP 400（两次复测均 400，0.4s 内即返回，属校验拒绝而非超时） |
| 可见 CoT | — | ❌ 无。但注意：`message.reasoning` **字段始终存在且为 `null`**（`completion_tokens_details.reasoning_tokens: 0`）。代码 MUST 做空值判断，MUST NOT 假设该字段缺失 |

由此修订 §13.1：`json_schema` 模式 MUST NOT 使用（稳定 400）；`json_object` 模式虽上游可用，但**宿主 `GenerateOptions` 不暴露 `response_format` 字段**，本系统发不出去（详见 §13.1）。故结构化输出 MUST 依赖"提示词契约 + 本地校验"，或经 `tools` 携带参数 schema。服务端不提供任何结构保证，§27.3 的本地 schema 校验是唯一防线。

**估算误差的实测口径分析**见 §9.6——该处给出三种 token 计数口径（真实分词器 / `chars/4` / 上游网关预检估算器）的实测差异，是本节最重要的结论，也是 §9.1.1 输入上限的成因。

**吞吐与延迟实测**（§2.3 基准，工具见 `benchmark/api-bench.mjs`）：

| 项 | 实测 |
|---|---|
| decode TPS（6 样本，输出 128/256/512） | min 4.83 / **中位 9.86** / max 12.51 |
| TTFT @ 8,122 token | 27.3 s |
| TTFT @ 31,991 token | 32.8 s |
| 并发 n=1 / n=2 / n=4 聚合吞吐 | 4.0 / 15.9 / **27.9** TPS |
| n=4 时单请求延迟 | 约 6 s |

结论：

- **TPS 中位约 10，极差 2.6 倍**（4.83–12.51）。任何按单次调用定值的设计都不可靠——本文档早期一次 5 样本探针曾得到 0.8–6.2，已被上述 6 样本正式基准取代，该差异本身即证明单次测量会严重误导。
- **TTFT 在 8k→32k 区间仅从 27.3s 增至 32.8s**，增长平缓，说明该路由的固定开销（约 20–27 秒）占主导而非 prefill 线性成本。故 §17.2 的"TTFT 增长过快则降档"策略在本路由上**未触发**，normal 维持 0.458W。
- **并发收益显著**：n=4 聚合吞吐 27.9 TPS，为 n=1 的 7 倍，且单请求延迟未劣化。这为 §12 的并行 worker 与 §11 的 GLOBAL 并行扫描提供了直接依据——并行在本路由上是**廉价**的，这一点在免费额度下尤为关键。
- `300` token 的 worker 输出实为 **24–62 秒**（§12 已同步修正）。早期"S 级分钟"量级的悲观估计不成立，但"减少串行生成 token"仍是首要原则（§2.2）。

**输入上限实测**：最大可服务输入为 **146,820 真实 token = 0.560W**，超出即被上游网关预检以 HTTP 400 拒绝。成因与三条 MUST 见 §9.1.1。

附带观察：`prompt_tokens_details.cached_tokens` 显示前缀缓存确实生效。因成本恒为 0，缓存只影响延迟不影响费用。本文档不为此调整 §9.5 的固定渲染顺序（§9.5 顺序服务于可解释性），但这意味着**存在一项被主动放弃的延迟优化**——记于此备查。

### 2.1.2 路由候选评估（2026-09-17）

同一模型可由两条路由服务，二者在**线协议、输入上限、流式可用性**上差异显著。**§9.1.1 的输入上限是路由属性，不是模型属性**，故本节的对比是预算取值的前提。

| 项 | OpenRouter（**当前启用**） | opencode zen/go |
|---|---|---|
| 路由键 | `openrouter-stealth` | `opencode-union`（配置草案保留为注释态） |
| 模型 id | `stealth/union-alpha` | `union-alpha` |
| 线协议 | openai-completions | **anthropic-messages**（该端点上仅此一种可用） |
| 鉴权头 | `Authorization: Bearer` | **`x-api-key`**（Bearer 报 401 Missing API key） |
| 必需头 | 无 | **`x-opencode-session`**（缺失返回 400 cannot be routed efficiently） |
| 闸门估算系数 | 约 4.0 chars/token | **5.0 chars/token**（确定性） |
| 真实输入上限 | **0.560W**（146,820 token 实测） | 0.739W（按 5.0 系数推算） |
| 闸门声明上限 | 262144 | 262144（含输出，原文 "including the completion"） |
| **流式** | ✅ 可用（TTFT 27–90s） | ❌ **零字节空流** |
| 工具调用 | ✅ 可用 | ✅ 可用（仅非流式下验证） |
| usage 可信度 | ✅ 与内容一致 | ⚠ `input_tokens` 不稳定（同量级提示词分别报 1 与 10） |
| 小调用固定开销 | 约 10–17s | 约 45–58s |
| 非流式 256 输出 | 21–53s（TPS 4.83–11.32） | 83–93s（TPS 2.75–3.08） |
| 成本 | 0 | 0（`cost: "0"`） |

**唯一阻断项：`union-alpha` 在 opencode 端点上的流式返回零字节。**

实测依据：同一路由、同一请求头集合下，`minimax-m3` 流式完全正常（37 chunk，首字节 1–2s，含完整 Anthropic 事件序列与 usage），而 `union-alpha` 三次尝试均为零字节（分别于 15.0s / 32.8s / 32.8s 后结束）。故可排除请求头问题与网关整体故障，判定为**该模型特有**。

宿主约束使该缺陷致命：pi-ai 的 `anthropic-messages` 实现**恒发 `stream: true`**（`api/anthropic-messages.js` 中不存在流式之外的分支，`params = { ...nextParams, stream: true }`），因此经 DSH 调用必然拿到空响应，表现为模型"什么都不输出"。

**推测成因（未证实）**：网关的流空闲超时（观察值约 15s）短于 `union-alpha` 的 TTFT（非流式实测 45–93s），故首个事件到达前连接已被关闭。若此推测成立，则 TTFT 改善后该路由即可用——这正是 §19 保留其配置草案与复核命令的理由。MUST NOT 在未复核流式的情况下启用该路由。

**当前决策与理由**：启用 OpenRouter 路由。它以输入上限 **0.560W**（相比 opencode 的 0.739W 少约 24% 可用输入）换取可用的流式与可信的 usage；而宿主 LLM 缝本身是流式的，**流式可用性是硬门槛，输入上限只是量级优化**。若 opencode 修复流式，SHOULD 切回该路由以取回那部分上限，届时 §9.1 的 hard cap 可上调至 0.70W 量级。

另一条已验证的负结果：`union-alpha` 在**同一主机的 openai-completions 端点**（`/v1/chat/completions`）稳定返回 HTTP 500 Internal server error，故该模型确实只在 Anthropic 端点上服务——这与用户侧 `@ai-sdk/anthropic` 的配置一致，也排除了"换协议即可绕开空流"的可能。

## 2.2 优化函数

本系统首要优化目标 MUST 是降低**串行生成 token 数量与关键路径延迟**，而不是减少 API call 数量。

近似：

```text
T_total ~= T_prefill + N_output / TPS_decode + T_network + T_queue
```

因此：

- 允许增加输入 token，只要 TTFT 可接受。
- 允许增加并行 API calls。
- worker 输出 MUST 严格限制。
- memory maintenance SHOULD 放入非关键路径。

## 2.3 启动阶段必须完成的基准测试

实现完成后，在确定最终默认预算前 MUST 执行 benchmark：

### 输入长度测试

按 `W` 的比例取探测点（`W=262144` 时括号内为 v1.0 原值）：

- 0.031 W（8k）
- 0.122 W（32k）
- 0.244 W（64k）
- 0.488 W（128k）
- 0.732 W（192k）
- 0.854 W（224k，若 API 稳定允许）

记录：

- TTFT
- total latency
- output TPS
- API error rate
- timeout rate

### 并发测试

并发数：

- 1
- 2
- 4
- 8
- 16（若服务允许）

记录 aggregate TPS，判断限速是：

- per-request
- per-account
- hybrid

### 输出长度测试

至少测试：

- 128
- 256
- 512
- 1024
- 2048 tokens

最终 ContextCompiler 的 token budget SHOULD 根据 benchmark 自动选择，而不是硬编码为物理最大窗口。

---

# 3. 总体架构

## 3.1 核心组件

V1 MUST 包含以下组件：

1. `RawEventStore`
2. `StateStore`
3. `EpisodeManager`
4. `LexicalIndex`
5. `SemanticIndex`（可配置关闭）
6. `Retriever`
7. `ContextCompiler`
8. `LLMClient`
9. `StateDeltaProcessor`
10. `GlobalScanner`
11. `MemoryMaintenanceWorker`
12. `Telemetry`

推荐模块目录（DSH 插件形态；运行时选型理由见 §18.1）：

```text
dsh-contextvm/                 # DSH 插件包
  package.json                 # type: module, main: lib/index.js, dsh.bundle.patch
  cordis.patch.yml             # 宿主挂载补丁
  lib/
    index.js                   # 插件入口：name / inject / Config / apply
    app/
      config.js                # §19 配置加载 + §19.1 不变量校验
    core/
      models.js  enums.js  ids.js  tokenization.js
    storage/
      sqlite.js                # node:sqlite 连接与 FTS5 建表
      raw_events.js  state_store.js  episodes.js  artifacts.js
      migrations/              # 版本化迁移（§23.6）
    indexing/
      lexical.js               # FTS5 + bm25
      semantic.js  metadata.js
    retrieval/
      hybrid.js  neighborhood.js  reranker.js
    context/
      classifier.js  compiler.js  budget.js  dedup.js  renderer.js
    llm/
      client.js                # 封装 ctx.llm.stream（§13.1 的限制在此生效）
      prompts.js  schemas.js
    memory/
      delta.js  projection.js  summarizer.js  audit.js
    global_scan/
      splitter.js
      worker.js                # worker 经 ctx.subagents.start 起（§11/§12）
      reducer.js
    host/
      seams.js                 # system-prompt/assemble · agent/pre-step · agent/request · ctx.compaction
      tokenmeter.js            # 适配宿主 ctx.tokenMeter（§9.6）
    tools/
      memory_tools.js          # §14 JIT memory tools
      commit_state.js          # §13.2 状态提交工具
  benchmark/
    api-bench.mjs              # §2.3 基准 + §25 报告
  tests/
    ...
  docs/  README.md
```

---

# 4. 数据模型

## 4.1 Raw Event：唯一事实日志

所有事件 MUST append-only。

建议 SQLite 表：

```sql
CREATE TABLE raw_events (
    event_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    thread_id TEXT,
    task_id TEXT,
    parent_event_id TEXT,
    role TEXT NOT NULL,
    event_type TEXT NOT NULL,
    content TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    token_count INTEGER,
    created_at TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}'
);
```

`event_type` 至少支持：

```text
user_message
assistant_message
tool_request
tool_result
artifact_created
artifact_updated
system_note
state_delta
```

`event_type` 的判定必须区分**真实用户输入**与**宿主注入的合成上下文**（v1.3 真机实测补充）：

- 宿主会把自身注入的内容也以 user 角色写进 surface —— 实测到的有
  `Current runtime context` 快照（单条 361 至 28,000+ token 不等）与
  `<system-reminder>` 技能目录（845 token，其 `source.kind` 为 `skill-catalog`）。
- 判定方向 MUST 是**反的**：只有 `source.kind === 'user'` 才算 `user_message`，
  **任何其它 kind 一律记为 `system_note`**。MUST NOT 用白名单（只认已知 kind），
  因为宿主的 kind 词汇表是 merge-extensible 的，插件可自行登记新 kind，白名单必然落后。
- 缺 `source.kind` 时按 `user_message` 处理（手搓/旧版事件的兼容面）。
- 两条都必须入索引（与宿主日志一致、可追溯），差别在 authority 与优先级：
  `system_note` 的 source_authority 为 0.6 而 user 指令为 1.0（§16.1），
  否则 1,206 token 的宿主样板会以最高权威挤占只有 0.135W 的 recent verbatim 预算。

MUST：

- 原始 `content` 不因任何 compact 操作修改。
- 同内容可通过 hash 去重存储，但 event 语义记录不可丢失。
- 每条派生 memory 必须保留 source event ids。

## 4.2 Authoritative State Item

```sql
CREATE TABLE state_items (
    state_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    item_type TEXT NOT NULL,
    key TEXT,
    value_json TEXT NOT NULL,
    status TEXT NOT NULL,
    confidence REAL,
    source_event_ids_json TEXT NOT NULL,
    superseded_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    version INTEGER NOT NULL
);
```

`item_type` MUST 至少支持：

```text
goal
constraint
fact
decision
assumption
rejected_option
open_question
resolved_question
artifact_state
plan_step
next_action
preference
```

`status` MUST 至少支持：

```text
active
superseded
resolved
rejected
uncertain
archived
```

### 核心规则

- 一个旧决定发生变化时 MUST `superseded`，不可直接 overwrite。
- `fact` 与 `assumption` 必须分开。
- 无 source 的长期 state 默认不得标记为 authoritative。
- 用户明确陈述优先级高于模型推断。
- state 的文本尽量短；具体证据通过 source pointer 获取。

## 4.3 Episode

```sql
CREATE TABLE episodes (
    episode_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    start_event_id TEXT NOT NULL,
    end_event_id TEXT NOT NULL,
    raw_token_count INTEGER NOT NULL,
    summary TEXT,
    summary_token_count INTEGER,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    closed_at TEXT
);
```

Episode 是**导航单元**，不是事实真相源。

## 4.4 Artifact

```sql
CREATE TABLE artifacts (
    artifact_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    logical_name TEXT NOT NULL,
    version INTEGER NOT NULL,
    uri TEXT,
    content_hash TEXT,
    summary TEXT,
    created_event_id TEXT,
    status TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}'
);
```

对于代码、文件、报告，MUST 使用 artifact/version 而不是把整个对象永久塞进 state。

---

# 5. State 设计：替代跨调用 CoT

## 5.1 原则

系统 MUST 保存的是**可验证推理状态**，不是思维过程。

禁止存储如下形式作为必要连续状态：

```text
我先想到 A，然后考虑 B，又发现 C......
```

推荐：

```yaml
objective: ...
active_constraints:
  - id: C17
    value: ...
    source: event_381

decisions:
  - id: D12
    value: ...
    rationale_short: ...
    evidence: [C17, E31]
assumptions:
  - id: A4
    value: ...
    status: unverified
open_questions:
  - id: Q8
    value: ...
next_action: ...
```

## 5.2 State Delta

每次主模型调用结束后 SHOULD 产生短 delta，而非重写 state。

内部格式固定为：

```json
{
  "upsert": [
    {
      "type": "decision",
      "key": "receiver_architecture",
      "value": "...",
      "status": "active",
      "source_event_ids": ["evt_..."]
    }
  ],
  "supersede": [
    {
      "state_id": "D12",
      "reason": "replaced_by_new_user_decision"
    }
  ],
  "resolve": ["Q7"],
  "open": [
    {
      "type": "open_question",
      "value": "..."
    }
  ],
  "next_action": "..."
}
```

默认约束：

- target：`<= 300 tokens`
- soft max：`500 tokens`
- hard max：`800 tokens`

若模型无法可靠同时输出答案 + delta，则 MUST 使用第二个**短调用**专门生成 delta；该调用输入只包含本轮 query、answer、当前 state 的最小必要部分。

## 5.3 Delta 验证

`StateDeltaProcessor` MUST：

- JSON schema validate。
- 检查 source_event_id 是否存在。
- 禁止无依据删除 active constraint。
- 检查 supersede target 是否存在。
- 对冲突 state 进入 `uncertain` 或等待 reconciliation，不得静默覆盖。

---

# 6. Episode Compaction

## 6.1 触发原则

禁止按“每 N 轮”机械压缩。

Episode SHOULD 在下列任一条件满足时关闭：

1. recent raw 自 episode 起累计达到 `0.115W - 0.191W`（`W=262144` 时即 30k-50k tokens）；
2. task/topic 明显切换；
3. 用户明确结束一个阶段；
4. artifact 完成一个稳定版本；
5. 长工具操作阶段结束。

默认 V1（`W` = 物理窗口，比例值取自 v1.0 在 `W=262144` 下的原始参数）：

```text
EPISODE_TARGET_RAW_RATIO = 0.153    # @262144 -> 40000
EPISODE_MIN_RAW_RATIO    = 0.076    # @262144 -> 20000
EPISODE_MAX_RAW_RATIO    = 0.229    # @262144 -> 60000

EPISODE_TARGET_RAW_TOKENS = clamp(0.153 * W, 20000, 64000)
EPISODE_MIN_RAW_TOKENS    = clamp(0.076 * W, 10000, 32000)
EPISODE_MAX_RAW_TOKENS    = clamp(0.229 * W, 24000, 80000)
```

**MUST NOT 将 episode 原始尺寸随 `W` 线性外推。** 理由：summary 输出上限是固定的（§6.2 的 500-1200 / hard 1600），保真度取决于**压缩端能力**，不取决于目标窗口。若线性外推，`W=1048576` 时将出现"160k 原始 token 压成 1600 token 摘要"（100:1），而设计基线是 40k→800（50:1），保真度会实质劣化。故 episode 尺寸带保真度上限。

窗口增大时，长历史的承载方式 MUST 是**更多 episode + 层级摘要**（§6.4），而不是更胖的 episode。

## 6.2 Episode Summary 输出

目标：`500-1200 tokens`，hard max `1600`。

固定字段：

```yaml
episode_id:
topic:
goal:
what_changed:
confirmed_decisions:
constraints_added_or_changed:
rejected_options:
open_questions:
artifacts_touched:
important_numbers_or_identifiers:
source_event_range:
search_keywords:
```

## 6.3 Summary 原则

MUST：

- 保留关键数字、文件名、接口名、显式否决项。
- 对硬约束尽量抽取原文。
- summary 可引用 state IDs，而不重复全文。
- 不得把 assumption 写成 fact。
- 不得删除 raw episode。

## 6.4 层级摘要

当 episode 数超过 20 SHOULD 创建 meta-summary：

```text
M01 = E001-E010
M02 = E011-E020
...
```

分组规模默认：

```text
META_SUMMARY_GROUP_SIZE = 10   # W <= 262144
```

分组规模 SHOULD 随窗口增大而**调小**（例如 `W >= 512k` 时取 5）。理由：导航层的粒度不应随历史总量劣化——窗口变大意味着 episode 总数变多，若分组规模不变，meta-summary 自身会退化成又一层需要被压缩的内容。

Meta-summary 只做导航。

MUST NOT 使用如下无限递归：

```text
summary_v1 -> summarize -> summary_v2 -> summarize -> summary_v3
```

父摘要 SHOULD 从固定子 episode summaries 重新生成。

---

# 7. Retrieval 系统

## 7.1 Hybrid Retrieval

**关键词检索为主，embedding 为辅**（v1.3 调整）。v1.0/v1.1 把 semantic 排在首位
（0.32 > lexical 0.28），该排序不再采用，理由见 §7.1.1。

候选集：

```text
candidate_set = union(
    lexical_search(query),      # FTS5 + bm25（CJK 逐字索引 + 二元组短语查询）
    summary_search(query),      # episode 摘要上的关键词检索（导航层）
    metadata_search(query),
    semantic_search(query)      # 可选分量：embedding 可用时才参与
)
```

建议初始评分：

```text
score =
  0.36 * lexical_score +
  0.14 * summary_score +
  0.12 * recency_score +
  0.12 * entity_task_score +
  0.10 * state_priority_score +
  0.06 * source_authority_score +
  0.10 * semantic_score          # 可选：缺失时按剩余权重重归一化
```

**缺分量的处理只有一条规则**：权重表固定声明，实际不可用的分量其权重被丢弃后
**按剩余权重重新归一化**。MUST NOT 为"没有 embedding"另写一套打分公式，
也 MUST NOT 引入开关式的第二分支。

权重可经 benchmark 调整（附录 C），但 `lexical` 排首位这一条属于 §7.1.1 的结论，
调整前 MUST 先给出反证。

## 7.1.1 为什么以关键词为主

1. **本项目的检索需求以精确性为主**。§7.2 的 exact-first 元素（数字、频率、波长、
   日期、文件名、函数名、UUID、错误信息、引号原话）全部是字面匹配；向量检索对它们
   既不更好，又额外引入依赖。
2. **窗口是稀缺资源**。实测可用输入上限仅 0.560W（§9.1.1），每一次召回都在消耗预算，
   故**精确率比"改写召回率"更重要**：向量召回擅长的正是措辞差异，但它同时带回更多
   低精确命中，而每条命中都要占窗口。
3. **中文本场景下关键词检索更可靠且完全确定**。实现层已解决 CJK 检索的两个坑：
   `unicode61` 不切分中文（中文查询全部落空），`trigram` 对**两字词**失效
   （预检/分词/中文 这类极常见词查不到），最终采用"CJK 逐字索引 + 二元组短语查询"，
   两字词与多字短语均可命中。该路径可复现、可审计、可逐字解释命中原因（`why=lexical/literal`），
   而向量命中无法解释。
4. **不宜再加外部依赖**。目标路由是免费/stealth 通道，实测已存在网关预检闸门
   （§9.1.1）与偶发 `provider_unavailable`；再引入一个 embedding 提供方意味着
   第二条网络依赖、第二套密钥与限流、第二个失败面。

## 7.1.2 embedding 的定位：降级，而非移除

- `semantic` 是**可选分量**，权重与其它辅助分量同级（0.10），不排在首位；
- embedding 不可用时系统 MUST 自动降级到"FTS/BM25 + summary + metadata + episode navigation"，
  功能不减少，只是少一条召回路径；此时权重按 §7.1 的唯一规则重归一化；
- 接入 embedding 时 MUST 保持可关闭，且其状态 MUST 可观测（§22.3 的
  `semantic_index_status`）；
- **`summary_search` 承担了 embedding 原本最主要的收益**——"换个说法也能召回"：
  episode 摘要由模型生成，措辞与原始事件天然不同，故对同义改写有容忍度；
  且摘要本就是本项目的派生物（§6），零额外依赖、零额外密钥。
  摘要命中作为**导航证据**注入，标注其 episode 与原始范围（§6.3：摘要不是真相源），
  分值刻意低于原始命中，且 MUST NOT 挤掉可追溯的原始证据。

## 7.2 Exact-first 规则

查询中含有以下元素时 SHOULD 提高 lexical/exact 权重：

- 数字
- 频率
- 波长
- 日期
- 文件名
- 函数名
- error message
- UUID/ID
- 引号中的原话

## 7.3 Neighborhood Expansion

任何命中的 raw event MUST 不直接孤立返回。

默认：

- 优先返回所属 episode 的局部连续片段；或
- 前后各 `2-5` events；或
- 在 token budget 内扩展至语义完整单元。

目的：避免孤立句子丢失限定条件。

## 7.4 Evidence Bundle

每个 retrieval hit MUST 包含：

```json
{
  "source_event_ids": ["..."],
  "episode_id": "...",
  "content": "...",
  "score": 0.0,
  "reason": ["semantic", "lexical", "task_match"],
  "token_count": 0
}
```

---

# 8. Context Mode 分类

`ContextModeClassifier` MUST 在每次调用前选择：

```text
LOCAL
BROAD
GLOBAL
```

## 8.1 LOCAL

适用：

- 普通连续聊天
- 当前代码修改
- 当前文档局部工作
- 当前问题可以由 state + recent history 解决

读取：

```text
state + recent raw + current artifact + small retrieval
```

## 8.2 BROAD

适用：

- “以前讨论过哪些……”
- 跨若干 episode 比较
- 需要回顾某项目阶段
- 当前 retrieval confidence 不高

读取：

```text
state + recent raw + episode summaries + multi-episode retrieval
```

必要时并行扫描候选 episodes。

## 8.3 GLOBAL

以下语义 MUST 强制或高概率进入 GLOBAL：

- “全部”
- “所有”
- “完整检查”
- “有没有遗漏”
- “检查所有历史是否矛盾”
- “逐一核对以前的约束”
- “不要漏任何一项”

GLOBAL MUST NOT 仅使用 top-k RAG 给出“完整”结论。

它必须 exhaustive scan 全目标范围，或明确告诉上层该范围没有被全部扫描。

---

# 9. Context Compiler

## 9.1 正常工作预算

**输入侧预算表达为物理窗口 `W` 的比例。** `W` 按请求解析（§2.1 / §9.6），MUST NOT 硬编码。

```text
NORMAL_TARGET_INPUT_RATIO = 0.458    # 实测可服务，沿用 v1.0
HEAVY_TARGET_INPUT_RATIO  = 0.500    # v1.0 的 0.649 被网关预检拒绝，见 §9.1.1
HARD_INPUT_CAP_RATIO      = 0.550    # 实测上限 0.560W × 安全系数 0.98 取整；v1.0 的 0.782 被预检拒绝
```

`W = 262144`（Union Alpha）时的取值，以及与 v1.0 的差异：

| 参数 | v1.0 比例 | v1.0 @262144 | **本版采用** | 采用值 @262144 | 网关预检计数（OpenRouter 路由） |
|---|---|---|---|---|---|
| normal target input | 0.458 | 120,062 | **0.458** | 120,062 | 203,265 ✓ |
| heavy target input | 0.649 | 170,131 | **0.500** | 131,072 | 221,905 ✓ |
| hard input cap | 0.782 | 204,997 | **0.550** | 144,179 | 244,095 ✓ |

v1.0 的 normal 比例保持有效。**heavy 与 hard 两档被实测下调**：v1.0 的 0.649/0.782 在真实调用中稳定返回 HTTP 400（§9.1.1），原因是上游网关另有一套比真实分词器保守约 1.7 倍的预检估算器，它才是实际约束。实测最大可服务输入为 **146,820 真实 token = 0.560W**（**测量值**），故 hard cap 取该值的 0.98 倍并取整为 **0.550**（**采用值**）。两者刻意区分：前者是单次实测的上界，后者是扣除安全余量后的配置值。

**上表全部数值均以 OpenRouter 路由为准。** 若切换到 opencode zen/go 路由（其闸门系数为 5.0 而非约 4.0），真实输入上限升至约 0.739W，届时 heavy 与 hard 可上调（详见 §2.1.2）。MUST NOT 在两路由间沿用同一组 `hard_input_cap`。

**MUST 保持的偏序**（顺序不可颠倒）：

```text
GLOBAL_CHUNK_TARGET_RATIO < NORMAL_TARGET_INPUT_RATIO < HEAVY_TARGET_INPUT_RATIO < HARD_INPUT_CAP_RATIO
        0.305            <           0.458           <           0.500            <        0.550
```

若该偏序不成立，并行扫描的 chunk 会撞上正常请求预算。注意 v1.0 时 heavy 与 hard 之间的余量是 0.133，本版收窄到 **0.060**——这是声明窗口（262144）与**可用**窗口（≈147k 真实 token）差距的直接后果，MUST NOT 通过抬高 hard cap 来恢复原有余量。

在 benchmark 后可调整比例值，但上述偏序、§9.1.1 的预检约束与 §9.6 的硬断言 MUST 始终成立。

MUST 保留足够 headroom：编译后输入 MUST NOT 超过 `HARD_INPUT_CAP_RATIO * W`。

**输入预算随 `W` 缩放；输出预算不随 `W` 缩放。** 后者由 decode TPS 决定，见 §17.1。二者不可混用同一套缩放规则。

## 9.1.1 网关预检：声明窗口不是可用窗口

上游网关在转发前会独立估算 token 数并校验，**该估算与模型真实分词器不是同一套**。实测（2026-09-17）：同一份填充文本，真实计数 **127,101** token 的请求被接受；而 1,050,000 字符的同源文本被拒，网关声称 "you requested about **262,517** tokens"，其与真实计数的比值稳定为 **1.693**。

> **本节是路由属性，不是模型属性。** 上段数值取自 **OpenRouter** 路由，其闸门估算系数约 4.0 chars/token。opencode zen/go 路由的闸门是**另一套**：系数确定性为 5.0 chars/token（1,354,000 字符被报为 270,882 token），闸门上限同为 262144（原文 "including the completion"），故该路由的真实输入上限约 **0.739W**，比 OpenRouter 高约 32%。两路由的完整对比见 §2.1.2。
>
> 由此推出两条 MUST：
> 1. **输入上限 MUST 按路由分别标定**，MUST NOT 由一条路由的结果外推到另一条，MUST NOT 写死在配置的单一常量里（§19 的 `preflight_ratio_assumed` 即为此而设，切换路由时 MUST 重标）。
> 2. **路由切换 MUST 触发预算重算**，含 `hard_input_cap`。§19.1 的不变量 6 即约束此点。

拒绝的响应是 HTTP 400，正文形如：

```text
This endpoint's maximum context length is 262144 tokens. However, you requested
about 262517 tokens (262509 of text input, 8 in the output). Please reduce the
length of either one, or use the context-compression plugin to compress your
prompt automatically.
```

由此确立三条 MUST：

1. **`W`（声明的 262144）MUST NOT 直接作为输入预算基准。** 可用输入上限约 `W / 1.693 ≈ 0.59W` 的**真实** token，且该比值**随内容变化**（网关以字符/字节类启发式估算，而真实分词器随内容在 3.5–6.8 chars/token 间波动，见 §9.6）。故 §19 中由 `W` 派生的预算 MUST 再受本节的预检上限夹取。
2. **MUST 实现自适应收缩**：捕获 400 且正文匹配 `maximum context length` 时，按比例收缩输入（建议 ×0.7）后重试，并**从正文中解析网关自报的计数**更新本会话的预检系数。MUST NOT 把该错误当作不可恢复失败，也 MUST NOT 无限重试（上限 2 次后降级为 LOCAL 模式并向上层报告）。
3. **每次请求 MUST 同时记录两个计数**：网关自报计数（成功时不可得，可从拒绝正文取得）与 `usage.prompt_tokens`。二者之比是本系统唯一可靠的容量校准信号，MUST 写入 §25 的 `preflight_calibration`。

**内容不对称风险（MUST 实测确认）**：英文实测网关高估 1.693 倍；中文真实 chars/token 约 2.0（英文 6.8），若网关同样以约 4.0 chars/token 估算，则对中文它将**低估**约 2 倍，此时约束重新回到模型自身的 262,144 真实上限。两种情形的失效模式相反（英文被网关提前截断，中文可能击穿真实窗口），故 MUST 按实际语料分别标定，MUST NOT 由英文结果外推到中文。

**另有一类与长度无关的失败**：实测大于 128k 真实 token 的请求中，多次出现 `http 200 + body error "ERROR"`（耗时 46–65 秒）与 `502 provider_unavailable`。这类失败与预检无关，属上游不稳定，MUST 由重试策略覆盖（§19 `retryPolicy`），MUST NOT 与长度拒绝混淆处理。

## 9.2 Normal Context 初始预算

各组件预算同为**物理窗口 `W` 的比例**。v1.0 绝对值保留为对照列。

**本版按 §9.1 的新 hard cap 等比收紧**：v1.0 的组件上界之和为 0.627，而本版 `HARD_INPUT_CAP_RATIO = 0.560`（§9.1.1 的预检上限所致），故组件上界之和 MUST ≤ 0.560。按 0.55 重标定后：

| 组件 | v1.0 比例 | **本版比例** | @262144 | v1.0 @262144 |
|---|---|---|---|---|
| System/protocol | 0.011–0.023 | **0.010–0.020** | 2.6k–5.2k | 3k–6k |
| Authoritative state | ≤0.046 | **≤0.040** | ≤10.5k | ≤12k |
| Recent verbatim | 0.092–0.153 | **0.080–0.135** | 21.0k–35.4k | 24k–40k |
| Episode navigator | ≤0.031 | **≤0.025** | ≤6.6k | ≤8k |
| Retrieved evidence | 0.092–0.183 | **0.080–0.160** | 21.0k–41.9k | 24k–48k |
| Current artifact | 0–0.191 | **0–0.170** | 0–44.6k | 0–50k |
| **上界之和** | 0.627 | **0.550** ✓ | 144.2k | — |

等价表达：

```text
System/protocol              0.010W - 0.020W
Authoritative state          <= 0.040W
Recent verbatim              0.080W - 0.135W
Episode navigator            <= 0.025W
Retrieved evidence           0.080W - 0.160W
Current artifact             dynamic 0 - 0.170W
----------------------------------------------
上界之和                      0.550W   (MUST <= HARD_INPUT_CAP_RATIO = 0.560W)
不含 artifact 的典型值         0.220W - 0.380W
```

各组件比例之和 MUST 不超过 §9.1 的 `HARD_INPUT_CAP_RATIO`，该断言在 §19.1 中 MUST 于加载时校验。**注意这是"上界之和"而非"典型值"**：artifact 通常远低于其上限，故正常运行落在 0.22W–0.38W，与 v1.0 的典型区间（0.305W–0.534W）相比有所下降，这是可用窗口比声明窗口窄 44% 的直接后果。

### 9.2.1 非 active 状态清单也占用 `authoritative_state` 预算

上下文里 MUST 包含一份**非 active 状态清单**（`rejected`，以及每个 `(item_type, key)` 的最新一次 `superseded`）。理由：

- §8.3 要求"否决项不得重新推荐"，§10.2 要求"明确否决项不得被移除"。只注入 active 项时，模型看不到"哪些方案已被明确否决"，因而可能重新提出——这与"state 里恰好没有它"是**不同的保证强度**。
- 该清单**不是新组件**：它属于状态，故计入 §9.2 的 `Authoritative state ≤ 0.046W`（`W=262144` 时 ≤10.5k token），并额外按该组件上界的 **35%** 限幅、最多 12 条，MUST NOT 挤掉 active 约束。
- `superseded` 只列每个键的**最新一次**：列出全部历史版本没有信息增益。

MUST NOT 把该清单当作事实陈述：按 §6.3 的原则，它只说明"某项已被否决/被取代"，需要精确依据时仍应回到原始证据。

## 9.3 Context 优先级

装箱优先级固定为：

1. 系统规则 / API protocol
2. 当前用户消息
3. Active hard constraints
4. 当前 task/goal/next action
5. 当前 artifact 必需内容
6. Recent verbatim
7. 高相关 original evidence
8. active decisions/facts
9. episode navigation
10. 次级 evidence
11. 旧工具输出/低价值历史

低优先级内容超预算时删除，而不是截断高优先级 hard constraint。

## 9.4 去重

ContextCompiler MUST 识别：

- state 中已存在且 evidence 重复的事实；
- episode summary 与 raw hit 重复；
- tool output 的重复版本；
- 完全相同 content hash。

原则：

- 对硬事实可保留一份 compact state + 一份最强原始证据。
- 不需要同时保留 5 个同义 summary。

## 9.5 Context Render 顺序

推荐固定顺序：

```text
[SYSTEM]
[CURRENT TASK]
[AUTHORITATIVE STATE]
[CURRENT ARTIFACT / WORKING MATERIAL]
[RECENT VERBATIM]
[RETRIEVED ORIGINAL EVIDENCE]
[EPISODE NAVIGATOR]
[USER QUERY]
[OUTPUT CONTRACT]
```

若底层 API 已单独传 system/user role，则按对应 role 实现，不要求拼成单字符串。

## 9.6 硬上限的推导与不变量

`HARD_INPUT_CAP` MUST 视为推导量，MUST NOT 作为独立可调参数设置。它由两条约束中**较紧的一条**决定：

```text
hard_input_cap = min(
    W - output_reserve - estimator_margin,        # ① 与声明窗口的关系（次要）
    W / preflight_ratio - output_reserve          # ② 与网关预检的关系（主要）
)
```

- `W`：当次路由模型的 `contextWindow`，语义为**请求与响应的合计上限**（含输出）。
- `output_reserve`：本请求实际传入的 `max_tokens`。MUST NOT 取模型声明的最大输出（Union Alpha 声明 131072，实际用量远低于此）。
- `estimator_margin`：本地估算误差余量。
- `preflight_ratio`：网关预检估算器相对真实分词器的倍数，实测 1.693（§9.1.1）。

**实测下约束 ② 明显更紧**：`W / 1.693 = 154,840` 真实 token，而约束 ① 允许到约 205k。故 v1.0 的 `HARD_INPUT_CAP_RATIO = 0.782` **不可用**——它落在约束 ② 之外，实测稳定 400。本版取 `0.560`（实测最大可服务值 0.560W 的整数化）。

编译期硬断言（MUST，两条都要校验）：

```text
estimated_input_tokens + requested_max_tokens <= 0.90 * W          # 约束 ①
preflight_ratio * estimated_input_tokens <= 0.98 * W               # 约束 ②，实际约束
```

**注意 `preflight_ratio` 是内容相关的**（§9.6 下文的三口径分析），故它 MUST 由本会话实测校正，MUST NOT 固定为 1.693 而不更新。

### token 计数 MUST 复用宿主 meter

系统 MUST NOT 自建独立 token 计数器，MUST 复用宿主 meter。理由：宿主自身的上下文压力定义（其 compaction 触发条件之一为 `pressure`）同样来自该 meter。若本系统用独立估算去决定"该压缩了"，将产生两套互相矛盾的压力语义，导致两个 reducer 对同一段历史各自做决定。宿主 meter 同时提供用量与成本分解投影，附录 B 的多数 telemetry 字段可直接取自该处。

因该 meter 亦为启发式估算，其返回值 MUST 按估算值对待——这正是上式中 `0.90` 而非 `1.0` 的原因。

### 估算误差实测：存在三个互不相同的 token 计数口径

这是本系统最容易被低估的风险。实测发现**同一份文本会被三种计数口径算出差异极大的数字**：

| 口径 | 说明 | 实测 chars/token |
|---|---|---|
| ① 真实分词器 | 从 `usage.prompt_tokens` 读出，唯一可信 | 见下表，随内容变化 3.5–6.8 |
| ② `chars/4` 朴素启发式 | 无依据的默认假设 | 固定 4.0 |
| ③ **上游网关预检估算器** | OpenRouter 发送前校验用，决定请求能否发出 | 约 4.0（比 ① 保守约 1.7 倍，见 §9.1.1） |

口径 ① 的实测值（多样本，2026-09-17）：

| 语料 | chars/token（中位） | 极差 | `chars/4` 相对实际的低估倍数 |
|---|---|---|---|
| 英文（自然句重复） | 3.546 | 3.546–3.546 | 1.13 |
| 中文 | 2.012 | 1.178–2.012 | **1.99** |
| 英文（伪随机词序） | 6.77 | 6.77–6.80 | 0.59（**高估 1.7 倍**） |

**关键结论：估算误差不是常数因子，而是内容相关，跨度约 2 倍（3.5–6.8 chars/token）。** 因此"取一个保守系数再加固定余量"的做法**在原理上不成立**——同一余量在此处不足、在彼处过量。实测中伪随机英文词序的 `chars/4` 反而高估 1.7 倍，与中文低估 2 倍的方向完全相反。

因此 MUST：

1. **以口径 ① 为准**：只用上游返回的 `usage.prompt_tokens` 做在线滚动校准，MUST NOT 依赖任何静态字符系数做预算判定。
2. 宿主 `ctx.tokenMeter` 的返回值仅可作为**调度用的相对压力指标**，MUST NOT 作为"是否超出硬窗口"的判定依据——它同样是启发式估算。
3. 在没有 ① 的历史（如会话开头、或冷启动时）MUST 采用**保守下界**（取 2.0 chars/token，即假设最坏情况），并在首次真实响应后用 ① 校正。
4. §25 的 `estimator_calibration` MUST 按内容类型分别采样，MUST NOT 只采一种文本就外推。
5. 因口径 ③ 独立于 ①，**请求能否发出由 ③ 决定**，故 §9.1.1 的预检约束是本系统的实际输入上限，不是 §9.1 的 `W` 比例。

---

# 10. Context Editing

## 10.1 可安全删除的历史

模型已经吸收且可从 raw store 恢复的内容 SHOULD 从 active prompt 移除：

- 旧 shell logs
- 大段重复搜索结果
- 旧 tool result
- 被更新后的 artifact 旧全文
- 重复 API response
- 已经抽取为 state 的冗余说明

## 10.2 不应自动删除

以下内容在未进入 authoritative state 或可恢复 evidence 前 MUST NOT 被 active context 无条件移除：

- 用户硬约束
- 明确否决项
- 精确数值
- 文件/接口定义
- 当前 artifact 关键片段
- 当前未解决错误信息

---

# 11. Global Exhaustive Scan

这是本系统相对普通 RAG 的关键能力。

## 11.1 Chunk 规则

默认 worker 输入（比例为 `W` 的占比）：

```text
GLOBAL_CHUNK_TARGET  = 0.305 * W     # W=262144 时 -> 79954 tokens（v1.0: 80000）
GLOBAL_CHUNK_OVERLAP = 0.008W - 0.015W   # W=262144 时 -> 2000-4000 tokens
```

MUST 满足 `GLOBAL_CHUNK_TARGET < NORMAL_TARGET_INPUT`（§9.1 偏序），否则 chunk 会超出正常请求预算。

实际比例值可按 TTFT benchmark 调整，MUST 以比例形式存储。

必须保证 chunk 在 episode 边界优先切分；若跨 episode，保留 overlap。

## 11.2 Worker 输出契约

Worker MUST 输出结构化、短结果，不输出长论文。

默认 hard cap：`300 tokens`；复杂任务可放宽至 `500`。

示例：

```json
{
  "findings": [
    {
      "claim": "...",
      "source_event_ids": ["..."],
      "category": "constraint|decision|conflict|evidence|missing",
      "relevance": 0.0,
      "conflict_with": ["state_id_if_any"]
    }
  ],
  "coverage": {
    "start_event": "...",
    "end_event": "...",
    "complete": true
  }
}
```

## 11.3 Reducer

Reducer MUST：

- 验证每个 worker coverage 是否连续覆盖目标范围。
- 去重 findings。
- 对冲突 findings 保留双方 source。
- 不因多数投票自动覆盖用户明确约束。
- 在 coverage 不完整时禁止声称“已检查全部”。

## 11.4 Global Scan 适用任务

- 历史约束审计
- 完整需求提取
- 查找所有旧决定
- 版本间矛盾检查
- 全会话总结
- “是否遗漏任何一项”验证

---

# 12. Subagent / Ensemble 策略

免费 API 允许多调用，但低 TPS 要求 worker “宽而短”。

推荐：

```text
Problem
  +-- worker A: evidence extraction <=300t
  +-- worker B: contradiction check <=300t
  +-- worker C: alternative interpretation <=300t
  +-- worker D: missing dependency check <=300t
                 |
              reducer
```

禁止默认：

```text
worker A 3000t -> worker B 3000t -> worker C 3000t -> reducer
```

原因：增加串行 decode 时间与状态污染。

**实测依据**（§2.1.1）：本路由 decode TPS 实测 **4.8–12.5，中位 9.9**。一条 `300` token 的 worker 输出需 **24–62 秒**；三条 3000 token 的**串行** worker 需 12–31 分钟。因此：

- 并行 worker 不是优化项，是**必需项**——串行链路延迟直接由 TPS 决定，无法通过工程设计补偿。
- 并发被实测证明有效：`n=1` 聚合 4.0 TPS，`n=4` 聚合 **27.9 TPS**（7 倍于单路），且 `n=4` 时单请求延迟仍约 6 秒。故并行 worker 的墙钟远低于串行之和，§2.2"允许增加并行 API calls"的设定成立。
- worker 输出上限 MUST 从严执行（§17.1）；"让它多说一点以便 reducer 判断"的诱惑在 10 TPS 下代价是分钟级。
- reducer 的输入是 worker 的结构化 findings，MUST NOT 要求 reducer 重读原始 chunk。

对于困难推理，可并行要求 worker 返回：

```text
conclusion
assumptions
evidence
failure_conditions
```

不要求暴露 CoT。

---

# 13. 主模型输出协议

系统建议将用户可见答案与内部控制数据分离。

**目标模型能力**（接口自述 + §2.1.1 实测）：`tools` / `tool_choice` 实测可用；`response_format` 仅 `json_object` 模式可用、`json_schema` 稳定 400；无可见 CoT。

**宿主缝的能力边界**（实测类型契约）：宿主 `GenerateOptions` **不暴露任何 `response_format` 字段**，可传字段仅 `provider, model, reasoningEffort, messages, system, tools, temperature, maxTokens, stop, signal, sessionId, purpose`。因此**本系统经宿主发起的任何调用都无法请求服务端 JSON 模式**——`json_object` 虽然上游支持，但从宿主缝发不出去。这是设计约束，MUST 在设计期即接受，MUST NOT 假定"接口支持即能用"。

因此存在两条互不相同的结构化路径，MUST 按"谁拥有该次调用"区分，MUST NOT 混用。

## 13.1 辅助调用（本系统拥有）：提示词 JSON 契约 + 本地校验

由本系统直接发起的调用（state delta 抽取 §5.2、episode summary §6.2、global worker §11.2）MUST 采用**提示词写明固定 JSON schema + 本地严格校验**。

三条被否决的路径及理由：

| 路径 | 结论 |
|---|---|
| `response_format: {type: json_schema}` | ❌ 上游稳定 HTTP 400（§2.1.1） |
| `response_format: {type: json_object}` | ⚠ 上游可用，但**宿主 `GenerateOptions` 不暴露该字段**，发不出去 |
| 依赖服务端保证输出结构 | ❌ 不可得。本地校验是唯一防线 |

**可用的增强手段**：宿主 `GenerateOptions.tools` **是暴露的**，且实测工具调用可用。故辅助调用 SHOULD 用"单一 function 工具 + 参数即 schema"的方式携带结构契约，较纯提示词更稳（模型在专用参数字段产出内容，多数上游会按参数 schema 校验）。`tool_choice` 不在宿主字段中，故 MUST 在提示词内明确要求调用该工具。

`json_object` 的唯一收益是减少 JSON 语法错误导致的整轮重试，此收益经宿主缝不可得。因此 §27.3 的本地 schema 校验 **MUST 完整实现**，且 MUST 覆盖四类失败：字段缺失、类型错误、幻觉字段、JSON 语法错误。

若某辅助调用确实需要线级 `response_format` 控制，唯一途径是注册自有 `LlmAdapter`（`ctx.llm.registerAdapter(providers, adapter)`）。**V1 SHOULD NOT 走此路径**——收益不足以抵消适配器维护与上游变更成本。

## 13.2 主对话路径（宿主拥有）：工具调用

主回答由宿主的 agent loop 发起，本系统无权强制其 `response_format`。故 state delta 的提交 SHOULD 通过注册工具（如 `contextvm_commit_state`）实现，由注入的协议段指示模型在收尾时调用。

默认契约：

```json
{
  "answer": "...",
  "state_delta": {...},
  "memory_requests": [],
  "confidence_flags": []
}
```

其中 `answer` 为主路径产出，其余字段由工具路径提交。

**MUST NOT 为抽取 delta 而在主路径之后无条件追加一次串行短调用。** 理由：低 TPS 下每增加一次串行 decode 都直接增加关键路径延迟，与 §2.2 的首要优化目标直接冲突。仅当工具路径实测不可用时，方降级为下述两步：

1. 第一次调用只生成 user answer。
2. 第二个短调用生成 state delta，该调用走 §13.1 的 `response_format`。

MUST NOT 因 delta 失败而丢失用户 answer。

---

# 14. JIT Memory Tools

若底层 API 支持 tools/function calling，可暴露：

```text
search_memory(query, filters, limit)
fetch_event(event_id)
fetch_events(event_ids)
fetch_episode(episode_id)
fetch_artifact(artifact_id, version, range)
search_artifacts(query)
```

Tool result SHOULD 只返回必要内容与 source IDs。

若模型需要更多历史，应允许多轮 tool retrieval，但设置：

```text
MAX_MEMORY_TOOL_ROUNDS = 3   # V1 default
```

超过后可切 BROAD/GLOBAL。

---

# 15. Memory Maintenance：在线与离线分离

## 15.1 在线关键路径

必须尽量短：

```text
append user event
-> classify mode
-> compile context
-> LLM answer
-> append assistant event
-> minimal state delta
-> return
```

## 15.2 非关键路径

以下 SHOULD 异步或批处理：

- episode summary
- embeddings
- FTS refresh
- entity extraction
- duplicate cleanup
- state reconciliation
- memory consistency audit
- hierarchy summary rebuild

若应用环境不能真正后台运行，则允许在下一轮请求前/空闲时执行，但不得阻塞正常 answer 超过配置阈值。

---

# 16. Memory 冲突与一致性

## 16.1 Authority 顺序

默认 authority：

```text
explicit current user instruction
> explicit historical user instruction
> verified external/tool result
> assistant-derived decision confirmed by user
> assistant inference
> summary text
```

## 16.2 冲突处理

发生冲突时：

- 不自动删除旧记录。
- 创建新版本。
- 标记旧项 `superseded` 或双方 `uncertain`。
- 保留 source IDs。
- 若无法判定且影响当前任务，主模型应显式处理不确定性。

## 16.3 Periodic Audit

每累计约 `10-20 episodes` SHOULD 执行一次 state audit：

检查：

- active constraints 是否互相冲突
- active decision 是否引用 superseded constraint
- open question 是否实际已解决
- artifact version 是否过期
- dangling source refs

Audit 输出仍采用短 patch，不重写整个 state。

---

# 17. Token 与延迟控制

## 17.1 生成限制

输出上限保持**绝对值，MUST NOT 随 `W` 缩放**：

```text
STATE_DELTA_TARGET_OUTPUT = 300     # soft 500 / hard 800
EPISODE_SUMMARY_MAX       = 1600
GLOBAL_WORKER_MAX_OUTPUT  = 300     # 复杂任务可放宽至 500
```

> **已删除 `ROUTER_MAX_OUTPUT` 与 `RERANKER_MAX_OUTPUT`**（v1.3 收口）。v1.0 为
> "LLM 路由器"与"LLM 重排器"预留了输出预算，但本实现中模式分类（§8）与检索打分（§7.1）
> 都是**确定性**的，不发起任何 LLM 调用：分类用语义标记匹配，排序用 §7.1 的加权公式。
> 保留这两个预算只会诱导出与 §2.2（优先减少串行生成 token）直接冲突的实现，
> 故一并移除，而不是留成无人使用的死配置。

这些上限是**串行 decode 延迟约束**（近似 `output_tokens / TPS_decode`），与物理窗口无关。窗口从 262k 变为 1M 时它们 MUST 保持原值；只有 §2.3 实测出 TPS 变化时方可调整。若误将它们随 `W` 线性放大，等于按窗口比例放大关键路径延迟。

主回答 output limit 由用户任务决定，不在 Context Proxy 层强行统一限制。

**输出上限只能用 `max_tokens` 强制。** 目标模型不支持 `stop` 参数，故 MUST NOT 依赖停止序列约束 worker 输出长度。

## 17.2 预算动态化

Context budget SHOULD 根据 benchmark 数据选择，且 MUST 以 `W` 的比例形式存储（而非绝对值），以便路由切换或模型更换时仍然有效。

示例策略（探测点亦按 `W` 的比例给出）：

```js
// W 按请求解析，不缓存跨路由
const W = (await ctx.llm.resolveModelInfo(provider, model)).contextWindow

// 探测点 MUST 落在网关预检可服务范围内（§9.1.1：实测上限 0.560W）
const normalTargetRatio = ttftMs(0.458 * W) <= 1.5 * ttftMs(0.24 * W) ? 0.458 : 0.37
const heavyTargetRatio  = isAcceptable(ttftMs(0.52 * W)) ? 0.50 : 0.44
```

MUST：`heavy_target_input` 与 `hard_input_cap` MUST NOT 超过上一次实测的预检可服务上限（本版 0.560W），否则调参会把系统推入必然 400 的区间。

不得假定所有 API 对长 prefill 的性能曲线相同。目标模型无公开 TPS/TTFT 数据（§2.1），本节所有阈值 MUST 由 §2.3 实测确定，MUST NOT 沿用其他模型的结论。实测 TTFT 在本路由上随长度增长平缓（§2.1.1），故本节的降档分支未触发，normal 保持 0.458W。

自动调参结果 MUST 写回比例值，MUST NOT 写回绝对 token 数。

---

# 18. 运行时与存储（V1 推荐实现）

## 18.1 运行时选型：宿主原生 Node.js，零原生依赖

V1 MUST 采用宿主插件的原生运行时（Node.js ESM），MUST NOT 采用跨语言 sidecar（如 Python 子进程）。理由：

1. ContextVM 是 DSH 插件，宿主为 Node.js。跨语言 sidecar 会引入 IPC、进程生命周期、崩溃恢复与打包**四份额外复杂度**，而规范要求的全部能力在 Node 下均可满足。
2. v1.0 所假定的 Python 独有收益（`sentence-transformers` / FAISS）在 v1.0 中本就标注为**可选**，且 §7.1 要求 embedding 不可用时必须能降级到 FTS + metadata + episode navigation。
3. 实测（2026-09-17，Node v24.14.1）：内置 `node:sqlite` 提供 **SQLite 3.51.2**，且 **`FTS5` 与 `bm25()` 均可用**（已实测建虚拟表、插入、`MATCH` 查询与 `bm25()` 排序打分）。因此 v1.0 的"最低可工作组合"**无需任何原生依赖即可落地**，不必引入 `better-sqlite3` 的编译与预构建风险。

## 18.2 依赖

```text
Node.js >= 22（本项目实测 24.14.1）
node:sqlite（内置，含 FTS5 + bm25）
宿主既有三方，不额外安装：
  @deepseek-ai/cordis  @deepseek-ai/schemastery  @deepseek-ai/dsh-tools
HTTP：经宿主 llm 服务，MUST NOT 直连上游
可选：embedding 服务（关闭时系统 MUST 仍可工作）
```

最小 V1 不应因为没有 embedding 而无法运行。最低可工作组合：

```text
SQLite 索引 + FTS5 + bm25
+ metadata filtering
+ episode summaries
+ state projection
+ exhaustive global scan
```

## 18.3 持久化位置与"真相源"边界

- 自有 SQLite 库 SHOULD 置于插件自有数据目录，MUST NOT 写入宿主会话存储（session jsonl）所在目录。
- **原始历史的真相源是宿主 session log，不是本插件。** SQLite 中的 raw event 副本与 FTS 索引是**派生索引**，MUST 可从宿主会话重建（§22.4）。
- 这与 §4.1 的 append-only 原则**同构而非冲突**：宿主 session log 本身即 append-only，其 surface 遮蔽（`surfaceOp: replace`）只把节点移出派生视图、不删除日志——正是 §4.1"raw 永不删，摘要/状态均为可重建派生物"的宿主原生实现。
- 仅当实现确需**跨会话、跨项目**的长期记忆时，方新建自有 raw store。V1 SHOULD NOT 复制宿主已有的原始日志。

## 18.4 迁移与版本化

所有 schema 变更 MUST 版本化（§23.6），迁移 MUST 可重放。启动时 MUST 校验 §19.1 的配置不变量；校验失败 MUST 拒绝启动并给出指名到具体条目的诊断，MUST NOT 以默认值静默继续。

---

# 19. 配置文件基线

建议 `config.yaml`。配置分为三类，**必须分开存放，不得混在同一层级**：

- `ratios`：**随物理窗口 `W` 缩放**的输入侧预算。运行时计算 `ratio * W`。
- `absolute`：**不随 `W` 缩放**的值——输出上限（由 TPS 决定）与各类计数（由语义决定）。
- `limits`：硬断言阈值。

```yaml
model:
  # W MUST 按请求解析（宿主 llm.resolveModelInfo().contextWindow），MUST NOT 硬编码。
  # 下表仅为 W=262144（Union Alpha）时的参考值，禁止写死。
  context_window_source: runtime        # runtime | override
  context_window_override: null         # 仅测试用；生产 MUST 为 null

# --- 随 W 缩放的输入侧预算（比例制） ---
ratios:
  # 输入侧预算。MUST 同时受 §9.1.1 的网关预检上限夹取（声明窗口 ≠ 可用窗口）
  normal_target_input: 0.458        # @262144 -> 120062（与 v1.0 同，实测可服务）
  heavy_target_input: 0.500         # @262144 -> 131072（v1.0 为 0.649，被预检拒绝）
  hard_input_cap: 0.560             # @262144 -> 146801（v1.0 为 0.782，被预检拒绝）
  # --- 网关预检（§9.1.1）---
  preflight_ratio_assumed: 1.693    # 网关预检估算 / 真实分词器；英文实测值
                                    # ⚠ 内容相关：中文 MUST 单独标定，禁止外推
  preflight_shrink_factor: 0.7      # 被 400 maximum-context-length 拒绝后的收缩系数
  preflight_max_retries: 2          # 超过则降级 LOCAL 并向上层报告
  token_estimate_floor_cpt: 2.0     # 无 usage 历史时的保守下界 chars/token（§9.6）
  estimator_margin: 0.10            # 仅用于校正宿主 tokenMeter 的相对压力；
                                    # MUST NOT 用于硬窗口判定（§9.6）
  # 组件上界之和 = 0.550，MUST <= hard_input_cap（§9.2 按新 hard cap 重标定）
  context_components:
    system_protocol: [0.010, 0.020]      # @262144 -> 2.6k-5.2k
    authoritative_state_max: 0.040        # @262144 -> 10.5k
    recent_verbatim: [0.080, 0.135]      # @262144 -> 21.0k-35.4k
    episode_navigator_max: 0.025         # @262144 -> 6.6k
    retrieved_evidence: [0.080, 0.160]   # @262144 -> 21.0k-41.9k
    current_artifact_max: 0.170          # @262144 -> 44.6k
  state_target: 0.031               # @262144 -> 8000
  state_hard_max: 0.046             # @262144 -> 12000
  final_bundle_target: 0.122        # @262144 -> 32000
  episode_target_raw: 0.153         # clamp 到 absolute.episode_raw_ceiling
  episode_min_raw: 0.076
  episode_max_raw: 0.229
  global_chunk_target: 0.305        # @262144 -> 79954 (v1.0: 80000)
  global_chunk_overlap: 0.011       # @262144 -> 2883  (v1.0: 3000)

# --- 不随 W 缩放（输出上限由 TPS 决定；计数由语义决定） ---
absolute:
  default_max_output_tokens: 4096   # 主回答，见 §17.1
  state_delta_target_tokens: 300
  state_delta_soft_max_tokens: 500
  state_delta_hard_max_tokens: 800
  episode_summary_target_tokens: 800
  episode_summary_hard_max_tokens: 1600
  global_worker_output_max_tokens: 300
  global_worker_output_complex_max_tokens: 500
  router_max_output_tokens: 120
  reranker_max_output_tokens: 120
  # episode 原始尺寸的保真度上限（§6.1）：防止随 W 线性外推
  episode_raw_ceiling: [64000, 32000, 80000]   # target, min, max
  lexical_top_k: 30
  semantic_top_k: 30
  merged_top_k: 40
  neighborhood_events_before: 3
  neighborhood_events_after: 3
  max_concurrency: 8                # MUST 由 §2.3 并发实测确定
  max_memory_tool_rounds: 3
  audit_every_closed_episodes: 15
  meta_summary_group_size: 10       # W>=512k 时 SHOULD 调小（§6.4）

# --- 硬断言（编译期与运行期均校验） ---
limits:
  envelope_assertion: 0.90          # input + requested_output <= 0.90 * W  (§9.6，按宿主估算)
  preflight_assertion: 0.98         # preflight_ratio_assumed * input <= 0.98 * W  (§9.1.1)
  ordering:
    - global_chunk_target < normal_target_input
    - normal_target_input < heavy_target_input
    - heavy_target_input < hard_input_cap
    - sum(context_components) <= hard_input_cap
```

## 19.1 配置不变量（MUST 校验）

加载配置时 MUST 校验以下断言，任一条失败则启动失败并给出明确诊断：

1. `global_chunk_target < normal_target_input < heavy_target_input < hard_input_cap`（§9.1）
2. 各 `context_components` 之和 `<= hard_input_cap`（§9.2）
3. `estimated_input + requested_max_tokens <= 0.90 * W`（§9.6，运行期每次编译前校验，按宿主估算）
4. `preflight_ratio_assumed * estimated_input <= 0.98 * W`（§9.1.1，运行期每次编译前校验）——**这一条才是实际约束**，第 3 条只是按宿主估算的粗筛
5. 生效的 `W` 来自当次路由，与上一次请求的 `W` 不同时 MUST 重新计算全部派生预算
6. `hard_input_cap` MUST 不超过上一次实测的最大可服务输入比例（本版为 0.560W）。若实现把该值配得更高，启动 MUST 失败并提示 §9.1.1

所有比例参数必须可配置，不得散落硬编码在业务逻辑。**绝对 token 数 MUST NOT 出现在业务逻辑中**，只能出现在 `absolute` 段（输出上限与计数），且必须携带"由 TPS / 语义决定，非由窗口决定"的注释。

---

# 20. Prompt Contracts

## 20.1 Episode Summarizer Prompt 核心约束

必须告诉模型：

- 这是导航摘要，不是新的事实来源。
- 精确保留用户约束、数字、标识符和否决项。
- 不得把推测升级为事实。
- 不解释无关背景。
- 输出固定 JSON/YAML schema。
- 控制输出长度。

## 20.2 State Delta Extractor

必须告诉模型：

- 只记录本轮新增或变化。
- 已存在且未变化的信息不得重复输出。
- 只有明确改变才 supersede。
- 推断必须标 `assumption`，不能标 `fact`。
- next_action 仅写一条最直接下一步。

## 20.3 Global Worker

必须告诉模型：

- 只分析分配给它的 chunk。
- 不假定 chunk 外信息。
- 每条 finding 必须 source event。
- 没有发现也要返回 complete coverage。
- 禁止长篇解释。

---

# 21. API 级接口建议

以下为**插件内部模块契约**（ESM）。与宿主的对接点集中在 `lib/host/seams.js`，见 §21.6。

## 21.1 插件入口（对宿主的契约）

```js
export const name = 'dsh-contextvm'
// 必需服务走 inject；可选服务一律用 ctx.get('x') 读取，
// 否则在未挂载该服务的部署下会直接抛错
export const inject = ['agents', 'sessions', 'systemPrompt', 'llm', 'tools']
export const Config = z.object({ /* §19 */ })
export function apply(ctx) { /* 注册宿主钩子、工具与维护队列 */ }
```

## 21.2 主入口

§15.1 的在线关键路径调用此函数。

```js
async function respond(sessionId, userMessage, { taskId, artifactRefs, signal } = {}) { ... }
```

## 21.3 Context Compiler

```js
async function compileContext(sessionId, query, mode, tokenBudget) { ... }
```

`CompiledContext` —— **注意编译产物是两路而非一路**：

```ts
interface CompiledContext {
  mode: 'LOCAL' | 'BROAD' | 'GLOBAL'
  renderedSections: AssembledSection[]   // -> system-prompt/assemble（含 tool schemas）
  admittedMessages: UserMessage[]        // -> agent/pre-step
  includedEventIds: string[]
  includedStateIds: string[]
  includedEpisodeIds: string[]
  tokenCount: number                     // 经宿主 tokenMeter 估算（§9.6）
  evidenceManifest: EvidenceRef[]
}
```

v1.0 的单一 `rendered_messages` 字段在此拆为 `renderedSections` 与 `admittedMessages` 两路，原因是宿主缝本身是分开的：system prompt 与 tool schemas 只能经 `system-prompt/assemble` 改写，而本步准入的消息只能经 `agent/pre-step` 改写（§3.1 `host/seams.js`）。两路 MUST 由同一次编译产出，MUST NOT 各自独立计算预算。

## 21.4 Retrieval

```js
async function retrieve(sessionId, query, filters, tokenBudget) { ... }
```

## 21.5 Global Scan

```js
async function exhaustiveScan(sessionId, query, scope) { ... }
```

## 21.6 宿主缝适配（`lib/host/seams.js`）

```js
// 改写 system prompt 分段与 tool schemas（返回值为权威）
ctx.on('system-prompt/assemble', async (assembly, context, next) => { ... })
// 注入本步准入消息（注入用；不是缩减历史的手段）
ctx.on('agent/pre-step', async (payload, next) => { ... })
// 仅可改 call config（provider/model/reasoningEffort/maxTokens）
ctx.on('agent/request', async (payload, next) => { ... })
```

MUST NOT 试图在 `llm/stream` 中改写请求：loop 构造的请求到达时已 deep-frozen，改写会抛异常（其内容是 session log 的纯函数）。`llm/stream` 仅可用于**观察**（telemetry）或**短路伪造响应**。

历史缩减的**唯一持久手段**是 session surface 层（`surfaceOp: replace`）或实现 `ctx.compaction`。若采用后者，MUST 先验证 `ctx.compaction` 在该部署下可否被插件替换——宿主中该服务是 per-agent-preset 挂载的，profile 插件未必可达。

## 21.7 辅助模型调用封装（`lib/llm/client.js`）

```js
async function auxCompletion({ purpose, system, messages, maxTokens, tools, signal }) { ... }
```

MUST 经 `ctx.llm.stream` 发起。注意宿主 `GenerateOptions` **不含任何 `response_format` 字段**，故本系统无法请求服务端 JSON 模式；结构化输出 MUST 依赖"提示词合同 + 本地校验"，或经 `tools` 携带参数 schema（§13.1）。

---

# 22. 故障恢复

## 22.1 LLM answer 成功、state delta 失败

MUST：

- answer 已 append raw log 后不撤销。
- state delta 标记 pending。
- 后续 maintenance 重试。

## 22.2 Episode summary 失败

MUST：

- raw episode 保持 closed/summary_pending。
- 不阻塞新 episode。
- 后续重试。

## 22.3 Embedding 失败

MUST：

- lexical retrieval 正常工作。
- semantic_index_status 标记 degraded。

## 22.4 数据库损坏/索引丢失

只要 raw_events 与 artifacts 存在，系统 SHOULD 可重建：

- FTS
- embeddings
- episodes summaries（可重跑）
- state projection（从 state_delta + raw 重建）

---

# 23. 安全与数据完整性规则

实现 Agent MUST 遵守：

1. 不允许 summary 删除 raw source。
2. 不允许无 source 的 state 自动提升为 confirmed fact。
3. 不允许 GLOBAL 在未覆盖完整 scope 时标记 complete。
4. 不允许 context truncate 把 user current message 截断。
5. 不允许 state projection 静默覆盖 conflicting active constraint。
6. 所有数据库迁移必须版本化。
7. 原始 event content 只追加，不原地编辑；若用户内容需要逻辑修正，以 correction event 表示。
8. 日志中不得写 API 密钥。

---

# 24. 测试计划

## 24.1 单元测试

至少覆盖：

- event append / read
- state upsert / supersede
- invalid source rejection
- episode boundary
- FTS exact numeric retrieval
- hybrid merge
- neighborhood expansion
- budget packing
- dedup
- GLOBAL chunk coverage
- reducer dedup
- crash recovery

## 24.2 合成长期记忆测试

构造 1M+ token synthetic conversation。

插入：

- 100 个精确数字约束
- 100 个名称/ID
- 50 个后来 superseded 的决定
- 50 个否决项
- 多个相似但不同的参数

测试：

### Exact Recall

询问早期精确值，要求 retrieval 命中原始 event。

### Supersession

询问当前有效决定，不得返回 superseded 版本作为当前结论。

### Negative Memory

询问已明确否决方案，不得重新推荐为 active 方案而无说明。

### Cross-Episode

问题需要组合两个相距超过历史总量 50% 的信息。

### Global Completeness

要求列出全部某类约束，并与 ground truth 比较 recall。

## 24.3 目标指标

V1 验收建议：

```text
Exact identifier recall @ 1M history        >= 99%
Active-vs-superseded state correctness      >= 99%
Global exhaustive scan coverage              = 100%
Global finding recall on synthetic set       >= 98%
Raw-source traceability                      = 100%
State item with valid provenance             = 100%
Normal context <= configured hard cap        = 100%
Recovery from semantic index failure         = pass
Recovery from summary failure                = pass
```

对于纯 semantic 开放问题不强制定量 99%，需单独人工评测。

## 24.4 可复现性限制

目标模型不支持 `seed` 与 `logprobs`（§2.1），因此合成测试**不可确定性重放**。测试设计 MUST 据此调整：

- §24.3 的指标本身已是 recall / 覆盖率形式（≥99%、=100%），该方向正确，无需改动。
- "Exact Recall" 类单点问答 MUST 允许重试，且 MUST 记录重试次数，避免在测试集中引入不可归因的随机失败。
- 判定 SHOULD 基于可验证的结构化产物（`source_event_ids`、worker 的 `coverage` 字段、state 版本链），而非自由文本比对。
- 涉及自由文本质量的项目 MUST 单列人工评测，MUST NOT 混入自动化通过率。
- §24.2 的合成语料 MUST 附带生成 seed 与生成脚本，使**语料本身**可复现（即使模型响应不可复现）。

---

# 25. 性能验收

实现完成后生成一份 `benchmark_report.json`，至少包括：

```json
{
  "model": "stealth/union-alpha",
  "measured_at": "...",
  "context_window": 262144,
  "prefill_tests": [],
  "concurrency_tests": [],
  "decode_tps": {},
  "recommended_ratios": {
    "normal_target_input": 0.458,
    "heavy_target_input": 0.500,
    "hard_input_cap": 0.560,
    "global_chunk_target": 0.305,
    "basis": "受 §9.1.1 网关预检夹取；hard cap 不得超过实测可服务上限"
  },
  "recommended_absolute": {
    "max_concurrency": 8,
    "episode_raw_ceiling": [64000, 32000, 80000]
  },
  "estimator_calibration": {
    "by_content_type": [
      { "kind": "ascii_natural", "chars_per_token": 3.546, "min": 3.546, "max": 3.546, "samples": 6 },
      { "kind": "cjk",           "chars_per_token": 2.012, "min": 1.178, "max": 2.012, "samples": 6 },
      { "kind": "ascii_random",  "chars_per_token": 6.770, "min": 6.770, "max": 6.800, "samples": 4 }
    ],
    "naive_chars_div_4_underestimate_ratio": { "cjk": 1.988, "ascii_natural": 1.128, "ascii_random": 0.591 },
    "note": "误差内容相关，跨度 2 倍；MUST NOT 用单一系数或固定余量外推（§9.6）"
  },
  "preflight_calibration": {
    "gatekeeper_over_real_ratio": 1.693,
    "observed_max_servable_real_tokens": 146820,
    "observed_max_servable_ratio_of_W": 0.5601,
    "rejected_at_gatekeeper_tokens": 262517,
    "by_content_type": [],
    "note": "网关预检为独立估算器，是实际输入上限；MUST 按内容类型分别标定（§9.1.1）"
  }
}
```

两点说明：

1. **推荐值 MUST 以比例形式存储**（`recommended_ratios`），MUST NOT 写回绝对 token 数。模型更换或路由切换后绝对值失效，比例仍然有效。绝对量只保留两类：由 TPS 决定的输出上限与并发数，以及由语义决定的计数。
2. **`estimator_calibration` 与 `preflight_calibration` 均为必测项**。有两套独立于本地计数的口径必须标定：
   - `usage.prompt_tokens`（真实分词器）——只能实测，无静态系数可替代；
   - 网关预检估算器（决定请求能否发出）——其倍数实测为 1.693，但**内容相关**，MUST 按内容类型分别标定。

   二者共同决定 §9.1 的比例取值与 §9.6 的两条硬断言。MUST NOT 沿用本文档的默认值而不做校准。

系统第一次运行 MAY 使用文档默认值，但 benchmark 完成后 SHOULD 自动写入本地 override config（比例形式）。

---

# 26. 实施阶段划分

## Phase A - 最小闭环

MUST 完成：

- RawEventStore
- StateStore
- FTS5
- LOCAL retrieval
- ContextCompiler
- 主 API 调用
- StateDelta
- 基础 tests

通过条件：`0.19W - 0.38W` 历史连续工作稳定（`W=262144` 时即 50-100k）。

## Phase B - 500k/1M 虚拟上下文

加入：

- EpisodeManager
- episode summarizer
- BROAD mode
- semantic retrieval（可选但推荐）
- provenance
- artifact refs

通过条件：1M synthetic memory tests。

## Phase C - Global Exhaustive Mode

加入：

- chunk splitter
- concurrent workers
- coverage verification
- reducer

通过条件：“全部/无遗漏”类测试达到指标。

## Phase D - Reliability & Performance

加入：

- benchmark auto tuning
- maintenance queue
- consistency audit
- crash/rebuild tools
- telemetry dashboard/log report

---

# 27. 本地 Agent 实现纪律

交给本地 Agent 后，以下条款视为硬约束：

## 27.1 不得自行替换架构核心原则

Agent 不得将设计简化为：

- “只保留最近 `W`”
- “只做一个 rolling summary”
- “只做 vector RAG”
- “每轮重新生成完整 memory”

除非明确提交设计变更说明并经人工批准。

## 27.2 先实现可验证最小系统

不得一开始引入复杂分布式基础设施。

V1 优先 `node:sqlite` + FTS5 + 宿主既有服务（§18）。MUST NOT 引入原生依赖、分布式组件或跨语言 sidecar。

## 27.3 所有 LLM 输出都视为不可信输入

必须 schema validate。

## 27.4 禁止依赖模型隐藏推理状态

任何跨调用必需状态都必须显式存在数据库中。

## 27.5 不允许用“模型应该记得”作为设计依据

若信息不在当前 active context、state 或可调用 memory tool 中，则系统应视为模型不可用。

---

# 28. 本地 Agent 首轮任务清单

Agent 开始后应严格按以下顺序：

1. 建立 DSH 插件项目骨架与配置系统（§3.1 目录、`cordis.patch.yml`、§19 配置 + §19.1 不变量校验）。
2. 实现 SQLite schema + migrations。
3. 实现 append-only `RawEventStore`（真相源为宿主 session log，见 §18.3）。
4. 实现 `StateStore` + supersession。
5. 实现 token 计数抽象（复用宿主 `ctx.tokenMeter` + 按语种系数，§9.6）。
6. 实现 SQLite FTS5 lexical retrieval。
7. 实现 LOCAL `ContextCompiler` 和 budget packer。
8. 接入宿主 `llm` 服务，经 `system-prompt/assemble` 与 `agent/pre-step` 完成最小对话闭环（§21.6）。
9. 实现 state delta extraction + validation。
10. 编写 100k synthetic test。
11. 实现 EpisodeManager + summary。
12. 扩展至 1M synthetic test。
13. 实现 BROAD mode / hybrid retrieval。
14. 实现 GlobalScanner。
15. 执行 API TTFT/TPS/concurrency benchmark。
16. 自动调节 context / chunk / concurrency defaults。
17. 加入 consistency audit 和 rebuild 工具。
18. 输出最终测试报告与运行手册。

在第 10、12、14、16 步必须形成 checkpoint；若测试失败，禁止继续用更多功能掩盖基础错误。

---

# 29. Definition of Done

只有满足以下条件才可宣布 V1 完成：

- [ ] 原始事件 append-only 且可持久恢复。
- [ ] 1M token synthetic history 可正常存储与检索。
- [ ] 早期精确数字/ID 可从 raw evidence 追溯。
- [ ] superseded decision 不会作为当前 state 使用。
- [ ] normal context 不超过 hard cap。
- [ ] episode summary 失败不会破坏主对话。
- [ ] embedding 关闭时系统仍可工作。
- [ ] GLOBAL 模式覆盖完整 scope 并验证 coverage。
- [ ] worker 输出受限且 reducer 可正确合并。
- [ ] state delta schema validation 完整。
- [ ] crash 后可恢复。
- [ ] benchmark 已完成并生成推荐参数。
- [ ] 所有关键 memory 均具有 source provenance。
- [ ] README 含启动、配置、测试、重建步骤。

---

# 30. 最终架构判断

本系统不把“上下文长度”视为一个单一模型参数，而将其拆为：

```text
Physical Working Context
+ Authoritative External State
+ Immutable Raw History
+ Searchable Episodic Memory
+ JIT Evidence Retrieval
+ Exhaustive Parallel Scan
```

对本项目所使用的免费低 TPS 模型而言，最优策略不是追求最大单请求上下文，而是：

```text
多输入，少生成；
状态显式化，CoT 不依赖；
普通任务按需检索，完整性任务穷举扫描；
所有摘要可丢，原始历史不可丢；
所有长期结论可追溯，所有旧决定可版本化。
```

这套设计的目标不是伪造一个“真正 1M attention”的模型，而是构建一个在长期真实工程任务中能够稳定使用 1M+ 历史、可恢复、可审计、可扩展的 Context Virtualization Layer。

---

# 附录 A：推荐状态 Schema

```json
{
  "session_id": "...",
  "objective": [],
  "constraints": [],
  "facts": [],
  "decisions": [],
  "assumptions": [],
  "rejected_options": [],
  "open_questions": [],
  "artifacts": [],
  "plan": [],
  "next_action": null,
  "projection_version": 1
}
```

# 附录 B：推荐日志指标

每次 request 至少记录：

```text
request_id
session_id
context_mode
input_tokens
output_tokens
ttft_ms
total_latency_ms
decode_tps
retrieval_latency_ms
retrieved_event_count
retrieved_token_count
state_token_count
recent_token_count
artifact_token_count
context_compile_ms
state_delta_tokens
```

GLOBAL 额外：

```text
scan_scope_tokens
chunk_count
max_concurrency
worker_failures
coverage_ratio
reducer_input_tokens
```

# 附录 C：实现中允许调节、但不得改变语义的参数

可通过 benchmark 调节：

- normal/heavy context target
- global chunk size
- concurrency
- episode target size
- retrieval top-k
- hybrid weights
- neighborhood size

不得由自动调参改变：

- raw history 永久保留原则
- state versioning
- provenance requirement
- GLOBAL 完整覆盖要求
- “不依赖 hidden CoT”原则
- summary 不是真相源原则

