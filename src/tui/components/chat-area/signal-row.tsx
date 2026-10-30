import { Box, Text } from 'ink';
import type { DisplayItem } from '@/tui/types/display-item';
import { ESignalSubtype } from '@/types/conversation';
import { theme } from '@/tui/theme';
import { summarizePermissionRequest } from '@/tui/utils/permission-summary';
import { LONG_MSG_MAX_LENGTH } from './constants';

/** Max lines to show for signal content. */
const MAX_CONTENT_LINES = 2;

/** Trim content to max lines, collapse blank lines. */
function trimContent(text: string, maxLines: number): string {
  const lines = text.split('\n').map(l => l.trimEnd()).filter(l => l.length > 0);
  const trimmed = lines.slice(0, maxLines).join('\n');
  return lines.length > maxLines ? trimmed + '...' : trimmed;
}

/** Signal entry: flag prefix with task/worker context. */
export function SignalRow({ item }: { item: DisplayItem }) {
  // Permission requests with structured meta get a per-tool summary row;
  // legacy entries (no meta) fall back to the default content display.
  if (item.subtype === ESignalSubtype.PermissionRequest && item.permissionMeta) {
    return <PermissionRequestRow item={item} />;
  }
  return <DefaultSignalRow item={item} />;
}

/** Default signal rendering: flag prefix with task/worker context. */
function DefaultSignalRow({ item }: { item: DisplayItem }) {
  const dim = !item.read;
  const label = item.subtype?.replace('worker_', '') ?? 'signal';
  const color = dim ? theme.baseToken.color.textSubtle : theme.signal.color;

  // Build context tag: emoji + task title and short worker ID
  const contextParts: string[] = [];
  if (item.taskTitle) contextParts.push(item.taskTitle);
  if (item.workerId) contextParts.push(`w:${item.workerId.slice(-4)}`);
  const context = contextParts.length > 0 ? `[${contextParts.join(' · ')}] ` : '';

  const content = item.subtype === ESignalSubtype.Heartbeat
    ? ''
    : trimContent(item.content, MAX_CONTENT_LINES);

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={theme.meta.color}>{theme.signal.prefix} </Text>
        {item.emoji && <Text>{item.emoji} </Text>}
        <Text dimColor={dim} color={color}>
          {context}{label}
        </Text>
      </Box>
      {content && (
        <Box marginLeft={3}>
          <Text dimColor={dim} color={color}>{content}</Text>
        </Box>
      )}
    </Box>
  );
}

/** Permission request: pending marker + per-tool summary, description indented. */
function PermissionRequestRow({ item }: { item: DisplayItem }) {
  const dim = !item.read;
  const color = dim ? theme.baseToken.color.textSubtle : theme.permission.pendingColor;
  const summary = summarizePermissionRequest(item.permissionMeta!, LONG_MSG_MAX_LENGTH);

  // Same context tag as default signal rows: task title + short worker ID.
  const contextParts: string[] = [];
  if (item.taskTitle) contextParts.push(item.taskTitle);
  if (item.workerId) contextParts.push(`w:${item.workerId.slice(-4)}`);
  const context = contextParts.length > 0 ? `[${contextParts.join(' · ')}] ` : '';

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={color}>{theme.permission.pendingPrefix} </Text>
        {item.emoji && <Text>{item.emoji} </Text>}
        <Text dimColor={dim} color={color}>
          {context}{summary.label}
        </Text>
      </Box>
      {summary.detail && (
        <Box marginLeft={3}>
          <Text dimColor={dim} color={color}>{summary.detail}</Text>
        </Box>
      )}
    </Box>
  );
}
