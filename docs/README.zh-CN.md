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

## License

MIT
