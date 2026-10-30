<div align="center">

<img src="../assets/wayang-logo.png" alt="Wayang" width="500">

### Welcome to play with Wayang

用自然语言指挥多个 AI Agent — 自动规划、调度、并行执行。

[English](../README.md)

</div>

---

## 为什么需要 Wayang

复杂的 AI 工作流不能只靠单个对话。Wayang 提供一个智能 **Controller** 作为主控大脑，自动理解用户意图、规划任务、调度多个 **Worker** 并行执行，并汇总结果 — 用户只需自然语言对话，剩下的交给 Wayang。

|          | 能力                                            |
| -------- | ----------------------------------------------- |
| **规划** | 将复杂需求拆解为可并行的子任务                  |
| **调度** | 自动分配 Worker，控制并发上限                   |
| **协调** | 汇总结果，保持上下文连贯                        |
| **响应** | Worker 执行期间可继续与 Controller 对话，不阻塞 |

## 功能特性

- **智能调度** — Controller 通过 LLM 自动拆解任务、分配 Worker 并行执行
- **非阻塞交互** — 任务执行中可继续对话，不阻塞工作流
- **任务生命周期** — 完整追踪：创建 → 执行 → 进度上报 → 完成 / 失败
- **多 Worker 并行** — 支持多个 Worker 同时执行不同任务，可配置并发上限
- **丰富 TUI** — 基于 Ink (React for CLI) 的终端界面，支持流式输出、斜杠命令、快捷键
- **会话恢复** — `wayang --resume` 恢复中断的会话，崩溃后自动清理
- **可扩展 Worker** — 内置 Puppet Worker 和 Claude Code Worker，支持自定义第三方 Worker
- **上下文压缩** — 自动 compact 防止 token 溢出

## 架构

```
┌────────────────────────────────────────────────────────┐
│                    CLI (Ink / React)                   │
├──────────────────────┬─────────────────────────────────┤
│     Controller       │           Worker Pool           │
│     （主控大脑）       │       (并行执行任务)              │
│     - 理解用户意图     │  - bash / read / write          │
│     - 规划与拆解       |  - call_agent                   │
│     - 汇总结果         │  - done / fail 终止             │
├──────────────────────┴─────────────────────────────────┤
│             Supervisor (编排 + 生命周期)                 │
├────────────────────────────────────────────────────────┤
│  Signal Queue · Task Pool · Task Scheduler             │
│  Event Bus · State Persistence · Crash Recovery        │
└────────────────────────────────────────────────────────┘
```

**核心理念：** _LLM 负责智能（理解、判断、回复），代码负责机械（调度、排队、状态管理）。_

## 快速开始

### 环境要求

- Node.js >= 20

### 安装

```bash
npm install -g wayang-ai
```

安装完成后，终端即可使用全局命令 `wayang`（或简写 `waya`）：

```bash
wayang          # 启动新会话
waya            # 简写
wayang --resume # 恢复上次会话
```

首次运行会进入交互式配置向导，填入 LLM provider 信息即可开始使用。

### 配置

首次运行会自动进入交互式配置引导，填写 LLM Provider 信息即可。

也可手动创建 `~/.wayang.config.json`：

```json
{
  "providers": {
    "my-model": {
      "endpoint": "https://api.anthropic.com",
      "modelName": "claude-sonnet-4-20250514",
      "apiKey": "xxx"
    }
  },
  "controller": { "provider": "my-model" },
  "worker": { "provider": "my-model", "maxConcurrency": 3 }
}
```

API Key 可通过配置文件或环境变量 `WAYANG_LLM_API_KEY` 设置。

Worker 默认使用 `"toolChoice": "required"`——强制每一步都产生工具调用，从而保证 worker 最终必须通过 `done`/`fail` 工具收尾。部分 OpenAI 兼容端点（如内部 llmproxy）不接受 `tool_choice: "required"`（返回 HTTP 400），此时可在 `worker` 段按端点改为：

```json
"worker": { "provider": "my-model", "maxConcurrency": 3, "toolChoice": "auto" }
```

