import { describe, it, expect } from 'vitest';
import {
  SHORTCUTS,
  SHORTCUT_CATEGORIES,
  SHORTCUT_CATEGORY_LABELS,
  renderShortcutList,
  renderShortcutSpans,
} from '@/tui/utils/shortcut-catalog';

/** Entries filed under one category. */
const entriesOf = (category: string) => SHORTCUTS.filter(s => s.category === category);

describe('shortcut catalog', () => {
  it('lists the three groups in a fixed order', () => {
    expect(SHORTCUT_CATEGORIES).toEqual(['input', 'app', 'session']);
  });

  it('files 16 input-editing, 2 application and 2 session entries', () => {
    expect(entriesOf('input')).toHaveLength(16);
    expect(entriesOf('app')).toHaveLength(2);
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
    // Ctrl+C: busy abort / idle double-press-to-quit hint.
    expect(rendered).toContain('Ctrl+C');
    expect(rendered).toContain('quit');
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

describe('renderShortcutSpans', () => {
  it('reassembles every entry line verbatim from the catalog copy', () => {
    const entryLines = renderShortcutSpans()
      .filter(line => line[0]?.role === 'key')
      .map(line => line.map(span => span.text).join(''));
    const expected = SHORTCUTS.map(e => e.when
      ? `  ${e.keys} — ${e.action} (${e.when})`
      : `  ${e.keys} — ${e.action}`);

    expect(entryLines).toHaveLength(SHORTCUTS.length);
    expect(entryLines).toEqual(expect.arrayContaining(expected));
  });

  it('tags each entry with the keys first, then only action spans', () => {
    const entryLines = renderShortcutSpans().filter(line => line[0]?.role === 'key');
    for (const line of entryLines) {
      const [keys, ...rest] = line;
      expect(keys?.text.startsWith('  ')).toBe(true);
      expect(rest.length).toBeGreaterThan(0);
      expect(rest.every(span => span.role === 'action')).toBe(true);
    }
  });

  it('gives every group one heading line, in display order', () => {
    const headings = renderShortcutSpans()
      .filter(line => line.length === 1 && line[0]?.role === 'heading')
      .map(line => line[0]?.text);
    expect(headings).toEqual(SHORTCUT_CATEGORIES.map(c => SHORTCUT_CATEGORY_LABELS[c]));
  });

  it('is the single layout definition — the plain list is its spans joined', () => {
    expect(renderShortcutList()).toBe(renderShortcutSpans()
      .map(line => line.map(span => span.text).join(''))
      .join('\n'));
  });
});
