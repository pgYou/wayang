import { createElement, type ReactElement } from 'react';
import { render } from 'ink';

/** Strip ANSI escape sequences (colors, cursor moves) from rendered output. */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
}

/**
 * Render an Ink element once to plain text (no TTY, no colors) for
 * component-level assertions. The project has no ink-testing-library, so
 * this drives Ink's own renderer with a minimal fake stdout in debug mode
 * (each render writes the full frame).
 */
export function renderToString(element: ReactElement, columns = 100): string {
  let frame = '';
  const stdout = {
    columns,
    rows: 200,
    write: (s: string) => { frame = s; return true; },
    on() { return stdout; },
    off() { return stdout; },
    removeListener() { return stdout; },
  };
  const app = render(element, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    debug: true,
    patchConsole: false,
  });
  app.unmount();
  return stripAnsi(frame);
}

export { createElement as h };
