/**
 * Summaries for controller action rows — tool calls that act on workers:
 * - `chat_worker`: a message sent to a running worker
 * - `add_task`: a task dispatched to a (new or reused) worker
 *
 * Like permission-summary, this is a display layer only: the raw JSON stays
 * in the conversation entries. The paired tool result is folded into the
 * summary (delivered / failed) so rows do not need a separate result line.
 */
import { collapseWhitespace, fitWithSuffix, shortId, truncateToWidth } from './text-width';

/** Paired tool-result context for an action call, when one exists. */
export interface ActionResult {
  text: string;
  isError?: boolean;
}

/** Outcome of an action, derived from its paired tool result. */
export type ActionOutcome = 'pending' | 'ok' | 'failed';

/** Parse tool-call JSON arguments; null when unparseable or not an object. */
function parseArgs(argsJson: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(argsJson) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * Preview of a multi-line text: up to `maxLines` non-empty lines, each
 * truncated to `width`, plus the count of lines left out.
 */
export function previewLines(text: string, maxLines: number, width: number): { lines: string[]; hidden: number } {
  const all = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  return {
    lines: all.slice(0, maxLines).map(l => truncateToWidth(l, width)),
    hidden: Math.max(0, all.length - maxLines),
  };
}

/** Strip the "[ERROR] " marker tools prepend to failure results. */
function failureText(text: string, width: number): string {
  return truncateToWidth(collapseWhitespace(text.replace(/^\[ERROR\]\s*/, '')), width);
}

// ---------------------------------------------------------------------------
// chat_worker
// ---------------------------------------------------------------------------

export interface WorkerMessageSummary {
  /** Full target worker id, when known. */
  workerId?: string;
  /** Message preview lines (first non-empty lines, truncated). */
  lines: string[];
  /** Number of non-empty message lines not shown. */
  hiddenLines: number;
  outcome: ActionOutcome;
  /** Failure note (tool error without the "[ERROR]" marker) — empty when ok. */
  failure: string;
}

/**
 * Summarize a `chat_worker` call. Delivery is "ok" unless the paired result is
 * an error — the tool reports undeliverable messages as "[ERROR] Worker … not
 * found or not running."
 */
export function summarizeWorkerMessage(
  argsJson: string,
  width: number,
  result?: ActionResult,
  maxLines = 3,
): WorkerMessageSummary {
  const args = parseArgs(argsJson);
  const workerId = args ? str(args.workerId) ?? str(args.worker_id) : undefined;
  const message = args ? str(args.message) ?? '' : argsJson;
  const { lines, hidden } = previewLines(message, maxLines, width);

  const failed = result !== undefined && (result.isError === true || /^\[ERROR\]/.test(result.text));
  return {
    ...(workerId && { workerId }),
    lines,
    hiddenLines: hidden,
    outcome: result === undefined ? 'pending' : failed ? 'failed' : 'ok',
    failure: failed ? failureText(result!.text, width) : '',
  };
}

// ---------------------------------------------------------------------------
// add_task
// ---------------------------------------------------------------------------

export interface AddTaskSummary {
  title: string;
  /** Worker type requested (defaults to "puppet", like the tool). */
  workerType: string;
  priority?: string;
  multiStage: boolean;
  /** Existing idle worker the task is assigned to (reuse), if any. */
  assignToWorker?: string;
  /** Created task id short handle ("#xxxx"), parsed from the result. */
  taskShortId?: string;
  /** Description preview lines. */
  lines: string[];
  hiddenLines: number;
  outcome: ActionOutcome;
  failure: string;
}

/** "Task t-…-abcd added" / "Task t-…-abcd assigned to worker …" */
const TASK_ID_RE = /^Task (\S+) (?:added|assigned)/;

/**
 * Summarize an `add_task` call. Success results start with "Task <id> added" or
 * "Task <id> assigned"; anything else (validation messages, "[ERROR] …") means
 * the task was not dispatched.
 */
export function summarizeAddTask(
  argsJson: string,
  width: number,
  result?: ActionResult,
  maxLines = 2,
): AddTaskSummary {
  const args = parseArgs(argsJson) ?? {};
  const title = str(args.title) ?? '(untitled)';
  const description = str(args.description) ?? '';
  const { lines, hidden } = previewLines(description, maxLines, width);

  let outcome: ActionOutcome = 'pending';
  let taskShortId: string | undefined;
  let failure = '';
  if (result) {
    const m = TASK_ID_RE.exec(result.text);
    if (m && !result.isError) {
      outcome = 'ok';
      taskShortId = shortId(m[1]);
    } else {
      outcome = 'failed';
      failure = failureText(result.text, width);
    }
  }

  return {
    title: fitWithSuffix(collapseWhitespace(title), '', width),
    workerType: str(args.workerType) ?? str(args.worker_type) ?? 'puppet',
    ...(str(args.priority) && { priority: str(args.priority) }),
    multiStage: args.multiStage === true,
    ...(str(args.assignToWorker) && { assignToWorker: str(args.assignToWorker) }),
    ...(taskShortId && { taskShortId }),
    lines,
    hiddenLines: hidden,
    outcome,
    failure,
  };
}
