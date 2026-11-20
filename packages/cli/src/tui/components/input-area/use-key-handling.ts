// The useInput key handler: every key decision of the input area. Extracted
// from the InputArea component unchanged — the hook is called at the exact
// position the inline `useInput` used to occupy, so the component's flattened
// hook sequence is identical.

import { useInput } from 'ink';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { nextCodePointLength, normalizeInputText, prevCodePointLength } from '@/tui/utils/input-display';
import {
  killToLineEnd,
  killToLineStart,
  killWordBefore,
  lineEnd,
  replaceRange,
  wordLeft,
  wordRight,
} from '@/tui/utils/input-editing';
import type { EditResult, SelectionRange } from '@/tui/utils/input-editing';
import { redoEdit, undoEdit } from '@/tui/utils/input-history';
import type { EditKind, InputHistory } from '@/tui/utils/input-history';
import { matchCsiEnter } from './csi-enter';
import type { SlashCommandSuggestion } from './suggestion-panel';

/** Everything the key handler closes over, threaded from the InputArea component. */
export interface InputKeyHandling {
  input: string;
  cursor: number;
  sel: SelectionRange;
  hasSelection: boolean;
  showSuggestions: boolean;
  suggestions: SlashCommandSuggestion[];
  clampedIndex: number;
  historyRef: MutableRefObject<InputHistory>;
  setSelectedIndex: Dispatch<SetStateAction<number>>;
  setAnchor: Dispatch<SetStateAction<number | null>>;
  setCursor: Dispatch<SetStateAction<number>>;
  setPanelDismissed: Dispatch<SetStateAction<boolean>>;
  applyEdit: (r: EditResult, kind: EditKind) => void;
  applySnapshot: (history: InputHistory) => void;
  applySuggestion: (index: number) => void;
  reset: () => void;
  onSubmit: (input: string) => void;
  onExit: () => void;
  onEscape?: () => void;
}

export function useInputKeyHandling(params: InputKeyHandling): void {
  const {
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
  } = params;

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
}
