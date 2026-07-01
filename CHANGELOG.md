# Changelog

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
