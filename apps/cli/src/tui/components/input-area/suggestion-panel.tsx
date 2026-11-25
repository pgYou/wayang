// The '/' command suggestion panel, rendered above the input box.

import { Box, Text } from 'ink';
import { theme } from '@/tui/theme';
import type { SLASH_COMMANDS } from '@/tui/hooks/use-slash-commands';

/** One entry of the slash-command suggestion list (an element of `SLASH_COMMANDS`). */
export type SlashCommandSuggestion = (typeof SLASH_COMMANDS)[number];

interface SuggestionPanelProps {
  suggestions: SlashCommandSuggestion[];
  /** Highlighted suggestion (already clamped to the list length). */
  clampedIndex: number;
}

export function SuggestionPanel({ suggestions, clampedIndex }: SuggestionPanelProps) {
  return (
    <Box flexDirection="column" paddingX={1} marginBottom={0}>
      {suggestions.map((cmd, i) => {
        const isSelected = i === clampedIndex;
        const nameWithArgs = 'args' in cmd ? `/${cmd.name} ${cmd.args}` : `/${cmd.name}`;
        return (
          <Box key={cmd.name}>
            <Text color={isSelected ? theme.baseToken.color.accent : undefined}>
              {isSelected ? '▸ ' : '  '}
            </Text>
            <Text bold={isSelected} color={isSelected ? theme.baseToken.color.accent : theme.baseToken.color.textNormal}>
              {nameWithArgs.padEnd(20)}
            </Text>
            <Text dimColor> {cmd.description}</Text>
          </Box>
        );
      })}
    </Box>
  );
}
