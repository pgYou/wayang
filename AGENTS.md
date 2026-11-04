# AGENTS.md

This file provides guidance to AI coding agents when working with code in this repository.

## Project Overview

Wayang is a multi-agent orchestration platform — a CLI tool that coordinates multiple AI workers (LLM agents) to execute tasks concurrently. A **Controller** agent (powered by Vercel AI SDK) interprets user intent, decomposes work into tasks, and dispatches them to **Worker** agents. Workers can be built-in "puppet" agents (LLM-driven with tools) or third-party agents like Claude Code (via `@anthropic-ai/claude-agent-sdk`).

## 版本迭代流程

本节描述人（维护者）参与的发版流程，分三步：版本准备、版本规划、需求开发与合流。

### 版本准备

进入一个新版本时，先做分支与元信息准备：

- 从 main 拉出 `release/x.y.z` 分支并推送远端，例如 `git branch release/0.8.1 main && git push -u origin release/0.8.1`。
- 修改 `package.json` 的 `version` 为新版本号。
- 在 `CHANGELOG.md` 顶部新增该版本的段落，写清版本号与日期。

### 版本规划

- 版本规划先以 draft 形式写进 `CHANGELOG.md` 的新版本段落：包含本次要做的 issue、预期范围与里程碑，作为实施前的记录。
- 实施完成后按真实落地情况校准该段落：补齐条目、移除未做的项、修正描述。`CHANGELOG.md` 最终以实际交付为准，不保留与实施不符的规划文字。

### 需求开发与合流

- 并行需求或改动较大的需求，基于 `release/x.y.z` 拉 `feat/xxx` 分支开发；需要同时推进多个需求时用独立 worktree 隔离工作区（见「工作区布局」）。
- 需求开发完成、跑完门槛后，直接在本地把 feat 分支合入 `release/x.y.z` 并推送，例如 `git checkout release/x.y.z && git merge --no-ff feat/xxx && git push`。
- 合入 release 分支不需要开 PR；PR 只用于需要评审、或 release 最终合回 main 的场景。
- 开发前先确定验收标准；实现后跑完门槛（`npm run lint`、`npx vitest run`、`npm run build`）再合入 release。
- 发布收口：版本号与 `CHANGELOG.md` 校准完成、跑通全量测试后打 tag，并将 release 分支合并回 main。
- 小改动（文档、文案、单文件修补）可直接在 release 分支上提交，不必单开 feat 分支。

### 工作区布局

- 主仓常驻 `release/x.y.z` 分支，不用于直接开发需求；它承担合流与发布的角色。
- 需求一律在独立 worktree 的功能分支上开发，worktree 从 release 分支拉出，例如 `git worktree add -b feat/xxx ../wayang-xxx release/x.y.z`；并行需求各占一个 worktree。
- 同一个分支只能被一个工作区检出：`release/x.y.z` 由主仓检出，worktree 只挂 `feat/xxx` 或 `docs/xxx`。
- 需求完成后回到主仓合流：`git merge --no-ff feat/xxx && git push`，不需要 PR。
- 合流后清理：`git worktree remove ../wayang-xxx` 并删除已合入的功能分支，保持 `git worktree list` 只有主仓与在进行中的需求。

### 问题跟踪与 PR 关联

- 开发过程中发现的问题（bug、体验缺陷、设计疑问、待验证的假设）先提交 issue 记录，写清现象、影响、期望行为与验收标准；不要用对话记录或 TODO 注释代替 issue。
- 修复或实现时，PR 正文必须引用对应 issue：修复类用 `Fixes #N`（合并后自动关闭），关联类用 `Refs #N`；并在 PR 描述里说明改动范围与验收结果。
- 一个 PR 可以关联多个 issue，但主 issue 只写一个（放在开头的 Fixes/Refs）。
- 问题解决后回填 issue：结论、关联 PR 链接；确认无需再跟进时再关闭。
- 需求范围与版本的关系：issue 纳入某个版本时，同步写进该版本 CHANGELOG 段落的规划里（见「版本规划」）。
- 直接合入 release 分支时（不走 PR），相应的合入 commit 信息必须引用 issue（`Fixes #N` 或 `Refs #N`），并在合入说明里写清改动范围与验收结果。

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
                                                          ├── ControllerLoop (signal-driven event loop)
                                                          ├── TaskExecuteEngine (task + worker lifecycle)
                                                          └── renderInkUI (React/Ink TUI)
