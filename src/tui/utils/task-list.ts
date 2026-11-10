/**
 * Row formatting for the `/tasks` list.
 *
 * A task's description is the full instruction handed to a worker — routinely
 * thousands of characters, often with embedded newlines. Rendering it verbatim
 * made Ink re-layout tens of thousands of characters per `/tasks` call and hang
 * the TUI. The list therefore shows a one-line digest of each task, and caps
 * the number of rows — keeping pending/running tasks ahead of older history.
 *
 * The primary label is the task's LLM-generated title (≤50 chars by contract);
 * tasks without one fall back to a one-line digest of the description. Rows
 * address tasks by their short handle (`#<id tail>`), so a 20-char generated id
 * cannot eat the row budget; colliding handles escalate to the full id (see
 * `formatTaskList`).
 *
 * `task.result` / `task.error` are the other free-form fields on a row: they
 * get the same one-line digest treatment, and a failed task's error outranks
 * the label when a narrow row forces a choice — the whole point of the panel
 * is telling failed work apart at a glance.
 *
 * With `rowMaxWidth` (the overlay panel's inner width) the label and the
 * digest share that column budget, so every row is exactly one physical line
 * at any terminal width — no wrapping, no reflow jitter. Without it the
 * historical independent caps apply (wide-output behavior).
 *
 * Pure formatting only — no RPC shape changes, no task data mutation.
 */

import type { TaskDetail } from '@/types/index';
import { getWorkerMeta } from '@/services/agents/worker-defaults';
import { formatDuration } from '@/services/worker-transcript';
import { collapseWhitespace, shortId, stringWidth, truncateToWidth } from '@/tui/utils/text-width';
import { formatTaskWorkspaceMark } from '@/tui/utils/workspace-display';

/** Max display columns for one description digest in the list (CJK/emoji count double). */
export const TASK_LIST_DESCRIPTION_MAX_WIDTH = 80;

/**
 * Max display columns for one result digest in the list (CJK/emoji count
 * double). Smaller than the description budget: the result is a trailing
 * "what came out of it" summary, not the instruction the user needs to verify.
 */
export const TASK_LIST_RESULT_MAX_WIDTH = 60;

/** Max display columns for the primary label — the LLM-generated task title. */
export const TASK_LIST_LABEL_MAX_WIDTH = 50;

/**
 * Floor kept for the label when a digest competes for a narrow row budget: a
 * row must stay identifiable even when its error digest takes most of the room.
 */
export const TASK_LIST_MIN_LABEL_WIDTH = 12;

/** Smallest digest worth its arrow; below this the fragment is dropped instead. */
export const TASK_LIST_MIN_DIGEST_WIDTH = 8;

/** Max rows rendered by `/tasks`; older entries collapse into a trailing note. */
export const TASK_LIST_MAX_ITEMS = 20;

/**
 * Flatten a description to a single line and truncate it to `maxWidth` display
 * columns, ending with a single-character ellipsis when anything was cut. The
 * result never exceeds `maxWidth` columns and never contains a newline, so one
 * task can only ever occupy one rendered row.
 */
export function truncateForList(
  text: string,
  maxWidth: number = TASK_LIST_DESCRIPTION_MAX_WIDTH,
): string {
  return truncateToWidth(collapseWhitespace(text), maxWidth);
}

/** A list capped to `max` entries, plus the trailing note. */
export interface LimitedList<T> {
  /**
   * Entries to render, in their original order — every active entry, then the
   * most recent history entries that fit the remaining budget.
   */
  items: T[];
  /** Real total before capping (never the rendered count). */
  total: number;
  /** How many entries the cap dropped (always history entries). */
  hidden: number;
  /** Trailing one-line note, or null when nothing was dropped. */
  note: string | null;
}

/** Statuses that mean "still work in flight"; every other status is history. */
const ACTIVE_TASK_STATUSES: ReadonlySet<TaskDetail['status']> = new Set<TaskDetail['status']>([
  'pending',
  'running',
]);

/** True for a task the user still cares about most: pending or running. */
export function isActiveTask(task: Pick<TaskDetail, 'status'>): boolean {
  return ACTIVE_TASK_STATUSES.has(task.status);
}

/**
 * Cap a list to `max` entries without ever hiding an active one.
 *
 * The engine returns tasks as pending → running → history, and history is
 * append-ordered, so history's tail holds the newest entries while active tasks
 * live at the head. Slicing the tail therefore drops exactly the rows the user
 * needs most once a session has more than `max` tasks.
 *
 * The cap is applied as a budget instead:
 * 1. every active entry (per `isActive`) is kept, even when that alone exceeds
 *    `max` — rows may go over the cap rather than hide a live task;
 * 2. the leftover budget (`max - activeCount`, floored at 0) is filled with the
 *    most recent history entries, i.e. history's tail;
 * 3. output keeps the incoming order, so no row jumps around.
 */
