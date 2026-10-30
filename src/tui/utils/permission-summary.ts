/**
 * Human-readable summaries for permission request / resolution rows.
 *
 * Permission requests arrive as `permission_request` signal entries carrying
 * `permissionMeta` (tool name + args); resolutions are the controller's
 * `respond_permission` tool calls. Both are rendered as one informative line
 * (plus optional secondary lines) instead of flattened text or raw JSON. The
 * raw JSON stays in the conversation entries — these summaries are a display
 * layer only.
 *
 * Summaries expose structured parts (tool name, target, short request id) so
 * rows can style each part separately; `label` remains as a plain-text
 * fallback of the whole line.
 */
import type { PermissionRequestMeta, ToolCallRecord } from '@/types/conversation';
import {
  collapseWhitespace,
  fitWithSuffix,
  shortId,
  stringWidth,
  truncateToWidth,
} from './text-width';

/** Lifecycle of a permission flow item. */
export type PermissionSummaryState = 'pending' | 'approved' | 'denied';

/** Summary of one permission request / resolution row. */
export interface PermissionSummary {
  /** Plain-text one-line summary (no status icon — the theme supplies it). */
  label: string;
  /** Optional secondary line with extra context (description / error). */
  detail: string;
  state: PermissionSummaryState;
  /** Tool the request is about — absent when unknown (unmatched resolution). */
  toolName?: string;
  /** Per-tool target fragment (command head, path, …) — empty when none. */
  target: string;
  /** Short handle of the request id (last 4 chars), shown as "#xxxx". */
  requestShortId?: string;
  /** Denial reason given by the controller (resolution only). */
  reason?: string;
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

/** Build the per-tool target fragment (command head, path, …). */
export function toolTarget(toolName: string, args: Record<string, unknown>, budget: number): string {
  if (budget < 1) return '';
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

/** Normalize request args to a plain object. */
function requestArgs(meta: PermissionRequestMeta): Record<string, unknown> {
  return (meta.toolArgs && typeof meta.toolArgs === 'object' && !Array.isArray(meta.toolArgs))
    ? meta.toolArgs
    : {};
}

/** "(resolved: /abs/path)" suffix written by the engine's file-tool describer. */
const RESOLVED_PATH_RE = /^\S+: (.*) \(resolved: (.*)\)$/s;

/**
 * Extract the part of a request description that adds information beyond the
 * tool args. The engine/workers generate mechanical descriptions:
 * - bash: "Execute shell command: <command>" — pure restatement, dropped
 * - file tools: "<tool>: <path> (resolved: <abs>)" — only the resolved path
 *   is new, and only when it differs from the raw path (it explains why the
 *   request was raised: the path resolves outside the workspace)
 * Any other description is kept as-is (collapsed to one line).
 */
export function meaningfulDescription(description: string | undefined): string {
  if (!description) return '';
  const text = description.trim();
  if (/^execute shell command:/i.test(text)) return '';
  const m = RESOLVED_PATH_RE.exec(text);
  if (m) {
    const [, rawPath, resolved] = m;
    return resolved && resolved !== rawPath ? `解析为 ${resolved}` : '';
  }
  return collapseWhitespace(text);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Summarize a pending permission request for one-line display. */
export function summarizePermissionRequest(meta: PermissionRequestMeta, maxWidth: number): PermissionSummary {
  const prefix = `权限申请 ${meta.toolName}`;
  // Budget left for the per-tool fragment after the prefix and its space.
  const budget = maxWidth - stringWidth(prefix) - 1;
  const target = budget >= 1 ? toolTarget(meta.toolName, requestArgs(meta), budget) : '';
  const label = truncateToWidth(target ? `${prefix} ${target}` : prefix, maxWidth);
  const detail = truncateToWidth(meaningfulDescription(meta.description), maxWidth);
  return {
    label,
    detail,
    state: 'pending',
    toolName: meta.toolName,
    target,
    ...(meta.requestId && { requestShortId: shortId(meta.requestId) }),
  };
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
 *
 * `request` is the original request (looked up by requestId) — when given,
 * the summary carries its tool name and target so the row can say WHAT was
 * approved instead of only an id.
 */
export function summarizePermissionResolution(
  tc: ToolCallRecord,
  maxWidth: number,
  result?: PermissionResolutionResult,
  request?: PermissionRequestMeta,
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
  const requestShortId = requestId ? shortId(requestId) : undefined;
  const idTag = requestShortId ? `#${requestShortId}` : '';
  const verb = isApproved ? '已批准' : '已拒绝';

  // Target of the original request, fitted after "<verb> <tool> " and " #xxxx".
  let toolName: string | undefined;
  let target = '';
  if (request) {
    toolName = request.toolName;
    const reserved = stringWidth(`${verb} ${toolName}  ${idTag}`);
    target = toolTarget(toolName, requestArgs(request), maxWidth - reserved);
  }

  const detailParts: string[] = [];
  if (approved === undefined) {
    // Neither arguments nor result could be parsed — keep the raw call visible.
    detailParts.push(`原始参数: ${tc.arguments.slice(0, UNKNOWN_ARGS_PREFIX)}`);
  }
  if (result?.isError) {
    // The resolution did not take effect (not found / already resolved).
    detailParts.push(collapseWhitespace(result.text));
  }

  const labelParts = [verb, toolName, target, idTag].filter(Boolean).join(' ');
  return {
    label: truncateToWidth(
      `${labelParts}${!isApproved && reason ? ` 原因: ${reason}` : ''}`.replace(/\s+/g, ' '),
      maxWidth,
    ),
    detail: truncateToWidth(detailParts.join(' '), maxWidth),
    state: isApproved ? 'approved' : 'denied',
    target,
    ...(toolName && { toolName }),
    ...(requestShortId && { requestShortId }),
    ...(!isApproved && reason && { reason: truncateToWidth(collapseWhitespace(reason), maxWidth) }),
  };
}
