/**
 * Row formatting for the `/tasks` list.
 *
 * A task's description is the full instruction handed to a worker — routinely
 * thousands of characters, often with embedded newlines. Rendering it verbatim
 * made Ink re-layout tens of thousands of characters per `/tasks` call and hang
 * the TUI. The list therefore shows a one-line digest of each description, and
 * caps the number of rows — keeping pending/running tasks ahead of older
 * history — while every other column stays exactly as it was.
 *
 * `task.result` is the other free-form field on a row: it holds the worker's
 * final report, which is just as often multi-kilobyte and multi-line. It gets
 * the exact same one-line digest treatment (see `TASK_LIST_RESULT_MAX_WIDTH`),
 * so one finished task can never wrap the panel into hundreds of rows.
 *
 * Pure formatting only — no RPC shape changes, no task data mutation.
 */

import type { TaskDetail } from '@/types/index';
import { collapseWhitespace, truncateToWidth } from '@/tui/utils/text-width';
import { formatTaskWorkspaceMark } from '@/tui/utils/workspace-display';

/** Max display columns for one description in the list (CJK/emoji count double). */
export const TASK_LIST_DESCRIPTION_MAX_WIDTH = 80;

/**
 * Max display columns for one result digest in the list (CJK/emoji count
 * double). Smaller than the description budget: the result is a trailing
 * "what came out of it" summary, not the instruction the user needs to verify.
 */
export const TASK_LIST_RESULT_MAX_WIDTH = 60;

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
  /** Max display columns for the result digest; same one-line rule as the description. */
  resultMaxWidth?: number;
  /**
   * The session's default workspace (`ctx.workspaceDir`). Tasks running there
   * are the norm and carry no marker; only a task dispatched elsewhere shows
   * its workspace slug. Absent means "unknown", in which case every stamped
   * task shows its slug rather than hiding the attribution.
   */
  defaultWorkspacePath?: string;
}

/** One list row: every existing column, with description and result digested. */
export function formatTaskRow(
  task: TaskDetail,
  options: TaskRowOptions = {},
): string {
  // Only a task stamped with workspace identity *and* running outside the
  // default workspace shows it; default-workspace and legacy tasks append
  // nothing (never "undefined").
  const workspacePart = formatTaskWorkspaceMark(task.workspace, options.defaultWorkspacePath);
  const description = truncateForList(task.description, options.descriptionMaxWidth);
  // The result is the worker's free-form report — flatten and cap it exactly
  // like the description, so it can only ever contribute columns, never rows.
  // An absent, empty or whitespace-only result appends nothing at all.
  const result = task.result
    ? truncateForList(task.result, options.resultMaxWidth ?? TASK_LIST_RESULT_MAX_WIDTH)
    : '';
  return `[${task.status}] ${task.id}: ${description}${workspacePart}${result ? ` → ${result}` : ''}`;
}

/** Render the whole `/tasks` output: capped rows plus an optional note line. */
export function formatTaskList(
  tasks: readonly TaskDetail[],
  options: TaskRowOptions & { maxItems?: number } = {},
): string {
  const limited = limitForList(tasks, options.maxItems, { isActive: isActiveTask });
  const lines = limited.items.map(task => formatTaskRow(task, options));
  if (limited.note) lines.push(limited.note);
  return lines.join('\n');
}
