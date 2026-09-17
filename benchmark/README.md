# benchmark 目录说明

本目录分两类脚本，**维护策略不同**，不要混用。

## 一、套件脚本（维护中）

会重复运行、其产出被规范引用的脚本。它们共用 `shared/fixtures.mjs`：凭据读取、
目标路由常量、伪随机填充文本、统计小工具都只有一处定义。

| 脚本 | 用途 | 产出 |
|---|---|---|
| `api-bench.mjs` | §2.3 基准：TTFT / decode TPS / 并发 / 输出长度 / 语种校准 | `benchmark_report.json` |
| `preflight-limit.mjs` | 网关预检系数与真实可服务输入上限（§9.1.1） | `preflight-limit.json` |
| `prefill-limit.mjs` | 大 prefill 的失败是尺寸相关还是偶发 | `prefill-limit.json` |
| `prefill-bisect.mjs` | 二分定位容量拒绝边界 | （写入 `prefill-limit.json`） |
| `rebuild-report.mjs` | 合并预检标定并**确定性重算**推荐比例（不发起上游调用） | 覆写 `benchmark_report.json` |
| `verify-spec.mjs` | 规范数值不变量与陈旧数值终检（纯离线） | 退出码 |
| `measure-opencode-union.mjs` | opencode zen/go 路由的用量/上限/TPS 测量（§2.1.2） | `opencode-union-measure.json` |
| `measure-opencode-detail.mjs` | 容量拒绝正文、流式事件格式、非流式 TPS | `opencode-detail.log` |

用法（需要 `.credentials.yaml` 中已注册的密钥；脚本不会打印密钥）：

```bash
node benchmark/api-bench.mjs                 # 全部阶段
node benchmark/api-bench.mjs --extended      # 追加 1024/2048 输出与 0.732W prefill
node benchmark/preflight-limit.mjs
node benchmark/rebuild-report.mjs            # 离线，把预检标定并回报告
node benchmark/verify-spec.mjs               # 离线
```

## 二、一次性侦察脚本（归档，不再维护）

`probe-opencode-*.mjs`、`stream-check.mjs` 是排查 opencode 路由时的**一次性探针**，
其结论已固化进规范 §2.1.2（Anthropic 通道的鉴权头、必需头、流式空流、对照实验等）。
它们保留的原因为**证据可复跑**，而不是作为工具维护。

因此：

- 它们各自带一份凭据读取样板，**不**改用 `shared/fixtures.mjs`（避免为归档物引入改动面）；
- 它们**不得**解析其他脚本的源码来取常量（曾有过这种隐式耦合，已由
  `tests/fixtures.test.mjs` 的卫生检查禁止）；
- 若将来仍需用其中某个探针，先确认其前提是否已变（例如上游改了鉴权方式）。

## 三、语料可比性约束（重要）

`shared/vocab.txt` 与 `shared/fixtures.mjs` 的 `genFiller` **逐字决定**填充文本的形态，
进而决定 chars/token 与全部 prefill 档位。规范中引用的实测值
（`6.77` chars/token、`TTFT 27.3s@8k / 32.8s@32k`、预检系数 `1.693` 等）都基于当前语料。

改动词表或生成器会让同 seed 的文本完全改变，**使已测结果失去可比性**。
`tests/fixtures.test.mjs` 用内容哈希锁住语料：任何会改变语料的改动都会让它失败，
迫使改动者显式确认。
