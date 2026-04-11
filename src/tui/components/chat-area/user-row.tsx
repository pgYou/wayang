import { Box, Text } from 'ink';
import type { DisplayItem } from '@/tui/types/display-item';
import { theme } from '@/tui/theme';

/** User message: `>` prefix with full-width gray background. */
export function UserRow({ item, width }: { item: DisplayItem; width: number }) {
  const dim = !item.read;
  const text = item.content;
  const padded = text.length < width ? text + ' '.repeat(4) : text;

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
