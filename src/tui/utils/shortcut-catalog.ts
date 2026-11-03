/**
 * The user-facing keybinding cheat sheet, in one read-only table.
 *
 * `/shortcut` renders this catalog, and the keybinding survey handed to
 * product is generated from the same rows — one table, not a second
 * hand-maintained copy of the copy. The dispatch itself is untouched: the
 * handlers live in `input-area.tsx` (input editing), `app.tsx` (Ctrl+C) and
 * `controller-page.tsx` (overlay Escape). This file only *describes* those
 * bindings, so changing a key means updating the handler and its row here
 * in the same commit; the containment assertions in the tests are the
 * drift guard for the keys product depends on.
 *
 * `when` is a plain condition string, rendered as a parenthetical — keys
 * whose meaning depends on context (panel open, controller busy, …) say so
 * there instead of growing multiple rows.
 *
 * Rendering is two-layered: `renderShortcutSpans` cuts each line into
 * role-tagged spans — the only place the line layout is defined — and the
 * Ink layer (`shortcut-overlay.tsx`) maps roles to styles (keys anchor the
 * line, actions stay quiet). The copy lives once, here; the plain-text
 * `renderShortcutList` is derived from the same spans.
 */

/** Which layer of the app owns the binding. */
export type ShortcutCategory = 'input' | 'app' | 'session';

/** One row of the cheat sheet: keys, what they do, and under what condition. */
export interface ShortcutEntry {
  /** The key combination(s) in user-facing spelling, e.g. `'Ctrl+K'`. */
  keys: string;
  /** What pressing it does. */
  action: string;
  /** Which layer owns the binding. */
  category: ShortcutCategory;
  /** Condition under which the binding applies, if it is conditional. */
  when?: string;
}

/** Group headings, in display order. */
export const SHORTCUT_CATEGORY_LABELS: Record<ShortcutCategory, string> = {
  input: 'Input editing',
  app: 'Application',
  session: 'Session',
};

/** The groups in display order. */
export const SHORTCUT_CATEGORIES: readonly ShortcutCategory[] = ['input', 'app', 'session'];

/** Every keybinding the input box and the app around it respond to. */
export const SHORTCUTS: readonly ShortcutEntry[] = [
  // --- Input editing (handled in input-area.tsx) ---
  { keys: 'Enter', action: 'Send the input', category: 'input', when: 'panel open: pick the highlighted command' },
  { keys: 'Ctrl+J, Alt+Enter, Ctrl+Enter', action: 'Insert a newline', category: 'input', when: 'Ctrl+Enter only under the kitty keyboard protocol' },
  { keys: 'Tab', action: 'Complete the highlighted command', category: 'input', when: 'panel open' },
  { keys: 'Up / Down', action: 'Move the panel highlight', category: 'input', when: 'panel open' },
  { keys: 'Esc', action: 'Cancel the selection, else close the panel, else abort the current turn', category: 'input', when: 'the draft is kept' },
  { keys: 'Ctrl+A', action: 'Select all', category: 'input' },
  { keys: 'Ctrl+E', action: 'Move the cursor to the line end', category: 'input' },
  { keys: 'Ctrl+K', action: 'Delete to the line end', category: 'input', when: 'with a selection, delete it' },
  { keys: 'Ctrl+U', action: 'Delete to the line start', category: 'input', when: 'with a selection, delete it' },
  { keys: 'Ctrl+W', action: 'Delete the word before the cursor', category: 'input', when: 'with a selection, delete it' },
  { keys: 'Ctrl+Left / Ctrl+Right', action: 'Move the cursor by word', category: 'input', when: 'Shift extends the selection' },
  { keys: 'Alt+B / Alt+F', action: 'Move the cursor by word', category: 'input' },
  { keys: 'Ctrl+Z / Ctrl+Y', action: 'Undo / redo', category: 'input' },
  { keys: 'Shift+Left / Shift+Right', action: 'Extend the selection', category: 'input' },
  { keys: 'Left / Right', action: 'Move the cursor by one character', category: 'input' },
  { keys: 'Backspace / Delete', action: 'Delete the character before the cursor', category: 'input', when: 'with a selection, delete it' },

  // --- Application (app.tsx owns Ctrl+C; controller-page routes Escape) ---
  { keys: 'Ctrl+C', action: 'Abort the current turn', category: 'app', when: 'controller busy' },
  { keys: 'Esc', action: 'Dismiss the overlay', category: 'app', when: 'overlay open' },

  // --- Session lifecycle ---
  { keys: 'Ctrl+C', action: 'Press twice within 1s to quit', category: 'session', when: 'idle' },
  { keys: '/exit, /quit', action: 'Quit the session', category: 'session' },
];

/** Visual role of one run of a rendered line — the Ink layer maps it to a style. */
export type ShortcutSpanRole = 'heading' | 'key' | 'action';

/** One styled run of a cheat-sheet line; `text` is the only copy of the copy. */
export interface ShortcutSpan {
  text: string;
  role: ShortcutSpanRole;
}

/**
 * The catalog as `/shortcut` shows it: one heading line per group, then one
 * `键 — 动作` line per entry, indented. Each line is a run of role-tagged
 * spans — plain lines, no table grid; the overlay spans the terminal width
 * and a grid would wrap on narrow terms (the render layer truncates
 * instead).
 */
export function renderShortcutSpans(): ShortcutSpan[][] {
  const lines: ShortcutSpan[][] = [];
  for (const category of SHORTCUT_CATEGORIES) {
    lines.push([{ text: SHORTCUT_CATEGORY_LABELS[category], role: 'heading' }]);
    for (const entry of SHORTCUTS.filter(e => e.category === category)) {
      const line: ShortcutSpan[] = [
        { text: `  ${entry.keys}`, role: 'key' },
        { text: ` — ${entry.action}`, role: 'action' },
      ];
      if (entry.when) line.push({ text: ` (${entry.when})`, role: 'action' });
      lines.push(line);
    }
  }
  return lines;
}

/**
 * The catalog as plain text. Derived from the span lines — not a second
 * rendering — so the styled overlay and this string share one layout and
 * one copy of the copy.
 */
export function renderShortcutList(): string {
  return renderShortcutSpans()
    .map(line => line.map(span => span.text).join(''))
    .join('\n');
}
