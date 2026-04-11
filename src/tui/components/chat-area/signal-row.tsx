import { Box, Text } from 'ink';
import type { DisplayItem } from '@/tui/types/display-item';
import { theme } from '@/tui/theme';

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
  const dim = !item.read;
  const label = item.subtype?.replace('worker_', '') ?? 'signal';
  const color = dim ? theme.baseToken.color.textSubtle : theme.signal.color;

  // Build context tag: emoji + task title and short worker ID
  const contextParts: string[] = [];
  if (item.taskTitle) contextParts.push(item.taskTitle);
  if (item.workerId) contextParts.push(`w:${item.workerId.slice(-4)}`);
  const context = contextParts.length > 0 ? `[${contextParts.join(' · ')}] ` : '';

  const content = trimContent(item.content, MAX_CONTENT_LINES);

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
