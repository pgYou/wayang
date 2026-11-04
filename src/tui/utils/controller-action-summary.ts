/**
 * Summaries for controller action rows — tool calls that act on workers:
 * - `chat_worker`: a message sent to a running worker
 * - `add_task`: a task dispatched to a (new or reused) worker
 *
 * Like permission-summary, this is a display layer only: the raw JSON stays
 * in the conversation entries. The paired tool result is folded into the
 * summary (delivered / failed) so rows do not need a separate result line.
 */
import { collapseWhitespace, fitWithSuffix, shortId, stringWidth, truncateToWidth } from './text-width';
import { resolveDeclaredWorkspaceSlug } from './workspace-display';

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
  /** Read timing, parsed from the result ("queued" = read at a turn/stage boundary). */
  delivery?: 'delivered' | 'queued';
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
  // Delivery timing, parsed from the result. Queued is checked FIRST: the
  // queued text ("QUEUED only, not delivered yet") contains both words, so
  // checking delivered first (or in parallel) mislabels a queued message as
  // delivered.
  let delivery: 'delivered' | 'queued' | undefined;
  if (result !== undefined && !failed) {
    delivery = /\bqueued\b/i.test(result.text)
      ? 'queued'
      : /\bdelivered\b/i.test(result.text) ? 'delivered' : undefined;
  }
  return {
    ...(workerId && { workerId }),
    lines,
    hiddenLines: hidden,
    outcome: result === undefined ? 'pending' : failed ? 'failed' : 'ok',
    failure: failed ? failureText(result!.text, width) : '',
    ...(delivery && { delivery }),
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
  /**
   * Slug of the workspace the call declared, when it declared one that differs
   * from the session default. Undefined for a default-workspace dispatch, so
   * the row renders exactly as before.
   */
  workspaceSlug?: string;
  /** Description preview lines. */
  lines: string[];
  hiddenLines: number;
  outcome: ActionOutcome;
  failure: string;
}

/** "Task t-…-abcd added" / "Task t-…-abcd assigned to worker …" */
const TASK_ID_RE = /^Task (\S+) (?:added|assigned)/;

/**
 * Columns the header's fixed chrome occupies: the lead-in icon plus action
 * label ("⊕ 派发任务 ", 11), the " #xxxx" task handle (6) and the outcome mark
 * ("  ✔ 已派发", 10). Ink separates sibling text nodes with one column, which is
 * why the handle and the mark each include a leading space.
 */
const ADD_TASK_HEADER_CHROME = 27;

/** Columns the workspace tag adds on top of its own text (sibling separator). */
const ADD_TASK_TAG_INSET = 1;

/** Max columns the trailing " — <slug>" workspace tag may claim. */
export const ADD_TASK_WORKSPACE_TAG_MAX_WIDTH = 16;

/**
 * Trailing workspace tag for an `add_task` header row: " — <slug>", or '' when
 * the task runs in the default workspace (nothing to attribute). Truncated to
 * at most `maxWidth` columns so a long slug can never push the row past the
 * terminal, and never wrapped — the header stays one line.
 */
export function formatAddTaskWorkspaceTag(
  slug?: string | null,
  maxWidth: number = ADD_TASK_WORKSPACE_TAG_MAX_WIDTH,
): string {
  const label = slug?.trim();
  if (!label) return '';
  return truncateToWidth(` — ${label}`, maxWidth);
}

export interface AddTaskSummaryOptions {
  /** Lines of description preview (default 2). */
  maxLines?: number;
  /** The session's default workspace — declarations pointing at it show no tag. */
  defaultWorkspacePath?: string;
  /** Known workspace identities, used to resolve the registry slug. */
  workspaces?: ReadonlyArray<{ path?: string | null; slug?: string | null }> | null;
}

/**
 * Summarize an `add_task` call. Success results start with "Task <id> added" or
 * "Task <id> assigned"; anything else (validation messages, "[ERROR] …") means
 * the task was not dispatched.
 *
 * The workspace tag comes from the call's own `workspace` argument (the tool
 * stamps the slug server-side, so the argument is all the row has) resolved
 * against the session's known identities — no extra RPC field, no task change.
 */
export function summarizeAddTask(
  argsJson: string,
  width: number,
  result?: ActionResult,
  options: AddTaskSummaryOptions = {},
): AddTaskSummary {
  const args = parseArgs(argsJson) ?? {};
  const maxLines = options.maxLines ?? 2;
  const title = str(args.title) ?? '(untitled)';
  const description = str(args.description) ?? '';
  const { lines, hidden } = previewLines(description, maxLines, width);

  const declaredWorkspaceSlug = resolveDeclaredWorkspaceSlug(str(args.workspace), {
    defaultWorkspacePath: options.defaultWorkspacePath,
    workspaces: options.workspaces,
  });
  const workspaceTag = formatAddTaskWorkspaceTag(declaredWorkspaceSlug);

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

  // The title yields the columns the workspace tag and the fixed header chrome
  // need, so the header can never wrap onto a second line.
  const tagCost = workspaceTag ? stringWidth(workspaceTag) + ADD_TASK_TAG_INSET : 0;
  const titleBudget = Math.max(1, width - ADD_TASK_HEADER_CHROME - tagCost);

  return {
    title: fitWithSuffix(collapseWhitespace(title), '', titleBudget),
    ...(declaredWorkspaceSlug && { workspaceSlug: declaredWorkspaceSlug }),
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

// ---------------------------------------------------------------------------
// respond_inquiry
// ---------------------------------------------------------------------------

export interface InquiryResolutionSummary {
  /** inquiryId from the tool args, when parseable. */
  inquiryId?: string;
  /** Short handle of the inquiry id ("#xxxx"), matching the question row. */
  inquiryShortId?: string;
  outcome: ActionOutcome;
  /** Failure note (tool error without the "[ERROR]" marker) — empty when ok. */
  failure: string;
}

/**
 * Summarize a `respond_inquiry` call. The answer itself is long-form text and
 * stays in the conversation; the row shows the outcome and the #xxxx handle
 * of the question it answers.
 */
export function summarizeInquiryResolution(
  argsJson: string,
  result?: ActionResult,
): InquiryResolutionSummary {
  const args = parseArgs(argsJson);
  const inquiryId = args ? str(args.inquiryId) : undefined;

  const failed = result !== undefined && (result.isError === true || /^\[ERROR\]/.test(result.text));
  return {
    ...(inquiryId && { inquiryId }),
    ...(inquiryId && { inquiryShortId: shortId(inquiryId) }),
    outcome: result === undefined ? 'pending' : failed ? 'failed' : 'ok',
    failure: failed ? failureText(result!.text, 80) : '',
  };
}
