import { Box, Text } from 'ink';
import type { Overlay } from '@/tui/types/overlay';

/** Renders an Overlay — text box or custom component — with optional bottom hint. */
export function OverlayPanel({ overlay }: { overlay: Overlay }) {
  return (
    <Box flexDirection="column" marginTop={1}>
      {overlay.kind === 'text' ? (
        <Box paddingX={1} borderStyle="single" borderColor="gray" flexDirection="column">
          <Text color="gray">{overlay.content}</Text>
        </Box>
      ) : (
        overlay.render()
      )}
      {overlay.hint && <Text dimColor>{'  '}{overlay.hint}</Text>}
    </Box>
  );
}
