/**
 * Worker run wall-time limit (#76) — pure resolution, watchdog and the
 * structured timeout report. Kept out of acp-worker-run.ts so the run spine
 * stays lean: the run layer only arms/clears the watchdog and swaps the bare
 * 'run wall time exceeded' wording for the report built here.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { TaskDetail } from '@/types/task';
import type { WayangConfig } from '@/types/config';
import { TURN_LIMITS } from './turn-attribution';

const execFileAsync = promisify(execFile);

/**
 * Effective wall-time limit (ms) of one worker run (#76).
 * Priority: task `runTimeoutMs` > config `workerRunTimeoutMs` >
 * `TURN_LIMITS.MAX_RUN_WALL_MS` (default 60 min). Both override sources are
 * validated upstream (add_task / validateConfig); this resolver only picks.
 */
export function resolveRunWallLimitMs(task: TaskDetail, config: WayangConfig): number {
  return task.runTimeoutMs ?? config.workerRunTimeoutMs ?? TURN_LIMITS.MAX_RUN_WALL_MS;
}

/** How long before expiry the one-shot warning progress fires (#76 req 3). */
export const WALL_WARN_REMAINING_MS = 5 * 60 * 1000;

/** Compact duration for reports and warnings: 1h 30m / 45m 0s / 12s. */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export interface RunWallWatchdogDeps {
  /** Wall-time budget of this run (ms), already resolved. */
  limitMs: number;
  /** Wall-clock start of the run (Date.now() at run()). */
  startedAt: number;
  /** One-shot warning (5 min before expiry): elapsed + remaining in the text. */
  onWarn: (message: string) => void;
  /** Hard expiry: the run layer cancels the session and reports. */
  onExpiry: () => void;
}

/**
 * Two-threshold watchdog for ONE run (#76): a single warning progress when
 * the remaining budget drops to `WALL_WARN_REMAINING_MS`, and a hard expiry
 * at the limit. The warning is armed only when the limit leaves room for it
 * (a limit of 5 minutes or less never crosses the 5-minutes-remaining line).
 */
export class RunWallWatchdog {
  private readonly deps: RunWallWatchdogDeps;
  private warnTimer: ReturnType<typeof setTimeout> | null = null;
  private stopTimer: ReturnType<typeof setTimeout> | null = null;
  private warnedOnce = false;
  private expiredFlag = false;

  constructor(deps: RunWallWatchdogDeps) { this.deps = deps; }

  get limitMs(): number { return this.deps.limitMs; }
  get startedAt(): number { return this.deps.startedAt; }
  /** Whether the one-shot warning already fired. */
  get didWarn(): boolean { return this.warnedOnce; }

  /** Arm both thresholds; idempotent per run instance. */
  arm(): void {
    if (this.warnTimer !== null || this.stopTimer !== null) return;
    const { limitMs, startedAt } = this.deps;
    const warnDelay = limitMs - WALL_WARN_REMAINING_MS;
    if (warnDelay > 0) {
      this.warnTimer = setTimeout(() => {
        this.warnTimer = null;
        this.warnedOnce = true;
        const elapsed = Date.now() - startedAt;
        const remaining = Math.max(0, startedAt + limitMs - Date.now());
        this.deps.onWarn(
          `[wall-time warning] worker run has been running ${formatDuration(elapsed)} — `
          + `${formatDuration(remaining)} remains of its ${formatDuration(limitMs)} wall-time limit. `
          + 'At expiry the run is terminated and a structured report is issued; committed and pushed work is preserved.',
        );
      }, warnDelay);
    }
    this.stopTimer = setTimeout(() => {
      this.stopTimer = null;
      this.expiredFlag = true;
      this.deps.onExpiry();
    }, limitMs);
  }

  /**
   * Whether the limit has been reached — the timer firing, or a direct
   * wall-clock check (the turn loop's belt-and-braces path; timer callbacks
   * can lag behind the clock).
   */
  isExpired(now: number = Date.now()): boolean {
    return this.expiredFlag || now - this.deps.startedAt > this.deps.limitMs;
  }