export function limitForList<T>(
  items: readonly T[],
  max: number = TASK_LIST_MAX_ITEMS,
  options: { isActive?: (item: T) => boolean } = {},
): LimitedList<T> {
  const isActive = options.isActive ?? (() => false);
  const total = items.length;
  if (total === 0) {
    return { items: [], total, hidden: 0, note: null };
  }

  const activeIndices: number[] = [];
  const historyIndices: number[] = [];
  items.forEach((item, index) => {
    (isActive(item) ? activeIndices : historyIndices).push(index);
  });

  // Active entries are never trimmed, so a burst of them can overflow `max`.
  const historyBudget = Math.max(0, max - activeIndices.length);
  const keptHistory = historyBudget === 0 ? [] : historyIndices.slice(-historyBudget);

  const keep = new Set<number>([...activeIndices, ...keptHistory]);
  const kept = items.filter((_, index) => keep.has(index));
  const hidden = total - kept.length;
  if (hidden === 0) {
    return { items: kept, total, hidden: 0, note: null };
  }

  // With active rows on screen the "last N" wording alone would hide the fact
  // that history was pushed out, so say both in one line.
  const note =
    activeIndices.length > 0
      ? `${noteFor(total, kept.length)}（另有 ${hidden} 条历史未显示）`
      : noteFor(total, kept.length);
  return { items: kept, total, hidden, note };
}

/** "… 显示最近 20 / 共 57 条" — only emitted when rows were dropped. */
function noteFor(total: number, shown: number): string {
  return `… 显示最近 ${shown} / 共 ${total} 条`;
}

export interface TaskRowOptions {
  descriptionMaxWidth?: number;
  /** Max display columns for the title label; defaults to TASK_LIST_LABEL_MAX_WIDTH. */
  labelMaxWidth?: number;
  /** Max display columns for the result digest; same one-line rule as the description. */
  resultMaxWidth?: number;
  /**
   * The session's default workspace (`ctx.workspaceDir`). Tasks running there
   * are the norm and carry no marker; only a task dispatched elsewhere shows
   * its workspace slug. Absent means "unknown", in which case every stamped
   * task shows its slug rather than hiding the attribution.
   */
  defaultWorkspacePath?: string;
  /** Epoch ms used as "now" for a running task's elapsed time; defaults to Date.now(). */
  now?: number;
  /**
   * Total display-column budget for the whole row (the overlay panel's inner
   * width). When set, the label and the result/error digest share this budget
   * so the row can never wrap onto a second physical line; when absent, the
   * label and digest caps apply independently (wide-output behavior).
   */
  rowMaxWidth?: number;
  /** Render the full task id instead of the short handle (collision fallback). */
  useFullId?: boolean;
}

/**
 * Worker-type tag from the canonical worker defaults (`🧸 puppet`, `🤖 <id>`).
 * Only rendered when the task actually carries a workerType — legacy tasks
 * and the existing row fixtures have none, so their rows stay byte-identical.
 */
function formatWorkerMark(workerType: string | undefined): string {
  if (!workerType) return '';
  const { emoji, label } = getWorkerMeta(workerType);
  return ` · ${emoji} ${label}`;
}

/**
 * Elapsed-time fragment: "已运行 X" while running (now − startedAt), or the
 * recorded total "耗时 X" once the task is terminal (completedAt − startedAt).
 * Absent timestamps yield no fragment, so rows without timing data are
 * unchanged. `now` is injected to keep rendering deterministic in tests.
 */
function formatDurationMark(task: TaskDetail, now: number): string {
  if (task.startedAt === undefined) return '';
  if (task.status === 'running') {
    return ` · 已运行 ${formatDuration(Math.max(0, now - task.startedAt))}`;
  }
  if (task.completedAt !== undefined) {
    return ` · 耗时 ${formatDuration(Math.max(0, task.completedAt - task.startedAt))}`;
  }
  return '';
}

/** The row's id column: the short `#tail` handle, or the full id on collision. */
function formatIdMark(task: TaskDetail, useFullId: boolean | undefined): string {
  return useFullId ? task.id : `#${shortId(task.id)}`;
}

/**
 * One list row: `[status] #tail: <label> — <workspace> · <worker> · <elapsed>
 * [→ <result> | ✗ <error>]`.
 *
 * The label is the task title (one line, capped); a task without a title falls
 * back to a digest of its description. The trailing digest is the worker's
 * result, or — for failed work — the error, which is the information the panel
 * exists to surface. Both the label and the digest are single-line and
 * column-capped, so one task can only ever occupy one rendered row.
 */
