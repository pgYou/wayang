/**
 * Human-readable summaries for permission request / resolution rows.
 *
 * Permission requests arrive as `permission_request` signal entries carrying
 * `permissionMeta` (tool name + args); resolutions are the controller's
 * `respond_permission` tool calls. Both are rendered as one informative line
 * (plus an optional indented detail line) instead of flattened text or raw
 * JSON. The raw JSON stays in the conversation entries — these summaries are
 * a display layer only.
 */
import type { PermissionRequestMeta, ToolCallRecord } from '@/types/conversation';

/** Lifecycle of a permission flow item. */
export type PermissionSummaryState = 'pending' | 'approved' | 'denied';

/** Summary of one permission request / resolution row. */
export interface PermissionSummary {
  /** Main one-line summary (no status icon — the theme supplies it). */
  label: string;
  /** Optional indented second line with extra context (description / reason). */
  detail: string;
  state: PermissionSummaryState;
}

// ---------------------------------------------------------------------------
// Width helpers — no shared display-width util exists in the TUI yet, so the
// East-Asian-width approximation lives here.
// ---------------------------------------------------------------------------

/** Display width of one code point: CJK/fullwidth = 2, combining marks = 0, else 1. */
function charWidth(cp: number): number {
  if (cp >= 0x0300 && cp <= 0x036f) return 0; // combining diacritics
  if (
    (cp >= 0x1100 && cp <= 0x115f) // Hangul Jamo
    || (cp >= 0x2e80 && cp <= 0xa4cf) // CJK radicals .. Yi syllables
    || (cp >= 0xa960 && cp <= 0xa97f) // Hangul Jamo Extended-A
    || (cp >= 0xac00 && cp <= 0xd7a3) // Hangul syllables
    || (cp >= 0xf900 && cp <= 0xfaff) // CJK compatibility ideographs
    || (cp >= 0xfe10 && cp <= 0xfe19) // vertical forms
    || (cp >= 0xfe30 && cp <= 0xfe6f) // CJK compatibility forms
    || (cp >= 0xff00 && cp <= 0xff60) // fullwidth forms
    || (cp >= 0xffe0 && cp <= 0xffe6) // fullwidth signs
    || (cp >= 0x1f300 && cp <= 0x1faff) // emoji (approximation)
    || (cp >= 0x20000 && cp <= 0x3fffd) // CJK Extension B+
  ) {
    return 2;
  }
  return 1;
}

/** Total display width of a string, counting CJK/fullwidth as 2 columns. */
function stringWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    w += charWidth(ch.codePointAt(0) ?? 0);
  }
  return w;
}

/** Hard-truncate to `maxWidth` display columns, appending an ellipsis when cut. */
function truncateToWidth(s: string, maxWidth: number): string {
  if (maxWidth <= 0) return '';
  if (stringWidth(s) <= maxWidth) return s;
  const limit = maxWidth - 1; // reserve one column for the ellipsis
  let w = 0;
  let out = '';
  for (const ch of s) {
    const cw = charWidth(ch.codePointAt(0) ?? 0);
    if (w + cw > limit) break;
    out += ch;
    w += cw;
  }
  return out + '…';
}

/** Collapse runs of whitespace (incl. newlines) to single spaces. */
function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Truncate `body` so that `body + suffix` fits within `budget` columns,
 * keeping the suffix intact (e.g. the "(N 行)" note survives truncation).
 */
function fitWithSuffix(body: string, suffix: string, budget: number): string {
  const bodyBudget = budget - stringWidth(suffix);
  if (bodyBudget < 1) {
    // No room for a body — the suffix alone (possibly truncated).
    return truncateToWidth(suffix, Math.max(budget, 1));
  }
  return truncateToWidth(body, bodyBudget) + suffix;
}

/** Keep at most the last `maxSegments` path segments of a long path. */
function shortenPath(p: string, maxSegments = 3): string {
  const segs = p.split('/').filter(s => s.length > 0);
  if (segs.length <= maxSegments) return p;
  return '…/' + segs.slice(-maxSegments).join('/');
}

// ---------------------------------------------------------------------------
// Tool-arg extraction helpers (accept common arg-name aliases, e.g. Claude
// Code workers use `file_path` where Wayang tools use `path`).
// ---------------------------------------------------------------------------

