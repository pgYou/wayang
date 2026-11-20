// Input box — one row per visual line so newlines pasted into the value render
// as real lines and the cursor block stays on its line.

import { Box, Text } from 'ink';
import { theme } from '@/tui/theme';
import { stringWidth } from '@/tui/utils/text-width';
import { nextCodePointLength, splitLineBySelection } from '@/tui/utils/input-display';
import type { InputLayout } from '@/tui/utils/input-display';
import type { SelectionRange } from '@/tui/utils/input-editing';

/** Prompt prefix and the gutter that keeps wrapped rows aligned under it. */
const PREFIX = `${theme.user.prefix} `;
export const PREFIX_WIDTH = stringWidth(PREFIX);

interface InputBoxProps {
  layout: InputLayout;
  sel: SelectionRange;
  /** A visible (non-newline-only) selection: highlight instead of the cursor block. */
  visibleSelection: boolean;
  busy?: boolean;
}

export function InputBox({ layout, sel, visibleSelection, busy }: InputBoxProps) {
  return (
    <Box
      borderStyle="single"
      borderColor="gray"
      borderLeft={false}
      borderRight={false}
      paddingX={1}
    >
      <Box flexDirection="column">
        {layout.lines.map((line, i) => {
          const isCursorLine = i === layout.cursorLine;
          // Render the cursor block on the char at the cursor; a cursor
          // past the line's end (end of value, or on the line's newline)
          // renders as a trailing inverse space.
          const col = layout.cursorCol;
          const charLen = isCursorLine ? nextCodePointLength(line.text, col) : 0;
          const before = isCursorLine ? line.text.slice(0, col) : line.text;
          const cursorCell = isCursorLine && charLen > 0
            ? line.text.slice(col, col + charLen)
            : ' ';
          const after = isCursorLine ? line.text.slice(col + charLen) : '';
          return (
            <Box key={i}>
              {i === 0 ? (
                <Text color={theme.user.prefixColor} bold>{theme.user.prefix}</Text>
              ) : (
                <Text>{' '.repeat(PREFIX_WIDTH)}</Text>
              )}
              {/* The selection highlight and the cursor block are mutually
                  exclusive: with a selection the active end is the visual
                  focus, so the block is not drawn (no double inverse). A
                  selection that only covers newlines has nothing to
                  highlight, so it is treated as invisible here and keeps
                  the cursor block on screen. */}
              {visibleSelection ? (
                <>
                  {i === 0 && <Text> </Text>}
                  {splitLineBySelection(line, sel).map((seg, j) => (
                    <Text key={j} inverse={seg.selected}>{seg.text}</Text>
                  ))}
                </>
              ) : (
                <>
                  <Text>{i === 0 ? ` ${before}` : before}</Text>
                  {isCursorLine && (
                    <Text color="white" inverse>{cursorCell}</Text>
                  )}
                  <Text>{after}</Text>
                </>
              )}
              {isCursorLine && busy && <Text dimColor> (thinking...)</Text>}
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
