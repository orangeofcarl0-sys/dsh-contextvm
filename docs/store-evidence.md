# ContextVM 生命周期与证据

本文件记录插件的持久化位置、写路径与失败边界，供宿主权限审查与运行审计使用
（`package.json` 的 `dsh.permissions.lifecycleEvidence` 指向本文件）。

## 1. 持久化位置

| 数据 | 位置 | 是否真相源 |
|---|---|---|
| 原始对话历史 | 宿主 session log（本插件不复制、不改写、不删除） | **是** |
| raw_events 索引 | `<dshHome>/contextvm/contextvm.db` | 否，可从宿主 session log 重建 |
| FTS 检索索引 | 同上（`raw_fts` 虚表） | 否，可从 `raw_events` 重建 |
| 权威状态 state_items | 同上 | 否，可从 raw + delta 重放重建 |
| episodes 摘要 | 同上 | 否，重跑即可 |
| kv（token 标定等） | 同上 | 否，缺失时回退到保守下界 |

`dshHome` 取 `DSH_HOME` 环境变量，缺省为 `~/.dsh`。**不写入工作区、不写入会话存储目录。**

## 2. 网络与模型调用

- 所有模型调用**一律经宿主 `llm` 服务**，本插件不直连任何上游、不自行读取密钥。
- 密钥由宿主凭据面解析后交给 pi-ai 适配器，插件代码中不出现任何密钥。
- 无独立外呼端点；`dsh.permissions.externalServices = none`。

## 3. 写路径

- 仅一个 SQLite 库文件（+ WAL/SHM 同级文件）。
- 不写文件系统其它位置；日志只经宿主 `ctx.logger`。

## 4. 失败边界与降级

| 失败 | 行为 |
|---|---|
| 数据库不可用 | 启动即失败并给出原因（不静默以内存库顶替） |
| 配置不变量不通过 | 拒绝启动，指出具体条目 |
| 宿主 `llm` 服务缺失 | 不注入上下文，本轮放行原始装配，日志记 warn |
| 注入过程抛错 | 放行原始装配，MUST NOT 破坏本轮请求 |
| 上游容量拒绝（§9.1.1） | 捕获后按 `preflight_shrink_factor` 收缩注入并重试，最多 `preflight_max_retries` 次，之后交还宿主 |
| delta 抽取失败 | 先写 pending 再异步处理；失败保持 pending 可重试，**不影响已产出的回答** |
| episode 摘要失败 | 保持 `summary_pending`，不阻塞新 episode，不触碰原始事件 |
| 单个 worker 失败 | 计入 `failedChunks`，最终 `coverage.complete = false`，且禁止声称"已检查全部" |
| 索引丢失/损坏 | `rebuildSearchIndex()` 从 raw 重建；`verifyRebuildability()` 校验 |
| 维护作业超时/抛错 | 隔离该作业并计数，其它作业照常；不阻塞对话 |

## 5. 审计与可观测

- `Telemetry.report()` 汇总编译次数/模式分布、episode 关闭原因、delta 应用与拒绝、
  扫描覆盖完整率、维护作业成败。不可得字段（如 `ttft_ms`、`artifact_token_count`）
  显式记为 `null` 并在 `notes` 中说明，**不以估算值顶替实测值**。
- `auditState()` 输出短 patch（只做不安全→uncertain / 未决→已解决的安全迁移），
  **绝不删除任何状态项**。

## 6. 已验证证据（可复跑）

```bash
npm test                          # 109 项审计与验收测试，全部用内存库与假端口
node benchmark/verify-spec.mjs    # 规范数值不变量与陈旧数值终检
```

测试覆盖的硬约束包括：追加-only 语义、状态版本链与 supersede、无 source 不得 active、
乐观版本冲突不静默覆盖、预算严格不超额、GLOBAL 覆盖不完整时禁止声称完整、
worker 跨块引用来源即判为幻觉、崩溃后索引可重建。
