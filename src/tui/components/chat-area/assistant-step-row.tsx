import { Box, Text } from 'ink';
import type { DisplayItem, DisplaySection } from '@/tui/types/display-item';
import { theme } from '@/tui/theme';
import { summarizePermissionResolution } from '@/tui/utils/permission-summary';
import { summarizeAddTask, summarizeWorkerMessage, type ActionOutcome } from '@/tui/utils/controller-action-summary';
import { EMPTY_CHAT_LOOKUPS, formatWorkerTag, type ChatLookups } from '@/tui/utils/chat-lookups';
import { TOOL_DETAIL_MAX_LENGTH, LONG_MSG_MAX_LENGTH } from './constants';

/**
 * Tool calls rendered by a dedicated summary row. Their paired tool result is
 * folded into that row (approved / delivered / dispatched, or an error line),
 * so the generic "← tool: result" line is not shown for them.
 */
const SUMMARIZED_TOOLS = new Set(['respond_permission', 'chat_worker', 'add_task']);

/** Width available to secondary lines (indented under the row text). */
const SECONDARY_WIDTH = TOOL_DETAIL_MAX_LENGTH - theme.secondary.indent;

/**
 * Width available to a summary header after its fixed lead-in ("· ✔ " —
 * meta dot, space, status icon, space). Keeps the whole header within
 * TOOL_DETAIL_MAX_LENGTH instead of overflowing by the prefix width.
 */
const HEADER_WIDTH = TOOL_DETAIL_MAX_LENGTH - 4;

/** Render an assistant step with all its sections (content, reasoning, tool calls/results). */
export function AssistantStepRow({ item, lookups = EMPTY_CHAT_LOOKUPS }: { item: DisplayItem; lookups?: ChatLookups }) {
  const sections = item.sections ?? [];

  // No sections — fallback to simple text row. A whitespace-only step (no
  // text, no tool calls) renders nothing rather than a bare prefix.
  if (sections.length === 0) {
    if (!item.content?.trim()) return null;
    return (
      <Box>
        <Text color={theme.assistant.prefixColor} bold>
          {theme.assistant.prefix}{' '}
        </Text>
        <Text>{item.content}</Text>
      </Box>
    );
  }

  // Pair tool results by toolCallId — summary rows fold the paired result in.
  const resultSections = new Map<string, DisplaySection>();
  const summarizedCallIds = new Set<string>();
  for (const sec of sections) {
    if (sec.kind === 'tool_result') resultSections.set(sec.id, sec);
    if (sec.kind === 'tool_call' && sec.toolName && SUMMARIZED_TOOLS.has(sec.toolName)) {
      summarizedCallIds.add(sec.id);
    }
  }

  return (
    <Box flexDirection="column">
      {sections.map((sec) => {
        const key = `${sec.kind}-${sec.id}`;
        switch (sec.kind) {
          case 'reasoning':
            return <ReasoningRow key={key} section={sec} />;
          case 'content':
            return <ContentRow key={key} section={sec} />;
          case 'tool_call': {
            const result = resultSections.get(sec.id);
            switch (sec.toolName) {
              case 'respond_permission':
                return <PermissionResolutionRow key={key} section={sec} result={result} lookups={lookups} />;
              case 'chat_worker':
                return <WorkerMessageRow key={key} section={sec} result={result} lookups={lookups} />;
              case 'add_task':
                return <AddTaskRow key={key} section={sec} result={result} lookups={lookups} />;
              default:
                return <ToolCallRow key={key} section={sec} />;
            }
          }
          case 'tool_result':
            return summarizedCallIds.has(sec.id) ? null : <ToolResultRow key={key} section={sec} />;
        }
      })}
    </Box>
  );
}

/** Reasoning / extended thinking section. */
function ReasoningRow({ section }: { section: DisplaySection }) {
  return (
    <Box>
      <Text color={theme.meta.color}>{theme.meta.prefix} </Text>
      <Text dimColor>thinking: {section.text.slice(0, LONG_MSG_MAX_LENGTH)}</Text>
    </Box>
  );
}

