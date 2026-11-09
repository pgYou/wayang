/**
 * `/tasks <id>` — the on-demand detail view behind the `/tasks` list.
 *
 * The list row is a one-line digest; this is where the full instruction, the
 * full error and the worker/session bookkeeping become visible. Everything
 * renders inside the same overlay panel as the list, so free-form fields are
 * hard-wrapped to the panel width and capped at a line budget with an explicit
 * truncation note — a 30KB report must never turn the panel back into the
 * full-screen reflow that hung the TUI (issue #39/#49).
 *
 * `resolveTaskRef` implements the id addressing shared by `/tasks <ref>` and
 * `/cancel <ref>`: exact id, unique suffix (the `#tail` handle the list shows)
 * or unique prefix; an ambiguous reference errors with the candidates instead
 * of silently picking one.
 *
 * Pure formatting only — reads fields the task already carries, no RPC shape
 * changes.
 */

import type { TaskDetail } from '@/types/index';
import { getWorkerMeta } from '@/services/agents/worker-defaults';
import { formatDuration } from '@/services/worker-transcript';
import { charWidth, collapseWhitespace, shortId, stringWidth } from '@/tui/utils/text-width';
import { resolveWorkspaceSlug } from '@/tui/utils/workspace-display';

/** Max wrapped lines per free-form field (description / result / error). */
export const TASK_DETAIL_MAX_FIELD_LINES = 30;

/** Two-space indent for free-form field content under its `字段:` header. */
const FIELD_INDENT = '  ';

/** Compact ISO timestamp — matches the transcript/activity conventions. */
function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** Consume up to `width` display columns from the head of `s`. */
function takeByWidth(s: string, width: number): { taken: string; rest: string } {
  let w = 0;
  let taken = '';
  for (const ch of s) {
    const cw = charWidth(ch.codePointAt(0) ?? 0);
    if (w + cw > width) break;
    taken += ch;
    w += cw;
  }
  return { taken, rest: s.slice([...taken].length) };
}

/**
 * Word-wrap text to `width` display columns, preserving explicit line breaks.
 *
 * Words split on spaces stay intact while they fit; a single word wider than
 * the budget (a long path, an unbroken CJK run without spaces) is hard-broken
 * by columns. Every returned line is at most `width` columns, so the panel can
 * never grow horizontally. CJK/emoji count double via `stringWidth`.
 */
export function wrapToWidth(text: string, width: number): string[] {
  if (width < 1) return [];
  const lines: string[] = [];
  for (const source of text.replace(/\r\n/g, '\n').split('\n')) {
    if (stringWidth(source) <= width) {
      lines.push(source);
      continue;
    }
    let current = '';
    for (const word of source.split(' ')) {
      const candidate = current ? `${current} ${word}` : word;
      if (stringWidth(candidate) <= width) {
        current = candidate;
        continue;
      }
      if (current) lines.push(current);
      let rest = word;
      while (stringWidth(rest) > width) {
        const { taken, rest: remaining } = takeByWidth(rest, width);
        lines.push(taken);
        rest = remaining;
      }
      current = rest;
    }
    if (current) lines.push(current);
  }
  return lines;
}

/**
 * A free-form field as indented, wrapped, line-capped block. Beyond the cap a
 * single note line says how much was cut — never a silent drop.
 */
function fieldBlock(text: string, width: number): string[] {
  const inner = Math.max(8, width - stringWidth(FIELD_INDENT));
  const wrapped = wrapToWidth(text, inner);
  const lines = wrapped
    .slice(0, TASK_DETAIL_MAX_FIELD_LINES)
    .map(line => (line ? FIELD_INDENT + line : ''));
  if (wrapped.length > TASK_DETAIL_MAX_FIELD_LINES) {
    lines.push(`${FIELD_INDENT}… 已截断（共 ${wrapped.length} 行）`);
  }
  return lines;
}

export interface TaskDetailOptions {
  /** Panel inner width in display columns; free-form fields wrap to it. */
  width?: number;
  /** Epoch ms used as "now" for a running task's elapsed time; defaults to Date.now(). */
  now?: number;
}

/**
 * Render one task's detail view: header (short handle + full id + label),
 * worker/priority/timing lines, worker session + transcript ids, workspace,
 * then the full error, description and result as wrapped blocks.
 */
