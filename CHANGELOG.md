# Changelog

## v0.5.0 (2026-10-28)

### Architecture

**Headless logic process (`wayang server`)** — The orchestration core (Supervisor, ControllerAgent, TaskExecuteEngine, SignalQueue, SkillRegistry) now runs in a separate process with zero ink/react dependencies. `wayang` spawns the server as a child and connects over stdio; interactive UX (onboard, session select) stays in the client process. E2E tests drive the exact binary + protocol the TUI uses

**RPC v1 (`src/rpc/`)** — Transport-agnostic protocol over newline-delimited JSON on stdio. Command surface: `submit_input`, `resolve_inquiry`, `list_tasks`, `cancel_task`, `update_task`, `respond_permission`, `chat_worker`, `dispose_worker`, `perform_compaction`, `abort_controller`, `get_status`, `get_snapshot`, `subscribe`, `unsubscribe`, `shutdown`. State surface: per-path subscriptions where every event carries the full value at the subscribed path (idempotent client-side cache, snapshot returned on subscribe). WebSocket transport reserved for the 0.6 WebUI

**TUI slimmed to a thin client** — New `RemoteSupervisor` (`src/client/`) presents the same consumption surface over RPC. Removed worker-list overlay, worker-detail page and routing; `/workers` is now a text listing; slash commands became async. The TUI keeps basic conversation, `/tasks`, approval/inquiry prompts

### Testing

**E2E framework** — Fake OpenAI-compatible provider (`src/__tests__/fake-openai-provider.ts`) replaying scripted SSE with content-based matching (immune to controller/worker request races); harness spawning `dist/cli.js server` and driving it over RPC; three scenarios: single-task full chain, permission approval (chmod intercepted → approved via RPC → really executed), multi-stage worker reuse (same workerId across stages)

**Unit/integration** — New suites for rpc transport/server/client (in-memory stream pairs) and WayangServer-over-RPC (in-process, fake provider). Totals: 332 unit tests + 3 e2e scenarios

**CI (GitHub Actions)** — lint + unit + build + e2e on every push and pull request

### Fixes

**Assigned-task invisibility** — Tasks dispatched straight to an idle multi-stage worker were never recorded in `running`/`history` (`moveToRunning` no-ops on the pending-list miss), so they executed and signalled but stayed invisible to `list_tasks` and every view. `assignToExistingWorker` now appends to `running` directly; regression-covered by unit + e2e tests

**bash tool error detail** — Non-zero exits with empty stderr (spawn failures, timeout kills) now include the thrown message instead of a bare `Exit code 1`

**Pre-existing lint errors** — `no-useless-escape`, `no-empty`, `prefer-const` fixed so the new CI lint gate can land

### Documentation

Added v0.5 design doc (`docs/v0.5-server-rpc-design.md`) and the 0.5→1.0 roadmap (`docs/roadmap-0.5-1.0.md`)

## v0.4.1 (2026-07-02)

### Fixes & Improvements

**AI SDK system-in-messages warning** — `streamText` now passes `allowSystemInMessages: true`. Worker signals are emitted as `system`-role messages inside `messages` (in-band, order-sensitive notifications from the orchestration system), but AI SDK ≥6.0.x warns that any system message in `messages` may be a prompt-injection risk unless explicitly opted in. Our signals are trusted system-generated content, so opting in is the correct and intended usage — preserving the `system` semantics and conversation ordering without rewriting the converter

### Dependencies

Pinned `ai` to `^6.0.218` (dev environment previously resolved 6.0.149, which predates the system-message guard; aligning dev with the released version that surfaces the warning)

## v0.4.0 (2026-07-01)

### Features

**Skill support** — New `SkillRegistry` (services/skills/) discovers Anthropic-style `SKILL.md` packages (frontmatter + optional resources) from global, project, and config dirs at startup, with lazy content loading and in-memory cache. Adds `use_skill` tool shared across Controller and Puppet Worker; Claude Code Worker reaches skills via the prompt catalog (it has no Wayang tools). `SkillRegistry` is owned by Supervisor and injected into agents/engine to keep `SystemContext` stateless. New optional `skillsDirs` field on `WayangConfig`

**Multi-stage worker persistence** — `TaskExecuteEngine` gains idle worker state with `assignToExistingWorker` dispatch path that reuses the worker instance and context across stages. Idle workers are reaped after a TTL (default 30min, configurable via `idleTimeoutMs`), count against `maxConcurrency`, and are disposed on shutdown. `add_task` now accepts `multiStage` + `assignToWorker` fields; new `dispose_worker` tool for explicit teardown. Controller prompt updated with multi-stage/assign/dispose guidance

**Per-workspace sessionless controller** — Default CLI behavior now inherits the latest session for the current workspace (per-workspace isolation, not a global stream); new `--fresh` flag starts a clean session. Cold-start compaction runs before the loop on resume, and a `previous_session_tasks` signal surfaces unfinished work so the controller decides whether to re-dispatch (workers are NOT auto-resumed). Explicit `--resume` continues the exact session without re-surfacing stale tasks

**TUI idle-state awareness** — Worker list/detail now distinguish running vs idle and display the last stage

### Fixes & Improvements

**Idle-worker dispose signal semantics** — Dedicated `cancelled` converter renders idle-worker disposal as `WorkerDisposed` instead of `WorkerFailed` + raw JSON, since its taskId points at an already-completed stage