/** Main text content section. */
function ContentRow({ section }: { section: DisplaySection }) {
  return (
    <Box>
      <Text color={theme.assistant.prefixColor} bold>
        {theme.assistant.prefix}{' '}
      </Text>
      <Text>{section.text}</Text>
    </Box>
  );
}

/** Tool call section. */
function ToolCallRow({ section }: { section: DisplaySection }) {
  return (
    <Box>
      <Text color={theme.meta.color}>{theme.meta.prefix} </Text>
      <Text color={theme.toolUse.color}>
        {theme.toolUse.callIcon} {section.toolName}: {section.text.slice(0, TOOL_DETAIL_MAX_LENGTH)}
      </Text>
    </Box>
  );
}

/** Tool result section. */
function ToolResultRow({ section }: { section: DisplaySection }) {
  const color = section.isError ? theme.baseToken.color.error : theme.toolUse.color;

  return (
    <Box>
      <Text color={theme.meta.color}>{theme.meta.prefix} </Text>
      <Text color={color}>
        {theme.toolUse.resultIcon} {section.toolName}: {section.text.slice(0, TOOL_DETAIL_MAX_LENGTH)}
      </Text>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Summary rows — shared pieces
// ---------------------------------------------------------------------------

/** Secondary line, indented under the row text. */
function SecondaryLine({ children, color, dim = false }: { children: string; color?: string; dim?: boolean }) {
  return (
    <Box marginLeft={theme.secondary.indent}>
      <Text color={color ?? theme.secondary.color} dimColor={dim}>{children}</Text>
    </Box>
  );
}

/** Trailing outcome mark on a header line: "✔ <ok>" / "✘ <failed>"; nothing while pending. */
function OutcomeMark({ outcome, ok, failed }: { outcome: ActionOutcome; ok: string; failed: string }) {
  if (outcome === 'pending') return null;
  const isOk = outcome === 'ok';
  return (
    <Text color={isOk ? theme.action.okColor : theme.action.failColor}>
      {'  '}{isOk ? theme.action.okMark : theme.action.failMark} {isOk ? ok : failed}
    </Text>
  );
}

/** Preview lines plus a "… 另 N 行" note when lines were left out. */
function PreviewLines({ lines, hidden }: { lines: string[]; hidden: number }) {
  return (
    <>
      {lines.map((line, i) => <SecondaryLine key={i}>{line}</SecondaryLine>)}
      {hidden > 0 && <SecondaryLine dim>{`… 另 ${hidden} 行`}</SecondaryLine>}
    </>
  );
}

// ---------------------------------------------------------------------------
// respond_permission
// ---------------------------------------------------------------------------

/**
 * respond_permission tool call — "✔ 已批准 bash <command> #7xvt".
 * The original request is looked up by requestId so the row says what was
 * approved; the worker that asked goes on a secondary line.
 */
function PermissionResolutionRow({ section, result, lookups }: {
  section: DisplaySection;
  result?: DisplaySection;
  lookups: ChatLookups;
}) {
  let requestId: string | undefined;
  try {
    const parsed = JSON.parse(section.text) as { requestId?: unknown };
    if (typeof parsed.requestId === 'string') requestId = parsed.requestId;
  } catch {
    // Unparseable — the summary keeps the raw arguments visible.
  }
  const request = requestId ? lookups.permissionRequests.get(requestId) : undefined;

  const summary = summarizePermissionResolution(
    {
      toolCallId: section.id,
      toolName: section.toolName ?? 'respond_permission',
      arguments: section.text,
    },
    HEADER_WIDTH,
    result ? { text: result.text, isError: result.isError } : undefined,
    request?.meta,
  );
  const look = {
    approved: { color: theme.permission.approvedColor, icon: theme.permission.approvedPrefix, verb: '已批准' },
    denied: { color: theme.permission.deniedColor, icon: theme.permission.deniedPrefix, verb: '已拒绝' },
    unknown: { color: theme.permission.unknownColor, icon: theme.permission.unknownPrefix, verb: '结果未知' },
    pending: { color: theme.permission.pendingColor, icon: theme.permission.pendingPrefix, verb: '待审批' },
  }[summary.state];
  const { color, icon } = look;
  const workerTag = request?.worker ? formatWorkerTag(request.worker) : '';

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={theme.meta.color}>{theme.meta.prefix} </Text>
        <Text color={color} bold>{icon} {look.verb}</Text>
        {summary.toolName && <Text bold> {summary.toolName}</Text>}
        {summary.target && <Text> {summary.target}</Text>}
        {summary.requestShortId && <Text color={theme.secondary.color}> #{summary.requestShortId}</Text>}
      </Box>
      {workerTag && <SecondaryLine>{workerTag}</SecondaryLine>}
      {summary.reason && <SecondaryLine color={color}>{`原因: ${summary.reason}`}</SecondaryLine>}
      {summary.detail && <SecondaryLine color={theme.baseToken.color.error}>{summary.detail}</SecondaryLine>}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// chat_worker
// ---------------------------------------------------------------------------

/**
 * chat_worker tool call — "✉ 发送给 🧸 <task> · w:rr4f  ✔ 已送达", with the
 * message previewed on the following lines.
 */
function WorkerMessageRow({ section, result, lookups }: {
  section: DisplaySection;
  result?: DisplaySection;
  lookups: ChatLookups;
}) {
  const summary = summarizeWorkerMessage(
    section.text,
    SECONDARY_WIDTH,
    result ? { text: result.text, isError: result.isError } : undefined,
  );
  const worker = summary.workerId ? lookups.workers.get(summary.workerId) : undefined;
  const target = formatWorkerTag(worker ?? { workerId: summary.workerId }) || '(未知 worker)';
  const iconColor = summary.outcome === 'failed' ? theme.action.failColor : theme.action.color;

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={theme.meta.color}>{theme.meta.prefix} </Text>
        <Text color={iconColor} bold>{theme.action.messageIcon} 发送给</Text>
        <Text> {target}</Text>
        <OutcomeMark outcome={summary.outcome} ok="已送达" failed="未送达" />
      </Box>
      <PreviewLines lines={summary.lines} hidden={summary.hiddenLines} />
      {summary.failure && <SecondaryLine color={theme.action.failColor}>{summary.failure}</SecondaryLine>}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// add_task
// ---------------------------------------------------------------------------

/**
 * add_task tool call — "▶ 派发任务 <title> #32ra", then worker type / flags
 * and a short description preview. Reuse of an idle worker shows "↻ 续派任务".
 */
function AddTaskRow({ section, result, lookups }: {
  section: DisplaySection;
  result?: DisplaySection;
  lookups: ChatLookups;
}) {
  const summary = summarizeAddTask(
    section.text,
    SECONDARY_WIDTH,
    result ? { text: result.text, isError: result.isError } : undefined,
  );
  const reuse = summary.assignToWorker !== undefined;
  const iconColor = summary.outcome === 'failed' ? theme.action.failColor : theme.action.color;

  // Secondary meta line: who runs it + flags.
  const reusedWorker = reuse ? lookups.workers.get(summary.assignToWorker!) : undefined;
  const runner = reuse
    ? `${formatWorkerTag(reusedWorker ?? { workerId: summary.assignToWorker })} (复用上下文)`
    : [lookups.workerTypeEmoji.get(summary.workerType), summary.workerType].filter(Boolean).join(' ');
  const flags = [
    summary.priority === 'high' ? '高优先' : '',
    summary.multiStage ? '多阶段' : '',
  ].filter(Boolean);
  const metaLine = [runner, ...flags].join(' · ');

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={theme.meta.color}>{theme.meta.prefix} </Text>
        <Text color={iconColor} bold>
          {reuse ? theme.action.reuseIcon : theme.action.dispatchIcon} {reuse ? '续派任务' : '派发任务'}
        </Text>
        <Text bold> {summary.title}</Text>
        {summary.taskShortId && <Text color={theme.secondary.color}> #{summary.taskShortId}</Text>}
        <OutcomeMark outcome={summary.outcome} ok="已派发" failed="派发失败" />
      </Box>
      <SecondaryLine>{metaLine}</SecondaryLine>
      <PreviewLines lines={summary.lines} hidden={summary.hiddenLines} />
      {summary.failure && <SecondaryLine color={theme.action.failColor}>{summary.failure}</SecondaryLine>}
    </Box>
  );
}