export function formatTaskDetail(task: TaskDetail, options: TaskDetailOptions = {}): string {
  const width = Math.max(20, options.width ?? 80);
  const now = options.now ?? Date.now();
  const lines: string[] = [];

  const label = collapseWhitespace(task.title)
    || collapseWhitespace(task.description)
    || '(untitled)';
  lines.push(...wrapToWidth(`Task #${shortId(task.id)} (${task.id}) · ${task.status} — ${label}`, width));

  let workerTag = '-';
  if (task.workerType) {
    const { emoji, label } = getWorkerMeta(task.workerType);
    workerTag = `${emoji} ${label}`;
  }
  const meta = [
    `worker: ${workerTag}`,
    `优先级: ${task.priority}`,
    ...(task.multiStage ? ['multi-stage'] : []),
  ].join(' · ');
  lines.push(...wrapToWidth(meta, width));

  // One timestamp per line: an ISO instant plus its label already fills most
  // of an 80-column panel, and a joined line would wrap mid pair.
  lines.push(...wrapToWidth(`创建 ${iso(task.createdAt)}`, width));
  if (task.startedAt !== undefined) {
    lines.push(...wrapToWidth(`开始 ${iso(task.startedAt)}`, width));
  }
  if (task.completedAt !== undefined) {
    const total = task.startedAt !== undefined
      ? ` · 耗时 ${formatDuration(Math.max(0, task.completedAt - task.startedAt))}`
      : '';
    lines.push(...wrapToWidth(`结束 ${iso(task.completedAt)}${total}`, width));
  } else if (task.startedAt !== undefined && task.status === 'running') {
    lines.push(...wrapToWidth(`已运行 ${formatDuration(Math.max(0, now - task.startedAt))}`, width));
  }

  const sessionParts: string[] = [];
  if (task.workerSessionId) sessionParts.push(`worker 会话: ${task.workerSessionId}`);
  if (task.workerTranscriptId) sessionParts.push(`transcript: ${task.workerTranscriptId}`);
  if (sessionParts.length > 0) lines.push(...wrapToWidth(sessionParts.join(' · '), width));
  // Workspace on its own line: the slug + path pair reads as one unit and a
  // joined line would wrap between "workspace:" and its value at 80 columns.
  const slug = resolveWorkspaceSlug(task.workspace);
  if (slug) {
    lines.push(...wrapToWidth(`workspace: ${slug}${task.workspace?.path ? ` (${task.workspace.path})` : ''}`, width));
  }

  if (collapseWhitespace(task.error ?? '')) {
    lines.push('错误:');
    lines.push(...fieldBlock(task.error ?? '', width));
  }
  lines.push('描述:');
  lines.push(...fieldBlock(task.description, width));
  if (collapseWhitespace(task.result ?? '')) {
    lines.push('结果:');
    lines.push(...fieldBlock(task.result ?? '', width));
  }
  return lines.join('\n');
}

/** Either the matched task, or a user-facing error message. */
export type TaskRefResolution =
  | { task: TaskDetail }
  | { error: string };

/**
 * Resolve a task reference against the task list: exact id, unique id suffix
 * (the `#tail` handle the list rows show — with or without the `#`) or unique
 * id prefix. Zero matches and ambiguous references both produce an error; an
 * ambiguous ref lists up to five candidate ids so the user can disambiguate.
 */
export function resolveTaskRef(tasks: readonly TaskDetail[], ref: string): TaskRefResolution {
  const r = ref.trim().replace(/^#/, '');
  if (!r) return { error: 'Empty task reference' };

  const candidates = tasks.filter(
    task => task.id === r || task.id.endsWith(r) || task.id.startsWith(r),
  );
  if (candidates.length === 1) return { task: candidates[0] };
  if (candidates.length === 0) {
    return { error: `No task matches "${ref}" — run /tasks to list ids` };
  }
  const shown = candidates.slice(0, 5).map(task => task.id).join(', ');
  const more = candidates.length > 5 ? ` … (+${candidates.length - 5})` : '';
  return { error: `"${ref}" matches ${candidates.length} tasks: ${shown}${more}` };
}
