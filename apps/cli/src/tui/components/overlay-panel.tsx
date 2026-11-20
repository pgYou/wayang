import { Box, Text } from 'ink';
import type { Overlay } from '@/tui/types/overlay';

/**
 * Renders an Overlay — text box or custom component — with optional bottom hint.
 *
 * Text content renders as one Text node per line instead of a single block: a
 * giant multi-line Text made Ink re-layout the whole panel on every commit
 * (issue #49's "single Text block" defect), while per-line nodes keep each row
 * an independent layout unit. `wrap="truncate"` hard-clips a line at the box
 * width instead of wrapping it, so a row that somehow exceeds the formatters'
 * column budget still cannot grow the panel vertically.
 */
export function OverlayPanel({ overlay }: { overlay: Overlay }) {
  return (
    <Box flexDirection="column" marginTop={1}>
      {overlay.kind === 'text' ? (
        <Box paddingX={1} borderStyle="single" borderColor="gray" flexDirection="column">
          {overlay.content.split('\n').map((line, index) => (
            // Empty lines keep their row via a single space — an empty Text
            // renders zero-height and would collapse the blank line.
            <Text key={index} color="gray" wrap="truncate">{line || ' '}</Text>
          ))}
        </Box>
      ) : (
        overlay.render()
      )}
      {overlay.hint && <Text dimColor>{'  '}{overlay.hint}</Text>}
    </Box>
  );
}
