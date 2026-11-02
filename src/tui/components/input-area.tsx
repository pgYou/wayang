import React, { useState, useMemo } from 'react';
import { useMemoizedFn } from '@/tui/hooks/use-memoized-fn';
import { SLASH_COMMANDS } from '@/tui/hooks/use-slash-commands';
import { Box, Text, useInput } from 'ink';
import { theme } from '@/tui/theme';
import { stringWidth } from '@/tui/utils/text-width';
import {
  layoutInput,
  nextCodePointLength,
  normalizeInputText,
  prevCodePointLength,
} from '@/tui/utils/input-display';

interface InputAreaProps {
  onSubmit: (input: string) => void;
  onExit: () => void;
  onEscape?: () => void;
  busy?: boolean;
  /** Terminal width in columns; the input box wraps its text to fit. */
  width: number;
}

/** Prompt prefix and the gutter that keeps wrapped rows aligned under it. */
const PREFIX = `${theme.user.prefix} `;
const PREFIX_WIDTH = stringWidth(PREFIX);

export function InputArea({ onSubmit, onExit, onEscape, busy, width }: InputAreaProps) {
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
    // Ink 4 maps both the backspace key (0x7f) and the forward-delete escape
    // sequence to `key.delete`, so they cannot be told apart: both delete the
    // code point before the cursor.
    if (key.backspace || key.delete) {
      if (cursor === 0) return;
      const len = prevCodePointLength(input, cursor);
      setInput(prev => prev.slice(0, cursor - len) + prev.slice(cursor));
      setCursor(c => c - len);
      setSelectedIndex(0);
      return;
    }

    // --- Left/Right arrow: move by code point, never splitting an emoji ---
    if (key.leftArrow) {
      setCursor(c => Math.max(0, c - prevCodePointLength(input, c)));
      return;
    }
    if (key.rightArrow) {
      setCursor(c => Math.min(input.length, c + nextCodePointLength(input, c)));
      return;
    }

    // --- Regular character input (includes pasted multi-line text) ---
    if (ch && !key.ctrl && !key.meta) {
      // Terminals send pasted newlines as CR or CRLF; normalize to LF so the
      // value — and what gets submitted — uses real newlines.
      const text = normalizeInputText(ch);
      if (text.length === 0) return;
      setInput(prev => prev.slice(0, cursor) + text + prev.slice(cursor));
      setCursor(c => c + text.length);
      setSelectedIndex(0);
    }
  });

  // Text budget: terminal width minus the box's horizontal padding and the
  // prompt prefix. Every visual line is pre-wrapped to this budget so Ink
  // never has to wrap (or reposition siblings around) a multi-row text node.
  const textBudget = Math.max(1, width - 2 - PREFIX_WIDTH);
  const layout = useMemo(
    () => layoutInput(input, cursor, textBudget),
    [input, cursor, textBudget],
  );

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

      {/* Input box — one row per visual line so newlines pasted into the
          value render as real lines and the cursor block stays on its line */}
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
                <Text>{i === 0 ? ` ${before}` : before}</Text>
                {isCursorLine && (
                  <Text color="white" inverse>{cursorCell}</Text>
                )}
                <Text>{after}</Text>
                {isCursorLine && busy && <Text dimColor> (thinking...)</Text>}
              </Box>
            );
          })}
        </Box>
      </Box>
    </Box>
  );
}
