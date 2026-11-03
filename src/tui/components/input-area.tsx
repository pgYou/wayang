import React, { useState, useMemo, useRef, useEffect } from 'react';
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
  splitLineBySelection,
} from '@/tui/utils/input-display';
import {
  killToLineEnd,
  killToLineStart,
  killWordBefore,
  lineEnd,
  normalizeSelection,
  replaceRange,
  wordLeft,
  wordRight,
} from '@/tui/utils/input-editing';
import type { EditResult } from '@/tui/utils/input-editing';
import {
  commitEdit,
  initInputHistory,
  redoEdit,
  undoEdit,
} from '@/tui/utils/input-history';
import type { EditKind, InputHistory } from '@/tui/utils/input-history';

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

/**
 * Decode a CSI u key report for Enter coming from a terminal with the kitty
 * keyboard protocol active (its "report all keys as escape codes" mode).
 * Ink 4 cannot parse these sequences, so they arrive as their literal text
 * with the leading ESC already stripped: `'[13;5u'` for Ctrl+Enter,
 * `'[13;3u'` for Alt+Enter. Per the protocol: `13` is Enter's code point,
 * the second field is `1 + modifier bits` (shift=1, alt=2, ctrl=4), and an
 * optional `:event` suffix distinguishes press (1), repeat (2) and release
 * (3).
 *
 * Returns the decoded modifiers and event type when the sequence is an
 * Enter with Alt or Ctrl held — the newline variants — and `null` for
 * everything else (other keys, plain or shift-only Enter).
 */
