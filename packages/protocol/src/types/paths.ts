/**
 * Deployment storage & workspace contracts (monorepo-design 4.2 改造二).
 *
 * These two types replace the single ambiguous `dataDir` + `workspaceDir`
 * pair core used to receive. They are DEPLOYMENT FACTS, not user
 * configuration: they never enter the `WayangConfig` schema and never take
 * part in config hot-updates. The host layer (cli bootstrap / server entry /
 * desktop main) constructs the values and injects them through
 * `SupervisorOptions` / `ServerMainOptions` into core; core only reads them.
 *
 * Default values (CLI, 0.9.9-compatible item by item):
 * - `dataDir` is derived from the existing `--wayang-root` flag semantics
 *   (`<wayangRoot>/.wayang`); sessions live under `<dataDir>/sessions`.
 * - `logDir` / `cacheDir` default to the session directory — a subdirectory
 *   of `dataDir` — so the physical layout is byte-for-byte the 0.9.9 one:
 *   the session log at `<dataDir>/sessions/<id>/wayang.log`, MCP bridge
 *   sockets at `<sessionDir>/.mcp/`. The host cannot know a NEW session's
 *   directory before the server creates it, so the session-scoped default
 *   resolves at the Supervisor assembly point (a plain assignment of the
 *   already-resolved session dir — never a reverse derivation from it); a
 *   host that wants different locations injects them explicitly.
 * - `controllerWorkspace` / `defaultWorkerWorkspace` both default to
 *   `<dataDir>/workspace`. The CLI host overrides `controllerWorkspace`
 *   with the directory the user launched in (or the resumed session's
 *   startup workspace), which is what keeps CLI behavior identical to
 *   0.9.9; a host with no launch-workspace notion keeps the default.
 */

/**
 * Where Wayang keeps its data. Pure deployment facts — one value set per
 * host, injected once at boot.
 */
export interface StoragePaths {
  /**
   * Wayang data dir (the `~/.wayang` equivalent). Sessions live under
   * `<dataDir>/sessions`; the workspace registry and skill dirs key on it.
   */
  dataDir: string;
  /**
   * Directory this session's log file is written into — the sink writes
   * `<logDir>/wayang.log`. CLI default: the session directory.
   */
  logDir: string;
  /**
   * Base directory for this session's runtime caches — the MCP bridge
   * sockets live under `<cacheDir>/.mcp/`. CLI default: the session
   * directory.
   */
  cacheDir: string;
}

/**
 * Where work runs. Both anchors are workspace directories the host picked;
 * core never derives them from the session layout or the process state.
 */
export interface WorkspacePolicy {
  /**
   * The controller's workspace — ONE anchor with two roles (design 4.2):
   * the baseline for task dispatch (the default workspace `add_task` stamps
   * when a call declares none, and the base relative workspace declarations
   * resolve against) and the starting point (cwd semantics) of the
   * controller's own tools.
   */
  controllerWorkspace: string;
  /**
   * The default workspace for tasks that belong to no codebase of their own
   * (research, collecting material, drafting) — the "general workspace".
   * CLI default: `<dataDir>/workspace`.
   */
  defaultWorkerWorkspace: string;
}
