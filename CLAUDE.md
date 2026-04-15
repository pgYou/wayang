# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Wayang is a multi-agent orchestration platform — a CLI tool that coordinates multiple AI workers (LLM agents) to execute tasks concurrently. A **Controller** agent (powered by Vercel AI SDK) interprets user intent, decomposes work into tasks, and dispatches them to **Worker** agents. Workers can be built-in "puppet" agents (LLM-driven with tools) or third-party agents like Claude Code (via `@anthropic-ai/claude-agent-sdk`).

## Commands

```bash
npm run build          # tsup → dist/cli.js (ESM, node20, single entry)
npm run dev            # Type-check + build + run with local env/config
npm run dev:watch      # tsup --watch (no run)
npm test               # vitest run
npm run test:watch     # vitest (watch mode)
npm run lint           # tsc --noEmit && eslint src/
```

Run a single test file: `npx vitest run src/path/to/file.test.ts`

## Architecture

### Runtime Flow

```
CLI (meow) → bootstrap → loadConfig → SessionManager → Supervisor → start
                                                          ├── mainControllerLoop (signal-driven event loop)
                                                          ├── TaskScheduler (reacts to task:added events)
                                                          └── renderInkUI (React/Ink TUI)
```

### Core Components (`src/services/`)

- **Supervisor** — central orchestrator; owns all services, wires dependencies, manages worker lifecycle. Implements `SchedulerContext` interface.
- **ControllerAgent** — LLM agent that processes signals (user input, worker completions/failures/progress), decides actions via tools (add_task, cancel_task, etc.), and streams responses. Uses Vercel AI SDK `streamText`.
- **WorkerAgent** ("puppet") — built-in LLM worker that executes a single task with tools (bash, read_file, write_file, done, fail). Uses `collectLoop` (non-streaming).
- **ClaudeCodeWorker** — third-party worker delegating to Claude Code via `@anthropic-ai/claude-agent-sdk`. Independent implementation (not extending BaseAgent).
- **WorkerFactory** — creates worker instances by type ("puppet" → WorkerAgent, "claude-code" → ClaudeCodeWorker).
- **TaskScheduler** — listens for `task:added` events, dequeues pending tasks up to `maxConcurrency`, spawns workers via fire-and-forget pattern.
- **TaskPool** — task state machine (pending → running → completed/failed/cancelled).
- **SignalQueue** — message bus between workers and controller. Controller loop blocks on `waitForSignal()`, processes batch of unread signals each iteration.

### Signal-Driven Controller Loop

The controller does NOT poll. `mainControllerLoop` calls `signalQueue.waitForSignal()` which resolves when new signals arrive (user input, worker events). Signals are dequeued in batch and fed to `ControllerAgent.run()`.

### State System (`src/infra/state/`)

- **BaseWayangState** — observable state tree using lodash `get/set` with path-based subscriptions. Changes auto-persist and notify subscribers.
- Persistence helpers: `JsonFilePersistence` (full overwrite) and `JsonlFilePersistence` (append-only, used for conversation logs).
- **ControllerAgentState** / **WorkerState** — concrete state classes with conversation, runtimeState, and dynamicState sections.

### TUI (`src/tui/`)

Built with React + Ink (terminal UI). Key structure:
- `App` → `SupervisorProvider` → `RouteProvider` → pages (controller-page, worker-detail-page)
- State bridge: `use-wayang-state` hook subscribes to `BaseWayangState` paths and triggers React re-renders.

### Tools (`src/services/tools/`)

Two tool sets created via dependency injection:
- **Controller tools**: add_task, list_tasks, cancel_task, get_task_detail, update_task, query_signals, skip_reply
- **Worker tools**: bash, read_file, write_file, list_tasks, update_progress, done, fail

### Path Alias

`@/` maps to `src/` (configured in tsconfig.json paths and vitest alias). Use `@/` imports throughout source code.

## Configuration

Environment variables: `WAYANG_LLM_API_KEY`, `WAYANG_ENDPOINT`, `WAYANG_MODEL` (see `.env.example`).

Config file (`~/.wayang.config.json` or `--config`): defines providers, controller/worker provider bindings, maxConcurrency, and third-party worker definitions (e.g. claude-code with capabilities, emoji, maxTurns).

## Key Patterns

- **Dependency injection over imports**: tools, spawn functions, and service dependencies are injected via constructor params or setter methods (e.g. `scheduler.setSpawnFn()` to break circular deps).
- **State subscriptions for UI reactivity**: TUI components subscribe to specific state paths; state changes trigger React re-renders through the `use-wayang-state` hook.
- **Session persistence**: sessions are stored under `~/.wayang/` with JSONL conversation logs for crash recovery and resume (`--resume`).
- **Context compaction**: ControllerAgent uses LLM-based summarization when context window fills up, with fallback to half-truncation.

## Before Implementing, Confirm the Approach

- **Stop and describe your planned approach in 2-3 sentences before making significant changes**, especially to core architecture, state management, or agent patterns.
- If the user has already explained the architecture, **restate your understanding** before coding to confirm alignment.
- **Do not assume fixed phase counts or agent-specific patterns** unless the user explicitly states them. Ask first.
- If the user interrupts or rejects your approach, **stop immediately, ask for clarification, and restart** — do not iterate on the same wrong direction.

## Testing Conventions

- **Run the full test suite after modifying core modules** (state management, controllers, workers, agent loop).
- **Mock state should be self-contained** — do not rely on shared mutable mock state between tests.
- **Avoid same-second assumptions** in test IDs or timestamps — use unique prefixes or UUIDs.
- **When writing tests for async/streaming behavior**, account for timing variability and signal type correctness.
- **After fixing bugs discovered during testing, re-run the suite** to confirm no regressions.