  /** Run teardown: drop both timers. Safe to call more than once. */
  clear(): void {
    if (this.warnTimer !== null) { clearTimeout(this.warnTimer); this.warnTimer = null; }
    if (this.stopTimer !== null) { clearTimeout(this.stopTimer); this.stopTimer = null; }
  }
}

// --- Structured timeout report (#76 req 4) ---

/** VCS facts of the workspace at timeout, for the structured report. */
export interface VcsSnapshot {
  /** False when the workspace is not a git repository (or git is unavailable). */
  isRepo: boolean;
  branch?: string;
  head?: string;
  /** Uncommitted entries (`git status --porcelain` line count); undefined when unknown. */
  uncommittedCount?: number;
  /** Commits ahead of upstream; 'no-upstream' when none is configured. */
  unpushedCount?: number | 'no-upstream';
}

/** Runs one git command in `cwd`; rejects on non-zero exit (injectable for tests). */
export type GitRunner = (args: string[], cwd: string) => Promise<string>;

async function defaultRunGit(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8' });
  return stdout;
}

/**
 * Collect the report's git facts. Every field degrades independently — a
 * missing value must never fail the timeout report itself.
 */
export async function collectVcsSnapshot(workspaceDir: string, runGit: GitRunner = defaultRunGit): Promise<VcsSnapshot> {
  try {
    if ((await runGit(['rev-parse', '--is-inside-work-tree'], workspaceDir)).trim() !== 'true') {
      return { isRepo: false };
    }
  } catch {
    return { isRepo: false };
  }
  const snapshot: VcsSnapshot = { isRepo: true };
  try { snapshot.branch = (await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], workspaceDir)).trim() || 'unknown'; } catch { /* leave unset */ }
  try { snapshot.head = (await runGit(['rev-parse', '--short', 'HEAD'], workspaceDir)).trim(); } catch { /* leave unset */ }
  try {
    const status = await runGit(['status', '--porcelain'], workspaceDir);
    snapshot.uncommittedCount = status.split('\n').filter((line) => line.trim() !== '').length;
  } catch { /* leave unset */ }
  try {
    const count = await runGit(['rev-list', '--count', '@{upstream}..HEAD'], workspaceDir);
    snapshot.unpushedCount = Number.parseInt(count.trim(), 10);
  } catch {
    snapshot.unpushedCount = 'no-upstream';
  }
  return snapshot;
}

export interface WallTimeoutReportInput {
  startedAt: number;
  reportedAt: number;
  limitMs: number;
  workspaceDir: string;
  snapshot: VcsSnapshot | null;
  /** Last progress text the worker produced, when one is available. */
  lastProgress: string | null;
}

function describeCount(count: number | undefined): string {
  if (count === undefined) return 'unknown';
  return count === 0 ? 'no' : `yes (${count})`;
}

/**
 * The structured timeout report (#76 req 4): run duration, branch/HEAD,
 * uncommitted/unpushed state and the last worker progress — never just the
 * bare 'run wall time exceeded' wording.
 */
export function buildWallTimeoutReport(input: WallTimeoutReportInput): string {
  const { startedAt, reportedAt, limitMs, workspaceDir, snapshot, lastProgress } = input;
  const lines = [
    'Worker run terminated: wall-time limit exceeded.',
    `- Run duration: ${formatDuration(reportedAt - startedAt)} (limit ${formatDuration(limitMs)})`,
    `- Workspace: ${workspaceDir}`,
  ];
  if (snapshot === null || !snapshot.isRepo) {
    lines.push('- Branch/HEAD: not a git repository (uncommitted/unpushed state unknown)');
  } else {
    lines.push(`- Branch: ${snapshot.branch ?? 'unknown'} | HEAD: ${snapshot.head ?? 'unknown'}`);
    lines.push(`- Uncommitted changes: ${describeCount(snapshot.uncommittedCount)}`);
    lines.push(
      `- Unpushed commits: ${snapshot.unpushedCount === 'no-upstream' ? 'unknown (no upstream branch configured)' : describeCount(snapshot.unpushedCount)}`,
    );
  }
  lines.push(`- Unfinished work (last worker progress): ${lastProgress ?? '(no progress recorded)'}`);
  lines.push('- Note: committed and pushed work is preserved; only the in-flight run was stopped.');
  return lines.join('\n');
}
