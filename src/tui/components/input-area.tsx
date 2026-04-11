import React, { useState, useMemo } from 'react';
import { useMemoizedFn } from '@/tui/hooks/use-memoized-fn';
import { SLASH_COMMANDS } from '@/tui/hooks/use-slash-commands';
import { Box, Text, useInput } from 'ink';
import { theme } from '@/tui/theme';

interface InputAreaProps {
  onSubmit: (input: string) => void;
  onExit: () => void;
  onEscape?: () => void;
  busy?: boolean;
}

export function InputArea({ onSubmit, onExit, onEscape, busy }: InputAreaProps) {
  const [input, setInput] = useState('');
  const [cursor, setCursor] = useState(0);
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Filter matching commands when input starts with "/" and has no space yet
  const suggestions = useMemo(() => {
    if (!input.startsWith('/') || input.includes(' ')) return [];
    const typed = input.slice(1).toLowerCase();
    return SLASH_COMMANDS.filter(c => c.name.startsWith(typed));
  }, [input]);

  const showSuggestions = suggestions.length > 0;

  // Clamp selectedIndex when suggestions change
  const clampedIndex = showSuggestions
    ? Math.min(selectedIndex, suggestions.length - 1)
    : 0;

  const reset = useMemoizedFn(() => {
    setInput('');
    setCursor(0);
    setSelectedIndex(0);
  });

  const applySuggestion = useMemoizedFn((index: number) => {
    const cmd = suggestions[index];
    if (!cmd) return;
    const text = `/${cmd.name}`;
    // Append trailing space if the command accepts args
    const filled = 'args' in cmd ? `${text} ` : text;
    setInput(filled);
    setCursor(filled.length);
    setSelectedIndex(0);
  });

  useInput((ch, key) => {
    // --- Enter ---
    if (key.return) {
      // If suggestions are visible and user only typed the command prefix (no args),
      // apply the highlighted suggestion then submit
      if (showSuggestions) {
        const cmd = suggestions[clampedIndex];
        if (cmd) {
          // If the command requires args, just autocomplete without submitting
          if ('args' in cmd) {
            applySuggestion(clampedIndex);
            return;
          }
          // No args needed — submit directly
          const text = `/${cmd.name}`;
          if (text === '/exit' || text === '/quit') {
            onExit();
            return;
          }
          onSubmit(text);
          reset();
          return;
        }
      }

      const trimmed = input.trim();
      if (!trimmed) return;
      if (trimmed === '/exit' || trimmed === '/quit') {
        onExit();
        return;
      }
      onSubmit(trimmed);
      reset();
      return;
    }

    // --- Tab: autocomplete ---
    if (key.tab) {
      if (showSuggestions) {
        applySuggestion(clampedIndex);
      }
      return;
    }

    // --- Up/Down arrow: navigate suggestions or move cursor ---
    if (key.upArrow) {
      if (showSuggestions) {
        setSelectedIndex(i => (i - 1 + suggestions.length) % suggestions.length);
      }
      return;
    }
    if (key.downArrow) {
      if (showSuggestions) {
        setSelectedIndex(i => (i + 1) % suggestions.length);
      }
      return;
    }

    // --- Escape ---
    if (key.escape) {
      if (showSuggestions) {
        // Close suggestions by clearing slash prefix
        setInput('');
        setCursor(0);
        setSelectedIndex(0);
      } else {
        onEscape?.();
        reset();
      }
      return;
    }

    // --- Backspace / Delete ---
    if (key.backspace || key.delete) {
      if (cursor === 0) return;
      setInput(prev => prev.slice(0, cursor - 1) + prev.slice(cursor));
      setCursor(c => Math.max(0, c - 1));
      setSelectedIndex(0);
      return;
    }

    // --- Left/Right arrow ---
    if (key.leftArrow) {
      setCursor(c => Math.max(0, c - 1));
      return;
    }
    if (key.rightArrow) {
      setCursor(c => Math.min(input.length, c + 1));
      return;
    }

    // --- Regular character input ---
    if (ch && !key.ctrl && !key.meta) {
      setInput(prev => prev.slice(0, cursor) + ch + prev.slice(cursor));
      setCursor(c => c + ch.length);
      setSelectedIndex(0);
    }
  });

  // Render: text before cursor | cursor char | text after cursor
  const before = input.slice(0, cursor);
  const after = input.slice(cursor);

  return (
    <Box flexDirection="column">
      {/* Suggestion panel — rendered above the input box */}
      {showSuggestions && (
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
      )}

      {/* Input box */}
      <Box
        borderStyle="single"
        borderColor="gray"
        borderLeft={false}
        borderRight={false}
        paddingX={1}
      >
        <Text color={theme.user.prefixColor} bold>{theme.user.prefix}</Text>
        <Text> {before}</Text>
        <Text color="white" inverse>{after.length > 0 ? after[0] : ' '}</Text>
        <Text>{after.slice(1)}</Text>
        <Text dimColor>{busy ? ' (thinking...)' : ''}</Text>
      </Box>
    </Box>
  );
}