**Multi-stage reentry fix** — `ClaudeCodeWorker` resets `_terminalResult` on `run()`, fixing the multi-stage reentry bug (SDK single-session limitation documented)

**`readSessionUnfinishedTasks` hardening** — Task status now tagged by bucket (not raw field) with malformed entries filtered out

### Documentation

Added long-running Worker & Sessionless Controller design doc, aligned with the implemented per-workspace + multi-stage plan (resolved decisions table, implemented tool choices)

Added research document on Multica's Workspace-Project-Issue model for future reference

### Dependencies

Added `yaml` for SKILL.md frontmatter parsing

### Tests

+15 for engine lifecycle and session resolution; SkillRegistry discovery/override/cache and `use_skill` tool coverage

## v0.3.0 (2026-04-19)

### Features

**Controller ↔ Worker communication** — Added `chat_worker` tool for controller to send messages to running workers; `check_controller_messages` tool for workers to receive controller guidance during execution

**Permission system** — New middleware layer intercepting worker operations that require controller approval before execution. Supports bash commands, file access outside workspace, and Claude Code Worker permissions via `respond_permission` tool

**Bash permission check (upgraded)** — Two-tier detection: dangerous commands (rm, sudo, chmod, etc.) always require permission; commands referencing absolute paths outside workspace also trigger permission requests

**File tool permission check** — File tools (read_file, write_file, edit_file, search_files, search_content) trigger permission request for workspace-external paths instead of hard-rejecting. Workspace-internal access passes through directly

**Tool selection priority** — Worker prompt now explicitly instructs preferring dedicated file tools over bash equivalents (read_file > cat, write_file > cp/tee, search_files > find, search_content > grep)

### Refactoring

**Path access control centralization** — Moved path validation from individual tool implementations to the permission middleware layer; removed `validatePath` in favor of `isInsideWorkspace` boolean helper

**Permission strategy extraction** — Extracted `needsBashPermission` and `needsFilePermission` as module-level strategy functions with `FILE_TOOL_NAMES` constant for maintainability

**ClaudeCodeWorker permissions** — Integrated with permission middleware via `@anthropic-ai/claude-agent-sdk`'s `PermissionResult` handling

### Fixes & Improvements

Worker prompt updated to discourage bash for file operations when dedicated tools are available

Added workspace-external path detection for bash commands to prevent `cp`/`mv` bypass of file tool permission checks

Removed dead `validatePath` code after migration to middleware layer

## v0.2.0 (2026-04-16)

### Features

**Inquiry system** — Added notebook and user interaction tools for agent-to-user communication

**Puppet worker tools** — New edit_file, search_files (glob), search_content (text search), and web_search (Tavily API) tools

**LifecycleHooks** — Replaced EventBus with type-safe system-level lifecycle event management

**WorkerAgent finish tracking** — Added finish reason and step count to StreamLoopResult; TUI worker detail page now shows task completion status

**HeartbeatProvider** — Refactored ControllerLoop to use heartbeat-driven signal processing

### Refactoring

**SystemContext integration** — Encapsulated provider configs and concurrency settings; simplified ControllerAgent/WorkerAgent access to logger and config

**TaskPool cleanup** — Removed obsolete task pool and scheduler tests; streamlined scheduling implementation

**TUI adaptation** — Updated components to use the new Supervisor structure

### Fixes & Improvements

read_file tool now supports line numbers and truncation

Improved skip_reply tool description clarity

Adjusted TUI animation timing

Enhanced WorkerAgent logging for step completion and max steps reached scenarios

### Dependencies

Added fast-glob for file search

Integrated Tavily API key into config (optional)

### Features

**Controller ↔ Worker communication** — Added `chat_worker` tool for controller to send messages to running workers; `check_controller_messages` tool for workers to receive controller guidance during execution

**Permission system** — New middleware layer intercepting worker operations that require controller approval before execution. Supports bash commands, file access outside workspace, and Claude Code Worker permissions via `respond_permission` tool

**Bash permission check (upgraded)** — Two-tier detection: dangerous commands (rm, sudo, chmod, etc.) always require permission; commands referencing absolute paths outside workspace also trigger permission requests

**File tool permission check** — File tools (read_file, write_file, edit_file, search_files, search_content) trigger permission request for workspace-external paths instead of hard-rejecting. Workspace-internal access passes through directly

**Tool selection priority** — Worker prompt now explicitly instructs preferring dedicated file tools over bash equivalents (read_file > cat, write_file > cp/tee, search_files > find, search_content > grep)

### Refactoring

**Path access control centralization** — Moved path validation from individual tool implementations to the permission middleware layer; removed `validatePath` in favor of `isInsideWorkspace` boolean helper

**Permission strategy extraction** — Extracted `needsBashPermission` and `needsFilePermission` as module-level strategy functions with `FILE_TOOL_NAMES` constant for maintainability

**ClaudeCodeWorker permissions** — Integrated with permission middleware via `@anthropic-ai/claude-agent-sdk`'s `PermissionResult` handling

### Fixes & Improvements

Worker prompt updated to discourage bash for file operations when dedicated tools are available

Added workspace-external path detection for bash commands to prevent `cp`/`mv` bypass of file tool permission checks

Removed dead `validatePath` code after migration to middleware layer