function argString(args: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = args[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

function argNumber(args: Record<string, unknown>, keys: string[]): number | undefined {
  for (const k of keys) {
    const v = args[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return undefined;
}

/** Number of lines in a multi-line string arg (1 for a single line). */
function lineCount(v: unknown): number {
  return typeof v === 'string' ? v.split('\n').length : 0;
}

/** Short Chinese labels for read-only tools — no args worth showing. */
const READ_ONLY_LABELS: Record<string, string> = {
  query_signals: '查询信号历史',
  list_tasks: '查看任务列表',
  get_task_detail: '查看任务详情',
  check_messages: '查看控制器消息',
  web_search: '搜索网页',
};

/** Max raw-JSON prefix shown for tools without a dedicated template. */
const UNKNOWN_ARGS_PREFIX = 60;

/** Build the per-tool summary fragment (without the "权限申请 <tool>" prefix). */
function toolSummary(toolName: string, args: Record<string, unknown>, budget: number): string {
  // Template lookup is case-insensitive so third-party tool names
  // (e.g. Claude Code's "Bash") hit the same templates.
  const key = toolName.toLowerCase();

  switch (key) {
    case 'bash': {
      const command = argString(args, ['command']);
      if (!command) return '';
      const lines = command.split('\n');
      const note = lines.length > 1 ? ` (${lines.length} 行)` : '';
      return fitWithSuffix(lines[0].trim(), note, budget);
    }

    case 'write_file': {
      const path = argString(args, ['path', 'file_path']);
      if (!path) return '';
      const lines = lineCount(args.content);
      const note = lines > 0 ? ` (+${lines})` : '';
      return fitWithSuffix(shortenPath(path), note, budget);
    }

    case 'edit_file': {
      const path = argString(args, ['path', 'file_path']);
      if (!path) return '';
      const oldLines = lineCount(args.old_string);
      const newLines = lineCount(args.new_string);
      const note = oldLines > 0 || newLines > 0 ? ` (${oldLines}→${newLines} 行)` : '';
      return fitWithSuffix(shortenPath(path), note, budget);
    }

    case 'read_file': {
      const path = argString(args, ['path', 'file_path']);
      if (!path) return '';
      const offset = argNumber(args, ['offset']);
      const limit = argNumber(args, ['limit']);
      const range = offset !== undefined
        ? `:${offset}${limit !== undefined ? `+${limit}` : ''}`
        : '';
      return truncateToWidth(shortenPath(path) + range, budget);
    }

    case 'search_files':
      return truncateToWidth(argString(args, ['pattern']) ?? '', budget);

    case 'search_content':
      return truncateToWidth(argString(args, ['query']) ?? '', budget);

    case 'add_task': {
      const title = argString(args, ['title']);
      if (!title) return '';
      const workerType = argString(args, ['worker_type', 'workerType']);
      return fitWithSuffix(title, workerType ? ` (${workerType})` : '', budget);
    }

    case 'chat_worker': {
      const workerId = argString(args, ['worker_id', 'workerId']);
      const message = argString(args, ['message']);
      if (!workerId && !message) return '';
      const head = message ? message.split('\n')[0].trim() : '';
      return truncateToWidth(workerId ? `${workerId}: ${head}` : head, budget);
    }

    default: {
      const readOnly = READ_ONLY_LABELS[key];
      if (readOnly) return readOnly;
      // Unknown tool — raw JSON prefix so no information is silently lost.
      let raw = '';
      try {
        raw = JSON.stringify(args);
      } catch {
        raw = String(args);
      }
      if (!raw || raw === '{}') return '';
      return truncateToWidth(raw, Math.min(budget, UNKNOWN_ARGS_PREFIX));
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Summarize a pending permission request for one-line display. */
export function summarizePermissionRequest(meta: PermissionRequestMeta, maxWidth: number): PermissionSummary {
  const toolArgs = (meta.toolArgs && typeof meta.toolArgs === 'object' && !Array.isArray(meta.toolArgs))
    ? meta.toolArgs
    : {};

  const prefix = `权限申请 ${meta.toolName}`;
  // Budget left for the per-tool fragment after the prefix and its space.
  const budget = maxWidth - stringWidth(prefix) - 1;
  const fragment = budget >= 1 ? toolSummary(meta.toolName, toolArgs, budget) : '';
  const label = truncateToWidth(fragment ? `${prefix} ${fragment}` : prefix, maxWidth);
  const detail = meta.description
    ? truncateToWidth(collapseWhitespace(meta.description), maxWidth)
    : '';
  return { label, detail, state: 'pending' };
}

/** Paired tool-result context for a resolution, when one exists. */
export interface PermissionResolutionResult {
  text: string;
  isError?: boolean;
}

/**
 * Summarize a controller `respond_permission` tool call as approved/denied.
 *
 * The approved flag and reason come from the call's JSON arguments; the paired
 * tool result (e.g. "Permission granted…", or an "[ERROR] … not found" note)
 * is used as a fallback when the arguments cannot be parsed, and surfaces
 * resolutions that did not take effect.
 */
export function summarizePermissionResolution(
  tc: ToolCallRecord,
  maxWidth: number,
  result?: PermissionResolutionResult,
): PermissionSummary {
  let requestId: string | undefined;
  let approved: boolean | undefined;
  let reason: string | undefined;
  try {
    const parsed = JSON.parse(tc.arguments) as Record<string, unknown>;
    if (typeof parsed.requestId === 'string' && parsed.requestId) requestId = parsed.requestId;
    if (typeof parsed.approved === 'boolean') approved = parsed.approved;
    if (typeof parsed.reason === 'string' && parsed.reason) reason = parsed.reason;
  } catch {
    // Unparseable arguments — fall through to result-based inference.
  }

  if (approved === undefined && result) {
    if (/permission granted/i.test(result.text)) approved = true;
    else if (/permission denied/i.test(result.text)) approved = false;
  }

  const isApproved = approved === true;
  const shortId = requestId ? `@${requestId.slice(-4)}` : '';

  if (isApproved) {
    return {
      label: truncateToWidth(`已批准 ${shortId}`.trim(), maxWidth),
      // Approved but the request was gone (not found / already resolved).
      detail: result?.isError ? truncateToWidth(collapseWhitespace(result.text), maxWidth) : '',
      state: 'approved',
    };
  }

  const detailParts: string[] = [];
  if (approved === undefined) {
    // Neither arguments nor result could be parsed — keep the raw call visible.
    detailParts.push(`原始参数: ${tc.arguments.slice(0, UNKNOWN_ARGS_PREFIX)}`);
  }
  if (result?.isError) {
    detailParts.push(collapseWhitespace(result.text));
  }
  return {
    label: truncateToWidth(`已拒绝 ${shortId}${reason ? ` 原因: ${reason}` : ''}`.replace(/\s+/g, ' '), maxWidth),
    detail: truncateToWidth(detailParts.join(' '), maxWidth),
    state: 'denied',
  };
}