```

### Core Components (`src/services/`)

- **Supervisor** — assembles all services and manages top-level lifecycle (restore, start, shutdown). No business logic — delegates to engine and controller agent.
- **TaskExecuteEngine** — unified task + worker lifecycle manager. Handles: task state machine (pending → running → completed/failed), scheduling (direct calls, not hooks), worker creation/tracking/abort, and active worker state for TUI. Depends on SignalQueue (one-way: emits signals).
- **ControllerAgent** — LLM agent that processes signals (user input, worker completions/failures/progress), decides actions via tools (add_task, cancel_task, etc.), and streams responses. Creates its own ControllerAgentState internally. Uses Vercel AI SDK `streamText`.
- **WorkerAgent** ("puppet") — built-in LLM worker that executes a single task with tools (bash, read_file, write_file, done, fail). Uses `collectLoop` (non-streaming).
- **ClaudeCodeWorker** — third-party worker delegating to Claude Code via `@anthropic-ai/claude-agent-sdk`. Independent implementation (not extending BaseAgent).
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
- **Controller tools**: add_task, list_tasks, cancel_task, get_task_detail, read_worker_conversation, get_worker_status, update_task, query_signals, skip_reply, chat_worker, respond_permission, respond_inquiry, dispose_worker, read_notebook, update_notebook, search_files, inquire, use_skill
- **Worker tools**: bash, read_file, write_file, edit_file, search_files, search_content, web_search, list_tasks, update_progress, done, fail, use_skill

The controller reads worker transcripts through `<sessionDir>/workers/<workerId>/conversation.jsonl`
(`src/services/worker-transcript.ts`), so a worker stays inspectable after it finished or was cancelled.
Conversation output is always paginated with explicit truncation markers (limit / offset / maxChars / full).

### Path Alias

`@/` maps to `src/` (configured in tsconfig.json paths and vitest alias). Use `@/` imports throughout source code.

## Configuration

Environment variables: `WAYANG_LLM_API_KEY`, `WAYANG_ENDPOINT`, `WAYANG_MODEL` (see `.env.example`).

Config file (`~/.wayang.config.json` or `--config`): defines providers, controller/worker provider bindings, maxConcurrency, and third-party worker definitions (e.g. claude-code with capabilities, emoji, maxTurns).

## Key Patterns

- **Dependency injection over imports**: tools, spawn functions, and service dependencies are injected via constructor params or setter methods.
- **SystemContext as shared infrastructure**: `SystemContext` carries logger, config, hooks, sessionDir, etc. All domain objects receive `ctx` in their constructor — never pass individual properties like `ctx.logger` or `ctx.sessionDir` separately.
- **State subscriptions for UI reactivity**: TUI components subscribe to specific state paths; state changes trigger React re-renders through the `use-wayang-state` hook.
- **Hooks are for non-core side effects only**: `LifecycleHooks` is for optional, peripheral concerns (e.g. metrics, debugging, UI notifications) — things you could remove without breaking the main flow. **Core logic flow (task scheduling, worker lifecycle, signal processing) must use direct method calls, not hooks.** If removing a hook listener would break the system, that logic does not belong in hooks.
- **Session persistence**: sessions are stored under `~/.wayang/` with JSONL conversation logs for crash recovery and resume (`--resume`).
- **Context compaction**: ControllerAgent uses LLM-based summarization when context window fills up, with fallback to half-truncation.

## Before Implementing, Confirm the Approach

- **Stop and describe your planned approach in 2-3 sentences before making significant changes**, especially to core architecture, state management, or agent patterns.
- If the user has already explained the architecture, **restate your understanding** before coding to confirm alignment.
- **Do not assume fixed phase counts or agent-specific patterns** unless the user explicitly states them. Ask first.
- If the user interrupts or rejects your approach, **stop immediately, ask for clarification, and restart** — do not iterate on the same wrong direction.
- **Before designing custom machinery around a library, survey its existing capability surface.** Read the installed package's `.d.ts` and, when semantics matter, the bundled implementation under `node_modules/<pkg>/dist` — they are the source of truth, not memory. A restructure or hand-rolled loop is only justified after confirming no built-in hook or option covers the need (e.g. AI SDK `prepareStep` for per-step message injection replaces a custom step loop; claude-agent-sdk's `createSdkMcpServer` for custom worker tools replaces `canUseTool` interception of virtual tool names).

## Testing Conventions

- **Run the full test suite after modifying core modules** (state management, controllers, workers, agent loop).
- **Mock state should be self-contained** — do not rely on shared mutable mock state between tests.
- **Avoid same-second assumptions** in test IDs or timestamps — use unique prefixes or UUIDs.
- **When writing tests for async/streaming behavior**, account for timing variability and signal type correctness.
- **After fixing bugs discovered during testing, re-run the suite** to confirm no regressions.