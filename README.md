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

## Skills

**Skills** are on-demand expertise packages (Anthropic-style `SKILL.md` + optional resource scripts) that any agent — Controller or Worker — can load at runtime via the `use_skill` tool. Skills are discovered once at startup and shared across all agents through the in-memory registry.

### Discovery

Wayang scans these directories (later ones override earlier ones on name conflict):

1. `~/.wayang/skills/` — global, cross-project skills
2. `<workspace>/.wayang/skills/` — project-level skills (commit these to share with your team)
3. Any extra dirs listed in `config.skillsDirs`

Each skill is a directory containing a `SKILL.md` with YAML frontmatter. Only `description` is required:

```
.wayang/skills/
└── my-skill/
    ├── SKILL.md          # required, with `description` frontmatter
    └── run.sh            # optional resource files (scripts, templates, ...)
```

```markdown
---
description: One-line summary the LLM sees in the skill catalog.
---

# my-skill

Detailed instructions the agent loads on demand via use_skill.
Resource scripts are invoked by the worker's own shell tool — Wayang never
executes them for you.
```

### How agents share skills

- **Controller** sees the skill catalog in its system prompt and can call `use_skill` to load domain knowledge before writing a task description.
- **Puppet Worker** sees the same catalog and has the `use_skill` tool, so it can load skill instructions while executing a task.
- **Claude Code Worker** has no Wayang tools, so its catalog lists each skill's directory — it reads `SKILL.md` with its own file tools.

Skills are read-only config: a worker that has already started won't pick up newly added skills until the next session (or the next worker spawn).

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
│   ├── skills/           Skill registry (discovery + lazy content loading)
│   ├── task/             Task domain (pool + scheduler + state)
│   ├── signal/           Signal domain (queue + event sourcing state)
│   ├── session/          Session domain (manager + state)
│   └── tools/            Tool implementations (incl. use_skill)
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

- [x] **Controller ↔ Worker Chat** — Allow the controller to chat with a running worker and ask for human approval when needed
- [ ] **Persistent Workers Across Tasks** — Allow workers to survive task completion and receive follow-up tasks, retaining conversation context for iterative refinement without starting from scratch
- [ ] **Sessionless Long-Running Agent** — Rethink session design: always inherit context from the previous run + long-term memory, making Wayang a continuously running agent rather than a session-based tool
- [ ] **More Third-Party Worker Agents** — Expand integrations beyond Claude Code (e.g. Codex, Aider, Cursor agent)
- [ ] **TUI Improvements** — Better worker detail pages, richer status display, and overall UX polish
- [ ] **GUI** — Bring Wayang to a graphical interface beyond the terminal
- [ ] **Pluggable Worker Ecosystem** — Standardize a Worker plugin protocol (capabilities, tools, resources), build a plugin registry, and provide scaffolding so the community can develop and share custom Workers

## License

MIT
