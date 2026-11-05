# 会话数据目录与日志体积（Refs #52 / #53）

> 状态：已实施（分支 `fix/log-hygiene`，基于 origin/release/0.9.0）。
> 范围：日志轮转、prompt 落盘开关。本文回答两个问题：数据目录里有什么、各文件会涨到多大。

## 1. 数据目录在哪里

- 默认（`--wayang-root` 未指定）：`~/.wayang/`；指定后：`<wayang-root>/.wayang/`。
- 配置文件：`<wayang-root>/.wayang.config.json`。
- 每个 session 一个目录：`<wayang-root>/.wayang/sessions/<sessionId>/`，其中 `sessionId` 形如 `20261105-103000-abcd`。

一个 session 目录内的文件与增长预期：

| 文件 | 内容 | 增长模型 | 上限 |
| --- | --- | --- | --- |
| `wayang.log`（+ `.1` … `.N`） | 运行日志（pino，pretty 单行格式） | 默认只记元数据：每轮 LLM 调用一条 `LLM call start`（模型 / 消息条数 / token 估算）+ 一条 `LLM call done`，加上任务调度 / 审计类 INFO 行 | 按大小轮转，默认 10MB × 保留 3 份（见下） |
| `conversation.jsonl` | controller 对话（append-only） | 每回合一条 entry；工具结果双层截断（工具层 + 写入层兜底，见 §3） | 无轮转（历史不可重写）；单条工具结果 ≤ `TOOL_OUTPUT_MAX_CHARS`（默认 20000 字符） |
| `workers/<workerId>/conversation.jsonl` | 各 worker 对话（append-only） | 同上 | 同上 |
| `runtime-state.json` / `tasks.json` / `signals.jsonl` 等 | 状态快照 | 随任务数线性 | — |

## 2. 日志：默认不落全量 prompt，体积有界（#52）

历史问题：controller 每次 LLM 调用前把**完整 messages 数组**以 DEBUG 落盘，长会话下日志量 = 调用次数 × 上下文长度（实测单文件 41MB，单条最大 507KB），且无任何轮转。

现行为：

1. **默认只记元数据**。`LLM call start` 携带 `model` / `messageCount` / `estimatedTokens`，不含任何消息内容。`LLM call done` 记录 usage 与耗时（原有行为）。
2. **全量 prompt 由开关控制**。`WAYANG_LOG_PROMPTS=1`（或 `true`）时，`LLM call start` 额外携带完整 messages——经过脱敏：`Authorization` / `apiKey` / `token` / `secret` / `password` 的值替换为 `[REDACTED]`，裸密钥形态（`sk-…`、`tvly-…`、`ghp_…`、`AKIA…`）同样替换，用户主目录绝对路径折叠为 `~`。开关需要 DEBUG 级别（`--verbose`）才生效。
3. **按大小轮转**（兜底，非功能）：`wayang.log` 达到 `logging.maxFileSizeBytes`（默认 10MB）后，下一次写入前整组平移：`wayang.log → wayang.log.1 → … → wayang.log.N`，最旧一份删除。无定时器、无压缩，写入是同步 append，每行落盘即持久。
4. **DEBUG 关闭时零额外开销**：钩子先查日志级别再构建 payload，info 级别下完全不遍历 messages。

配置（`~/.wayang.config.json` 的 `logging` 节，均可省略）：

```json
{
  "logging": {
    "maxFileSizeBytes": 10485760,
    "maxFiles": 3
  }
}
```

日志总体积上界 ≈ `maxFileSizeBytes × (maxFiles + 1)`，默认 ≈ 40MB。

## 3. transcript：写入层统一截断兜底（#53）

工具层截断（puppet 工具 8000 字符、claude-code worker 2000 字符）仍是第一道；新增**写入层兜底**：任何写入 `conversation.jsonl` 的工具结果（`buildAssistantEntry` 与 claude 工具记录两条路径）超过 `TOOL_OUTPUT_MAX_CHARS`（默认 20000 字符，环境变量 `WAYANG_TOOL_OUTPUT_MAX_CHARS` 可调）时，保留头尾并标注省略量，例如：

```
<前 70% 内容>… [omitted 812345 of 836525 chars] …<后 20% 内容>
```

即使某工具新增时忘记包 `safeExecute`、或 `read-worker-conversation` 抬高了单次返回上限，transcript 与后续回放的上下文也不会被单条巨量输出撑爆。

## 4. `--resume` 与日志的关系

resume 只读 `conversation.jsonl` / `runtime-state.json` / `tasks.json` / `signals*`，**从不读 `wayang.log`**；日志轮转也不触碰任何 conversation / 状态文件。因此日志治理不影响恢复流程（有测试覆盖：轮转发生后 restore 正常读全量历史）。

## 5. 典型 1 小时会话的体积估算（#52 验收）

以实测会话 `20261104-195156-nsvg`（15.2h）为基线：112 次 LLM 调用、360 条 controller 条目、23 个 worker。改动前 `wayang.log` 平均 ~2.7MB/h（其中 DEBUG prompt dump 占 78%）。改动后：

- 每轮 LLM 调用的 `LLM call start` 从「全量 messages（实测单条最大 507KB、平均 ~286KB）」变为元数据一行（~150 字节），缩小约 3~4 个数量级；
- 按同一会话的调用频率（~7.4 次/h）与条目量估算，`wayang.log` 每小时 ≈ 0.1~0.3MB（INFO 行为主），**15 小时量级 ≈ 2~5MB**，远低于轮转阈值；
- 极端多轮会话即使触到阈值，总量也被 `10MB × (3+1) = 40MB` 封顶（改动前同类会话已观测到 69MB 且无上界）。
