import { Box, Text } from 'ink';
import type { DisplayItem } from '@/tui/types/display-item';
import { theme } from '@/tui/theme';

/** User message: `>` prefix with full-width gray background. */
export function UserRow({ item, width }: { item: DisplayItem; width: number }) {
  const dim = !item.read;
  const text = item.content;
  // Fill the row with the gray background without ever exceeding `width`:
  // padding past it pushes the row wider than the declared content width and
  // makes Ink wrap the trailing padding onto an extra line.
  const padded = text.length < width ? text.padEnd(width) : text;

  return (
    <Box>
      <Text
        backgroundColor={theme.user.bgHex}
        color={theme.user.prefixColor}
        bold
      >
        {theme.user.prefix}{' '}
      </Text>
      <Text
        backgroundColor={theme.user.bgHex}
        color={dim ? theme.baseToken.color.textSubtle : theme.baseToken.color.textNormal}
      >
        {padded}
      </Text>
    </Box>
  );
}
