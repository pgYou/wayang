<div align="center">

<img src="assets/wayang-logo.png" alt="Wayang" width="500">

### Welcome to play with Wayang

Orchestrate multiple AI agents with natural language — plan, dispatch, and coordinate in parallel.

[中文文档](docs/README.zh-CN.md)

</div>

---

## Why Wayang

Complex AI workflows need more than a single chat. Wayang acts as an intelligent **Controller** that understands your intent, decomposes tasks, dispatches them to parallel **Workers**, and synthesizes the results — all through natural conversation.

|                | Capability                                                  |
| -------------- | ----------------------------------------------------------- |
| **Plan**       | Decompose complex requests into parallelizable sub-tasks    |
| **Dispatch**   | Automatically assign Workers, control concurrency           |
| **Coordinate** | Aggregate results, maintain coherent context                |
| **Respond**    | Continue chatting with the Controller while Workers execute |

## Features

- **Intelligent Scheduling** — Controller uses LLM to decompose tasks and dispatch Workers in parallel
- **Non-blocking Interaction** — Keep talking to the Controller while tasks run; never wait idle
- **Task Lifecycle** — Full tracking: create → execute → progress → complete / fail
- **Multi-Worker Parallelism** — Multiple Workers run simultaneously with configurable concurrency limits
- **Rich TUI** — Ink-powered (React for CLI) interface with streaming output, slash commands, and keyboard shortcuts
- **Session Recovery** — `wayang --resume` restores interrupted sessions with automatic crash cleanup
- **Extensible Workers** — Built-in Puppet Worker and Claude Code Worker; plug in custom third-party Workers
- **Context Compression** — Automatic compact to prevent token overflow

## Architecture

```
┌────────────────────────────────────────────────────────┐
│                    CLI (Ink / React)                   │
├──────────────────────┬─────────────────────────────────┤
│     Controller       │           Worker Pool           │
│    (Orchestrator)    │      (Parallel Execution)       │
│  - Understand intent │  - bash / read / write          │
│  - Plan & decompose  │  - call_agent                   │
│  - Synthesize result │  - done / fail termination      │
├──────────────────────┴─────────────────────────────────┤
│           Supervisor (Orchestration + Lifecycle)       │
├────────────────────────────────────────────────────────┤
│  Signal Queue · Task Pool · Task Scheduler             │
│  Event Bus · State Persistence · Crash Recovery        │
└────────────────────────────────────────────────────────┘
```

**Core principle:** _LLM handles intelligence (understanding, judgment, response); code handles mechanics (scheduling, queuing, state management)._

## Quick Start

### Prerequisites

- Node.js >= 20

### Install

```bash
npm install -g wayang-ai
```

After installation, the global command `wayang` (alias `waya`) is available in your terminal:

```bash
wayang          # start a new session
waya            # shorthand alias
wayang --resume # resume last session
```

On first run, an interactive setup wizard will guide you through configuring your LLM provider.

### Configure

On first run, Wayang launches an interactive setup wizard. Just fill in your LLM provider details.

Or create `~/.wayang.config.json` manually:

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

API key can be set via config or the `WAYANG_LLM_API_KEY` environment variable.

### Run

```bash
wayang                # new session
waya                  # alias
wayang --resume       # resume last session
wayang --resume 20260403-143052   # resume specific session
wayang --resume --all             # list all sessions to pick
```

### CLI Options

| Flag                  | Description             | Default                 |
| --------------------- | ----------------------- | ----------------------- |
| `--home-dir`          | Data storage directory  | `~/.wayang`             |
| `-w, --workspace-dir` | Agent working directory | cwd                     |
| `-c, --config`        | Config file path        | `~/.wayang.config.json` |
| `--resume [id]`       | Resume a session        | —                       |
| `--verbose`           | Enable verbose logging  | —                       |

## Project Structure

```
src/
├── cli.ts               CLI entry point
├── bootstrap.ts          Startup orchestration
├── onboard.ts            First-run setup
├── session-select.ts     Session picker
├── ui/                   UI layer (Ink components + hooks + pages)
├── services/
│   ├── supervisor.ts     DI container + lifecycle
│   ├── controller-loop.ts Main control loop
│   ├── agents/           Agent layer (Controller + Worker + Prompts + State)
│   ├── task/             Task domain (pool + scheduler + state)
│   ├── signal/           Signal domain (queue + event sourcing state)
│   ├── session/          Session domain (manager + state)
│   └── tools/            Tool implementations (13 tools)
├── infra/                Infrastructure (event-bus, logger, state framework, persistence)
├── types/                Shared types
└── utils/                Utility functions
```

## Tech Stack

| Layer             | Choice              |
| ----------------- | ------------------- |
| Language          | TypeScript          |
| LLM SDK           | Vercel AI SDK       |
| CLI Framework     | Ink (React for CLI) |
| CLI Parser        | meow                |
| Pre-start Prompts | prompts             |
| Agent Invocation  | Claude Agent SDK    |
| Persistence       | JSONL + JSON files  |
| Logging           | pino                |
| Build             | tsup                |
| Testing           | vitest              |

## Testing

```bash
npm test           # 27 test files, 277 tests
npm run test:watch # watch mode
npm run lint       # type check + lint
```

## Roadmap

- [ ] **Controller ↔ Worker Chat** — Allow the controller to chat with a running worker and ask for human approval when needed
- [ ] **More Third-Party Worker Agents** — Expand integrations beyond Claude Code (e.g. Codex, Aider, Cursor agent)
- [ ] **TUI Improvements** — Better worker detail pages, richer status display, and overall UX polish
- [ ] **GUI** — Bring Wayang to a graphical interface beyond the terminal
- [ ] **Sessionless Long-Running Agent** — Rethink session design: always inherit context from the previous run + long-term memory, making Wayang a continuously running agent rather than a session-based tool
- [ ] **Pluggable Worker Ecosystem** — Standardize a Worker plugin protocol (capabilities, tools, resources), build a plugin registry, and provide scaffolding so the community can develop and share custom Workers

## License

MIT