### 启动

```bash
wayang                # 新建会话
waya                  # 使用别名
wayang --resume       # 恢复上次会话
wayang --resume 20260403-143052   # 恢复指定会话
wayang --resume --all             # 查看所有会话并选择
```

### CLI 参数

| 参数                  | 说明           | 默认值                  |
| --------------------- | -------------- | ----------------------- |
| `--home-dir`          | 数据存储目录   | `~/.wayang`             |
| `-w, --workspace-dir` | Agent 工作目录 | 当前目录                |
| `-c, --config`        | 配置文件路径   | `~/.wayang.config.json` |
| `--resume [id]`       | 恢复会话       | —                       |
| `--verbose`           | 启用详细日志   | —                       |

## 项目结构

```
src/
├── cli.ts               CLI 入口
├── bootstrap.ts          启动编排
├── onboard.ts            首次配置交互
├── session-select.ts     会话选择
├── ui/                   UI 层 (Ink 组件 + hooks + 页面)
├── services/
│   ├── supervisor.ts     DI 容器 + 生命周期
│   ├── controller-loop.ts 主控循环
│   ├── agents/           Agent 层 (Controller + Worker + Prompts + State)
│   ├── task/             任务领域 (pool + scheduler + state)
│   ├── signal/           信号领域 (queue + event sourcing state)
│   ├── session/          会话领域 (manager + state)
│   └── tools/            Tool 实现 (13 tools)
├── infra/                基础设施 (event-bus, logger, state framework, persistence)
├── types/                共享类型
└── utils/                工具函数
```

## 技术栈

| 维度       | 选择                |
| ---------- | ------------------- |
| 语言       | TypeScript          |
| LLM SDK    | Vercel AI SDK       |
| CLI 框架   | Ink (React for CLI) |
| CLI 参数   | meow                |
| 预启动交互 | prompts             |
| Agent 调用 | Claude Agent SDK    |
| 持久化     | JSONL + JSON 文件   |
| 日志       | pino                |
| 构建       | tsup                |
| 测试       | vitest              |

## 测试

```bash
npm test           # 27 test files, 277 tests
npm run test:watch # 监听模式
npm run lint       # 类型检查 + lint
```

## 路线图

**愿景:** 从"多智能体 CLI"进化为**多 agent 协作 + 工作台**。以下主题按优先级排序,不与具体小版本绑定——范围随真实使用反馈调整。

1. **协作核心** — 结构化规划(`plan` / `repl`)、任务组与依赖(拓扑派发)、人类可读的任务编号(`WAY-N`)、git worktree 隔离(多 worker 并行改同一仓库)、worker 间协作通道、跨会话待办池
2. **执行增强** — MCP 工具挂载、内置工具拓展(git / 代码导航 / web fetch)、per-worker 工具 allowlist 与技能包、长会话硬化
3. **开放接入** — ACP 客户端:经 Agent Client Protocol 接入 Gemini CLI、Claude Code、Codex CLI、OpenCode 作为 worker
4. **WebUI 工作台** — 浏览器里的对话、任务看板、审批中心与 worker 会话回放,终端与浏览器可同时在线;待协作核心把数据模型做厚后落地
5. **常驻与远程** — daemon 常驻 + 定时跑 backlog("永动机"形态,默认人在环)、远程安全接入、任务通知
6. **记忆与质量闭环** — workspace 知识库、任务归档检索、review worker、以测试通过为完成标准(DoD)
7. **生态与稳定** — worker 插件协议与脚手架、社区技能目录、沙箱、分发

**贯穿原则:** Controller 是唯一编排源——LLM 负责决策,代码负责机制;TUI 冻结在"基础对话"客户端,更丰富的交互一律落在 Web;一切建立在无头 server + RPC 地基(0.5)之上。

已交付:Controller ↔ Worker 对话与权限审批(v0.3)、跨 Task 持久化 Worker 与无会话长时运行(v0.4)、无头 server + RPC + e2e/CI(v0.5)。

## License

MIT
