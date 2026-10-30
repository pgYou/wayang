import { Box, Text } from 'ink';
import type { DisplayItem } from '@/tui/types/display-item';
import { theme } from '@/tui/theme';
import { ESystemSubtype } from '@/types/conversation';

/**
 * Structural discrimination for compaction markers: a system entry is only a
 * compact marker if it carries compactMeta. Legacy subtype='compact' records
 * without it (e.g. old ClaudeCodeWorker success entries) are plain content
 * and must not render as "compacted".
 */
export function isCompactSystemItem(item: Pick<DisplayItem, 'subtype' | 'compactMeta'>): boolean {
  return item.subtype === ESystemSubtype.Compact && item.compactMeta !== undefined;
}

/** System entry: gray dot prefix, red for errors, triple tilde for compact. */
export function SystemRow({ item }: { item: DisplayItem }) {
  const isError = item.subtype === ESystemSubtype.Error;
  const isCompact = isCompactSystemItem(item);
  const isTaskResult = item.subtype === ESystemSubtype.TaskResult;

  if (isCompact) {
    return (
      <Box>
        <Text dimColor>≋ Conversation has been compacted</Text>
      </Box>
    );
  }

  // Third-party worker terminal result — show the content directly in
  // secondary text so the row is never blank.
  if (isTaskResult) {
    return (
      <Box>
        <Text dimColor>{item.content}</Text>
      </Box>
    );
  }

  return (
    <Box>
      <Text color={isError ? theme.baseToken.color.error : theme.meta.color}>
        {isError ? '✘' : theme.meta.prefix}{' '}
      </Text>
      <Text color={isError ? theme.baseToken.color.error : undefined} dimColor={!isError}>
        {item.content}
      </Text>
    </Box>
  );
}
