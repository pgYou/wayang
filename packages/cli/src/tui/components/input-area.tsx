import { useState, useMemo, useRef, useEffect } from 'react';
import { useMemoizedFn } from '@/tui/hooks/use-memoized-fn';
import { SLASH_COMMANDS } from '@/tui/hooks/use-slash-commands';
import { Box } from 'ink';
import { layoutInput } from '@/tui/utils/input-display';
import { normalizeSelection, replaceRange } from '@/tui/utils/input-editing';
import type { EditResult } from '@/tui/utils/input-editing';
import { commitEdit, initInputHistory } from '@/tui/utils/input-history';
import type { EditKind, InputHistory } from '@/tui/utils/input-history';
import { InputBox, PREFIX_WIDTH } from './input-area/input-box';
import { SuggestionPanel } from './input-area/suggestion-panel';
import { useInputKeyHandling } from './input-area/use-key-handling';

export interface InputAreaProps {
  onSubmit: (input: string) => void;
  onExit: () => void;
  onEscape?: () => void;
  busy?: boolean;
  /** Terminal width in columns; the input box wraps its text to fit. */
  width: number;
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

  // Every key decision (Enter, newline variants, autocomplete, selection
  // motion, readline kills, undo/redo) lives in the key-handling hook; it is
  // invoked exactly where the inline `useInput` used to be, so the hook
  // sequence of this component is unchanged.
  useInputKeyHandling({
    input,
    cursor,
    sel,
    hasSelection,
    showSuggestions,
    suggestions,
    clampedIndex,
    historyRef,
    setSelectedIndex,
    setAnchor,
    setCursor,
    setPanelDismissed,
    applyEdit,
    applySnapshot,
    applySuggestion,
    reset,
    onSubmit,
    onExit,
    onEscape,
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
        <SuggestionPanel suggestions={suggestions} clampedIndex={clampedIndex} />
      )}

      <InputBox layout={layout} sel={sel} visibleSelection={visibleSelection} busy={busy} />
    </Box>
  );
}
