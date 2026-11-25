import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '@/tui/theme';

/** Compact 3-line welcome screen with puppet logo. */
export function Welcome({ workspace }: { workspace: string }) {


  return (
    <Box flexDirection="column" paddingX={1} marginTop={1}>
      <Box>
        <Text color={theme.baseToken.color.accent} bold>
          {' ╭●◡●╮   '}
        </Text>

      </Box>
      <Box>
        <Text color={theme.baseToken.color.accent} bold>
          {' ╰─┬─╯   '}
        </Text>
        <Text>Welcome to play with{' '}</Text>
        <Text color={theme.baseToken.color.textEmphasis}>
          Wayang
        </Text>
      </Box>
      <Box>
        <Text color={theme.baseToken.color.accent} bold>
          {'  ╱ ╲    '}
        </Text>
        <Text dimColor>{workspace}</Text>
      </Box>
      <Text>{'\n\n\n'}</Text>
    </Box>
  );
}