export function formatTaskRow(
  task: TaskDetail,
  options: TaskRowOptions = {},
): string {
  // Only a task stamped with workspace identity *and* running outside the
  // default workspace shows it; default-workspace and legacy tasks append
  // nothing (never "undefined").
  const workspacePart = formatTaskWorkspaceMark(task.workspace, options.defaultWorkspacePath);
  const workerPart = formatWorkerMark(task.workerType);
  const durationPart = formatDurationMark(task, options.now ?? Date.now());
  const prefix = `[${task.status}] ${formatIdMark(task, options.useFullId)}: `;
  const meta = `${workspacePart}${workerPart}${durationPart}`;

  // Label source: the LLM-generated title, else a one-line description digest.
  const title = collapseWhitespace(task.title);
  const labelSource = title || collapseWhitespace(task.description);
  const labelCap = title
    ? options.labelMaxWidth ?? TASK_LIST_LABEL_MAX_WIDTH
    : options.descriptionMaxWidth ?? TASK_LIST_DESCRIPTION_MAX_WIDTH;

  // Digest source: a failed task's error outranks everything else on the row;
  // otherwise the result, when the worker produced one. Whitespace-only
  // values collapse to nothing and drop the fragment entirely.
  const error = collapseWhitespace(task.error ?? '');
  const result = collapseWhitespace(task.result ?? '');
  const digestSource = error || result;
  const digestCap = options.resultMaxWidth ?? TASK_LIST_RESULT_MAX_WIDTH;
  const arrow = error ? ' ✗ ' : ' → ';

  let labelBudget: number;
  let digestBudget: number;
  if (options.rowMaxWidth === undefined) {
    // Wide-output behavior: each field capped independently.
    labelBudget = labelCap;
    digestBudget = digestSource ? digestCap : 0;
  } else {
    // Width-budgeted behavior: label and digest split what is left of the row
    // after the fixed columns (prefix + workspace/worker/duration marks).
    const budget = Math.max(1, options.rowMaxWidth);
    const avail = budget - stringWidth(prefix) - stringWidth(meta);
    if (!digestSource) {
      labelBudget = Math.min(labelCap, Math.max(0, avail));
      digestBudget = 0;
    } else if (error) {
      // Error first: it keeps at least MIN_DIGEST columns (down to the floor)
      // while the label keeps MIN_LABEL — a failed row without its reason
      // would be exactly the bare "failed" the panel is meant to fix.
      digestBudget = Math.min(digestCap, Math.max(TASK_LIST_MIN_DIGEST_WIDTH, avail - arrow.length - TASK_LIST_MIN_LABEL_WIDTH));
      labelBudget = Math.min(labelCap, Math.max(0, avail - arrow.length - digestBudget));
    } else {
      // Label first (it identifies the row); the result fills the rest.
      labelBudget = Math.min(labelCap, Math.max(TASK_LIST_MIN_LABEL_WIDTH, avail - arrow.length - digestCap));
      digestBudget = Math.min(digestCap, Math.max(0, avail - arrow.length - labelBudget));
      if (digestBudget < TASK_LIST_MIN_DIGEST_WIDTH) digestBudget = 0;
    }
    // Explicit caps from options still apply on top of the computed budgets.
    labelBudget = Math.min(labelBudget, labelCap);
    digestBudget = Math.min(digestBudget, digestCap);
  }

  const label = truncateToWidth(labelSource, Math.max(0, labelBudget));
  const digest = digestBudget > 0 && digestSource
    ? truncateToWidth(digestSource, digestBudget)
    : '';

  let row = `${prefix}${label}${meta}${digest ? `${arrow}${digest}` : ''}`;
  // Final safety: an over-long id or metadata run (extreme narrow terminals)
  // must still not wrap — one hard cut keeps the row one physical line.
  if (options.rowMaxWidth !== undefined && stringWidth(row) > options.rowMaxWidth) {
    row = truncateToWidth(row, options.rowMaxWidth);
  }
  return row;
}

/**
 * Render the whole `/tasks` output: capped rows plus an optional note line.
 *
 * Rows whose short handle (`#tail`) collides with another rendered row fall
 * back to their full task id — two rows showing the same handle would make
 * `/tasks <ref>` and `/cancel <ref>` ambiguous, which is worse than a wide row.
 */
export function formatTaskList(
  tasks: readonly TaskDetail[],
  options: TaskRowOptions & { maxItems?: number } = {},
): string {
  const limited = limitForList(tasks, options.maxItems, { isActive: isActiveTask });
  const tailCounts = new Map<string, number>();
  for (const task of limited.items) {
    const tail = shortId(task.id);
    tailCounts.set(tail, (tailCounts.get(tail) ?? 0) + 1);
  }
  const lines = limited.items.map(task =>
    formatTaskRow(task, {
      ...options,
      useFullId: (tailCounts.get(shortId(task.id)) ?? 0) > 1,
    }),
  );
  if (limited.note) lines.push(limited.note);
  return lines.join('\n');
}
