import { Box, Text } from 'ink';
import type { DisplayItem } from '@/tui/types/display-item';
import { theme } from '@/tui/theme';
import { stringWidth } from '@/tui/utils/text-width';

/** Prefix rendered ahead of the message, painted with the row background. */
const PREFIX = `${theme.user.prefix} `;

/** Columns the prefix consumes out of the row budget. */
const PREFIX_WIDTH = stringWidth(PREFIX);

/**
 * Pad one message line so the background fill reaches the end of the row.
 *
 * Width is measured in terminal columns (`stringWidth`), not UTF-16 length: a
 * CJK glyph is one code unit but two columns, so padding on `line.length`
 * overshoots the budget and makes Ink wrap the trailing fill onto an extra,
 * fully painted line. Lines that already reach the budget get no padding.
 */
function fillRow(line: string, width: number): string {
  const fill = width - stringWidth(line);
  return fill > 0 ? line + ' '.repeat(fill) : line;
}

/**
 * User message: `>` prefix with a gray background band over the content width.
 *
 * `width` is the budget for the whole row (prefix + message + trailing fill).
 * The prefix shares it rather than being added on top: padding the message to
 * the full `width` and then prepending the prefix would push the row past the
 * content area, and Ink would wrap the leftover fill into a stray line of
 * solid background. A message wider than the remaining budget is left
 * unpadded and wraps inside the row, which the explicit `width` bounds.
 *
 * The fill is made of spaces inside a <Text> because Ink 4 only paints
 * `backgroundColor` on text nodes: a `<Box backgroundColor>` renders no
 * background at all (verified against ink 4.4.1), so `<Box width="100%">
 * backgroundColor` alone cannot draw the band.
 */
export function UserRow({ item, width }: { item: DisplayItem; width: number }) {
  const dim = !item.read;
  const rowWidth = Math.max(0, width);
  const textWidth = Math.max(0, rowWidth - PREFIX_WIDTH);
  const body = item.content
    .split('\n')
    .map(line => (stringWidth(line) <= textWidth ? fillRow(line, textWidth) : line))
    .join('\n');

  return (
    <Box width={rowWidth > 0 ? rowWidth : undefined}>
      <Text
        backgroundColor={theme.user.bgHex}
        color={theme.user.prefixColor}
        bold
      >
        {PREFIX}
      </Text>
      <Text
        backgroundColor={theme.user.bgHex}
        color={dim ? theme.baseToken.color.textSubtle : theme.baseToken.color.textNormal}
      >
        {body}
      </Text>
    </Box>
  );
}
