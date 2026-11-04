/**
 * Row formatting for the `/tasks` list.
 *
 * A task's description is the full instruction handed to a worker — routinely
 * thousands of characters, often with embedded newlines. Rendering it verbatim
 * made Ink re-layout tens of thousands of characters per `/tasks` call and hang
 * the TUI. The list therefore shows a one-line digest of each description, and
 * caps the number of rows, while every other column stays exactly as it was.
 *
 * Pure formatting only — no RPC shape changes, no task data mutation.
 */

import type { TaskDetail } from '@/types/index';
import { collapseWhitespace, truncateToWidth } from '@/tui/utils/text-width';
import { formatWorkspaceDetail } from '@/tui/utils/workspace-display';

/** Max display columns for one description in the list (CJK/emoji count double). */
export const TASK_LIST_DESCRIPTION_MAX_WIDTH = 80;

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

/** A list capped to its most recent `max` entries, plus the trailing note. */
export interface LimitedList<T> {
  /** Entries to render — the most recent `max`, in their original order. */
  items: T[];
  /** Real total before capping (never the rendered count). */
  total: number;
  /** How many entries the cap dropped. */
  hidden: number;
  /** Trailing one-line note, or null when nothing was dropped. */
  note: string | null;
}

/**
 * Cap a list to its most recent `max` entries.
 *
 * "Most recent" is the tail of the incoming order: the engine returns tasks as
 * pending → running → history, and history is append-ordered, so the tail holds
 * the newest entries. Order within the kept slice is preserved, and nothing is
 * re-sorted.
 */
export function limitForList<T>(
  items: readonly T[],
  max: number = TASK_LIST_MAX_ITEMS,
): LimitedList<T> {
  const total = items.length;
  if (max <= 0) {
    return { items: [], total, hidden: total, note: noteFor(total, 0) };
  }
  if (total <= max) {
    return { items: [...items], total, hidden: 0, note: null };
  }
  const kept = items.slice(total - max);
  return { items: kept, total, hidden: total - kept.length, note: noteFor(total, kept.length) };
}

/** "… 显示最近 20 / 共 57 条" — only emitted when rows were dropped. */
function noteFor(total: number, shown: number): string {
  return `… 显示最近 ${shown} / 共 ${total} 条`;
}

/** One list row: every existing column, with the description digested. */
export function formatTaskRow(
  task: TaskDetail,
  descriptionMaxWidth: number = TASK_LIST_DESCRIPTION_MAX_WIDTH,
): string {
  // Only tasks stamped with workspace identity show it; legacy tasks
  // append nothing (never "undefined").
  const workspace = formatWorkspaceDetail(task.workspace);
  const workspacePart = workspace ? ` — ${workspace}` : '';
  const description = truncateForList(task.description, descriptionMaxWidth);
  return `[${task.status}] ${task.id}: ${description}${workspacePart}${task.result ? ` → ${task.result}` : ''}`;
}

/** Render the whole `/tasks` output: capped rows plus an optional note line. */
export function formatTaskList(
  tasks: readonly TaskDetail[],
  options: { maxItems?: number; descriptionMaxWidth?: number } = {},
): string {
  const limited = limitForList(tasks, options.maxItems);
  const lines = limited.items.map(task => formatTaskRow(task, options.descriptionMaxWidth));
  if (limited.note) lines.push(limited.note);
  return lines.join('\n');
}
