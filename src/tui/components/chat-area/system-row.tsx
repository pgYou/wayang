import { Box, Text } from 'ink';
import type { DisplayItem } from '@/tui/types/display-item';
import { theme } from '@/tui/theme';

/** System entry: gray dot prefix, red for errors, triple tilde for compact. */
export function SystemRow({ item }: { item: DisplayItem }) {
  const isError = item.subtype === 'error';
  const isCompact = item.subtype === 'compact';

  if (isCompact) {
    return (
      <Box>
        <Text dimColor>≋ Conversation has been compacted</Text>
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
