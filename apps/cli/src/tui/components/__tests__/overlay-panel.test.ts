import { describe, it, expect } from 'vitest';
import { createElement as h } from 'react';
import { render } from 'ink';
import { OverlayPanel } from '@/tui/components/overlay-panel';
import type { Overlay } from '@/tui/types/overlay';

/**
 * Render OverlayPanel against a fake 20-column stdout that records every
 * chunk ink writes. With `debug: true` ink writes each frame verbatim (no
 * clear sequences), so the accumulated output can be searched after stripping
 * ANSI color codes.
 */
async function renderOverlay(overlay: Overlay, columns = 20): Promise<string> {
  const chunks: string[] = [];
  const stdout = {
    columns,
    rows: 24,
    write: (chunk: string) => { chunks.push(chunk); return true; },
    on() { return stdout; },
    off() { return stdout; },
    removeListener() { return stdout; },
  };
  const app = render(h(OverlayPanel, { overlay }), {
    stdout: stdout as unknown as NodeJS.WriteStream,
    debug: true,
    patchConsole: false,
  });
  await new Promise<void>(resolve => setImmediate(resolve));
  app.unmount();
  // Strip ANSI escape sequences (colors, cursor moves) before asserting. The
  // ESC byte is built via fromCharCode to keep the source free of a literal
  // control character (eslint: no-control-regex).
  const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[a-zA-Z]`, 'g');
  return chunks.join('').replace(ansi, '');
}

describe('OverlayPanel', () => {
  it('renders one row per line of text content', async () => {
    const output = await renderOverlay({ kind: 'text', content: 'row one\nrow two\nrow three' });

    expect(output).toContain('row one');
    expect(output).toContain('row two');
    expect(output).toContain('row three');
  });

  it('renders the bottom hint when present', async () => {
    const output = await renderOverlay({ kind: 'text', content: 'body', hint: '(esc to dismiss)' });

    expect(output).toContain('body');
    expect(output).toContain('(esc to dismiss)');
  });

  it('hard-clips a line wider than the panel instead of wrapping it', async () => {
    // 20 columns minus border (2) and padding (2) = 16 usable columns.
    // wrap="truncate" keeps this one physical line ending at "klmn"; a wrapped
    // render would show the remainder "klmnopqrst uvwxyz" on later lines.
    const output = await renderOverlay({ kind: 'text', content: 'abcdefghij klmnopqrst uvwxyz' });

    expect(output).toContain('abcdefghij klmn');
    expect(output).not.toContain('klmnopqrst uvwxyz');
  });

  it('keeps a blank line as a rendered row', async () => {
    const output = await renderOverlay({ kind: 'text', content: 'above\n\nbelow' });

    expect(output).toContain('above');
    expect(output).toContain('below');
  });
});