const CSI_ENTER_RE = /^\[13;(\d+)(?::(\d))?u$/;
function matchCsiEnter(s: string): { modifiers: number; event: number } | null {
  const m = CSI_ENTER_RE.exec(s);
  if (!m) return null;
  const modifiers = Number(m[1]) - 1; // the wire value is 1 + the bit field
  // Shift-only Enter stays unbound: in every legacy terminal it is
  // byte-identical to plain Enter, so it must not grow a meaning only an
  // enhanced keyboard can trigger.
  if ((modifiers & 0b110) === 0) return null;
  return { modifiers, event: m[2] === undefined ? 1 : Number(m[2]) };
}

export function InputArea({ onSubmit, onExit, onEscape, busy, width }: InputAreaProps) {
  const [input, setInput] = useState('');
  const [cursor, setCursor] = useState(0);
  // Fixed end of the selection; `null` means no selection. The cursor stays
  // the active end, so the selection is [min(anchor, cursor), max(...)].
  // Only ever copied from `cursor`, so it is always a code-point boundary.
  const [anchor, setAnchor] = useState<number | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  // Escape closes the suggestion panel without touching the draft; this flag
  // is that dismissal. It lapses (effect below) once the input stops
  // matching any command, so a fresh '/' reopens the panel.
  const [panelDismissed, setPanelDismissed] = useState(false);
  // Undo stack. Must be a ref: state would re-render on every keystroke and a
  // value rebuilt per render would lose the history. Applying a snapshot goes
  // through setInput/setCursor, which already triggers the render.
  const historyRef = useRef<InputHistory>(initInputHistory(''));

  // Filter matching commands when input starts with "/" and has no space yet
  const suggestions = useMemo(() => {
    if (!input.startsWith('/') || input.includes(' ')) return [];
    const typed = input.slice(1).toLowerCase();
    return SLASH_COMMANDS.filter(c => c.name.startsWith(typed));
  }, [input]);

  const showSuggestions = suggestions.length > 0 && !panelDismissed;

  // The dismissal lapses with its trigger: once no command matches any more
  // (draft submitted, prefix removed, space typed), the panel re-arms so a
  // new '/' command can open it again.
  useEffect(() => {
    if (suggestions.length === 0) setPanelDismissed(false);
  }, [suggestions.length]);

  // A collapsed selection (anchor === null or anchor === cursor) needs no
  // special casing anywhere: replaceRange over an empty range is a plain
  // insert, and the renderer falls back to the cursor block.
  const sel = useMemo(
    () => normalizeSelection(input, anchor, cursor),
    [input, anchor, cursor],
  );
  const hasSelection = sel.start < sel.end;
  // A selection made of newlines only (Shift+Left onto a '\n') has nothing to
  // highlight: splitLineBySelection leaves both rows unselected, so drawing
  // "no cursor + no highlight" would make the caret vanish. Such a selection
  // still exists for editing (replacing it deletes the newline); it just is
  // not visible, so the renderer falls back to the cursor block.
  const visibleSelection = hasSelection
    && input.slice(sel.start, sel.end).replace(/\n/g, '').length > 0;

  // Clamp selectedIndex when suggestions change
  const clampedIndex = showSuggestions
    ? Math.min(selectedIndex, suggestions.length - 1)
    : 0;

  const reset = useMemoizedFn(() => {
    setInput('');
    setCursor(0);
    setAnchor(null);
    setSelectedIndex(0);
    setPanelDismissed(false);
    // Submitted text must not come back with Ctrl-Z.
    historyRef.current = initInputHistory('');
  });

  // Single funnel for every text-mutating edit: push the post-edit state to
  // React and record it in the undo stack. The commit always uses the values
  // the editing helper returned — reading the state variables here would see
  // the pre-edit closure (setState is async).
  const applyEdit = useMemoizedFn((r: EditResult, kind: EditKind) => {
    setInput(r.value);
    setCursor(r.cursor);
    setAnchor(null);
    setSelectedIndex(0);
    // A no-op edit (Ctrl-K at the end of a line, for instance) must not put a
    // duplicate entry on the stack, or Ctrl-Z would need two presses.
    if (r.value === input && r.cursor === cursor) return;
    historyRef.current = commitEdit(historyRef.current, {
      value: r.value,
      cursor: r.cursor,
      anchor: null,
      ts: Date.now(),
      kind,
    });
  });

  // Undo/redo hand back a history whose pointer moved; the entry it points at
  // is the state to restore (anchor included, so a restored selection works).
  const applySnapshot = useMemoizedFn((history: InputHistory) => {
    const entry = history.entries[history.pointer];
    if (!entry) return;
    historyRef.current = history;
    setInput(entry.value);
    setCursor(entry.cursor);
    setAnchor(entry.anchor);
    setSelectedIndex(0);
  });

  const applySuggestion = useMemoizedFn((index: number) => {
    const cmd = suggestions[index];
    if (!cmd) return;
    const text = `/${cmd.name}`;
    // Append trailing space if the command accepts args
    const filled = 'args' in cmd ? `${text} ` : text;
    // Autocompletion is an edit like any other: Ctrl-Z undoes it.
    applyEdit(replaceRange(input, 0, input.length, filled), 'replace');
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

    // --- Newline: Ctrl+J / Alt+Enter / Ctrl+Enter (kitty CSI u) ---
    // Enter itself ('\r' → key.return) submits above; every manual-newline
    // key arrives as something else, and none of them carries key.return:
    //   Ctrl+J      a bare '\n' — Ink 4 parses it as key name 'enter', which
    //               is NOT 'return', so it lands here as a character.
    //   Alt+Enter   ESC + '\r' in one chunk — Ink strips the ESC and reports
    //               the '\r' as a plain character with no meta flag.
    //   Ctrl+Enter  '\x1b[13;5u' under the kitty keyboard protocol's
    //               report-all-keys mode (Alt+Enter is '\x1b[13;3u' there);
    //               see matchCsiEnter for why the sequence arrives as text.
    // A newline is an ordinary character: it replaces an active selection,
    // joins the typing run on the undo stack, and renders through the same
    // multi-line layout as pasted text. Shift+Enter is deliberately not
    // handled — most terminals send the same '\r' as Enter, so binding it
    // would promise what a stock terminal cannot deliver.
    if (ch === '\n' || ch === '\r') {
      applyEdit(replaceRange(input, sel.start, sel.end, '\n'), 'insert');
      return;
    }
    const csiEnter = matchCsiEnter(ch);
    if (csiEnter) {
      // With key-event reporting on, the terminal sends press AND release;
      // only press and repeat events insert.
      if (csiEnter.event !== 3) {
        applyEdit(replaceRange(input, sel.start, sel.end, '\n'), 'insert');
      }
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
    // First match wins, and the draft is never touched: a selection is
    // dismissed (value and cursor stay put), an open suggestion panel is
    // closed (it re-arms once the input stops matching commands), and only
    // a bare Escape travels on to the controller — which dismisses an
    // overlay or aborts the current turn (controller-page owns that
    // wiring; nothing here may reset the draft).
    if (key.escape) {
      if (hasSelection) {
        setAnchor(null);
        return;
      }
      if (showSuggestions) {
        setPanelDismissed(true);
        return;
      }
      onEscape?.();
      return;
    }

    // --- Ctrl/Alt editing keys (readline-style) ---
    // Ink reports Ctrl+letter as `key.ctrl` with `input` set to the lowercase
    // letter name, Alt+letter as `key.meta` with the same `input`. Every
    // branch below returns: an unmatched Ctrl/Alt combination then falls
    // through to the `!key.ctrl && !key.meta` guard on the character branch
    // and is ignored. Ctrl-C is deliberately absent — app.tsx owns it.
    // These branches must precede the bare arrow ones (Ctrl+arrows would
    // otherwise be swallowed by them).
    if (key.ctrl && ch === 'a') {
      // Select the whole value. Not readline's beginning-of-line: Ink has no
      // Home and "select all" is worth more here; Ctrl-U covers line start.
      setAnchor(0);
      setCursor(input.length);
      return;
    }
    if (key.ctrl && ch === 'e') {
      setAnchor(null);
      setCursor(lineEnd(input, cursor));
      return;
    }
    // Ctrl-K/U/W destroy text. With a selection they act on the selection —
    // the selection is the target of the next edit — otherwise on the
    // readline range (line end / line start / word before).
    if (key.ctrl && ch === 'k') {
      if (hasSelection) {
        applyEdit(replaceRange(input, sel.start, sel.end, ''), 'replace');
      } else {
        applyEdit(killToLineEnd(input, cursor), 'kill');
      }
      return;
    }
    if (key.ctrl && ch === 'u') {
      if (hasSelection) {
        applyEdit(replaceRange(input, sel.start, sel.end, ''), 'replace');
      } else {
        applyEdit(killToLineStart(input, cursor), 'kill');
      }
      return;
    }
    if (key.ctrl && ch === 'w') {
      if (hasSelection) {
        applyEdit(replaceRange(input, sel.start, sel.end, ''), 'replace');
      } else {
        applyEdit(killWordBefore(input, cursor), 'kill');
      }
      return;
    }
    // Word motion, shared by Ctrl+arrows and Alt+B/F. Shift extends the
    // selection (anchor pinned at the first step); without it the selection
    // collapses to the active end.
    const moveWordLeft = () => {
      if (key.shift) setAnchor(a => a ?? cursor);
      else setAnchor(null);
      setCursor(wordLeft(input, cursor));
    };
    const moveWordRight = () => {
      if (key.shift) setAnchor(a => a ?? cursor);
      else setAnchor(null);
      setCursor(wordRight(input, cursor));
    };
    if (key.ctrl && key.leftArrow) {
      moveWordLeft();
      return;
    }
    if (key.ctrl && key.rightArrow) {
      moveWordRight();
      return;
    }
    // Alt+B/F. The Escape key itself also carries meta, hence the key.escape
    // guard; macOS Terminal may not send Alt at all, so these are a bonus
    // path next to Ctrl+arrows.
    if (key.meta && !key.escape && ch === 'b') {
      moveWordLeft();
      return;
    }
    if (key.meta && !key.escape && ch === 'f') {
      moveWordRight();
      return;
    }
    if (key.ctrl && ch === 'z') {
      const next = undoEdit(historyRef.current);
      if (next) applySnapshot(next);
      return;
    }
    if (key.ctrl && ch === 'y') {
      const next = redoEdit(historyRef.current);
      if (next) applySnapshot(next);
      return;
    }

    // --- Shift+Left/Right: extend the selection (anchor fixed at first step) ---
    // Terminals send these as modified cursor sequences ('\x1b[1;2D' / '[1;2C'),
    // which Ink reports as shift + leftArrow/rightArrow. These branches must
    // precede the bare arrow ones, and must not be caught by them: shift is
    // ignored for up/down (vertical selection is out of scope) and for Tab.
    if (key.shift && key.leftArrow) {
      setAnchor(a => a ?? cursor);
      setCursor(c => Math.max(0, c - prevCodePointLength(input, c)));
      return;
    }
    if (key.shift && key.rightArrow) {
      setAnchor(a => a ?? cursor);
      setCursor(c => Math.min(input.length, c + nextCodePointLength(input, c)));
      return;
    }

    // --- Backspace / Delete ---
    // Ink 4 maps both the backspace key (0x7f) and the forward-delete escape
    // sequence to `key.delete`, so they cannot be told apart: both delete the
    // code point before the cursor — or the whole selection, when there is one.
    if (key.backspace || key.delete) {
      if (hasSelection) {
        applyEdit(replaceRange(input, sel.start, sel.end, ''), 'delete');
        return;
      }
      if (cursor === 0) return;
      const len = prevCodePointLength(input, cursor);
      applyEdit(
        { value: input.slice(0, cursor - len) + input.slice(cursor), cursor: cursor - len },
        'delete',
      );
      return;
    }

    // --- Left/Right arrow: move by code point, never splitting an emoji ---
    // Moving without Shift drops the selection (it collapses to the active end).
    if (key.leftArrow) {
      setAnchor(null);
      setCursor(c => Math.max(0, c - prevCodePointLength(input, c)));
      return;
    }
    if (key.rightArrow) {
      setAnchor(null);
      setCursor(c => Math.min(input.length, c + nextCodePointLength(input, c)));
      return;
    }

    // --- Regular character input (includes pasted multi-line text) ---
    // Never exclude key.shift here: uppercase letters and symbols carry it.
    if (ch && !key.ctrl && !key.meta) {
      // Terminals send pasted newlines as CR or CRLF; normalize to LF so the
      // value — and what gets submitted — uses real newlines.
      const text = normalizeInputText(ch);
      if (text.length === 0) return;
      // Typing replaces the selection instead of inserting into it.
      const r = replaceRange(input, sel.start, sel.end, text);
      // A multi-code-point chunk is a paste (or an IME commit): one undo step,
      // never merged with the neighbouring typing runs. A single code point is
      // an insert and may join a run.
      applyEdit(r, [...text].length === 1 ? 'insert' : 'paste');
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
    </Box>
  );
}
