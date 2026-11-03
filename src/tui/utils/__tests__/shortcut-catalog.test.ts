import { describe, it, expect } from 'vitest';
import {
  SHORTCUTS,
  SHORTCUT_CATEGORIES,
  SHORTCUT_CATEGORY_LABELS,
  renderShortcutList,
} from '@/tui/utils/shortcut-catalog';

/** Entries filed under one category. */
const entriesOf = (category: string) => SHORTCUTS.filter(s => s.category === category);

describe('shortcut catalog', () => {
  it('lists the three groups in a fixed order', () => {
    expect(SHORTCUT_CATEGORIES).toEqual(['input', 'app', 'session']);
  });

  it('files 16 input-editing, 1 application and 2 session entries', () => {
    expect(entriesOf('input')).toHaveLength(16);
    expect(entriesOf('app')).toHaveLength(1);
    expect(entriesOf('session')).toHaveLength(2);
  });

  it('gives every group a heading and every entry a key and an action', () => {
    for (const category of SHORTCUT_CATEGORIES) {
      expect(SHORTCUT_CATEGORY_LABELS[category].trim()).not.toBe('');
      expect(entriesOf(category).length).toBeGreaterThan(0);
    }
    for (const entry of SHORTCUTS) {
      expect(entry.keys.trim()).not.toBe('');
      expect(entry.action.trim()).not.toBe('');
    }
  });

  it('renders one heading per group and one indented line per entry', () => {
    const rendered = renderShortcutList();
    for (const category of SHORTCUT_CATEGORIES) {
      expect(rendered).toContain(SHORTCUT_CATEGORY_LABELS[category]);
    }
    const entryLines = rendered
      .split('\n')
      .filter(line => line.startsWith('  ') && line.includes(' — '));
    expect(entryLines).toHaveLength(SHORTCUTS.length);
  });

  it('documents the key bindings product decides against', () => {
    // Containment, not a text snapshot: copy may be reworded, these keys
    // and their meanings must survive any rewording.
    const rendered = renderShortcutList();

    // Esc aborts the controller turn (and keeps the draft).
    expect(rendered).toContain('Esc');
    expect(rendered).toContain('abort');
    // Ctrl+C: one row, quit-only — press twice within 1s, busy or idle.
    // Aborting a turn belongs to Esc, never to Ctrl+C.
    expect(rendered).toContain('Ctrl+C');
    expect(rendered).toContain('quit');
    expect(SHORTCUTS.filter(e => e.keys === 'Ctrl+C')).toHaveLength(1);
    // Ctrl+U stays the readline kill-to-line-start.
    expect(rendered).toContain('Ctrl+U');
    expect(rendered).toContain('line start');
    // Ctrl+J inserts a newline.
    expect(rendered).toContain('Ctrl+J');
    expect(rendered).toContain('newline');
    // Undo/redo and selection, the other load-bearing editing keys.
    expect(rendered).toContain('Ctrl+Z');
    expect(rendered).toContain('Undo');
  });

  it('spells keys for humans, never as raw control codes', () => {
    for (const entry of SHORTCUTS) {
      // eslint-disable-next-line no-control-regex
      expect(entry.keys).not.toMatch(/[\x00-\x1f]/);
    }
  });
});
