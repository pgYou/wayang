import React from 'react';
import { render } from 'ink';
import { App } from './app';
import type { RemoteSupervisor } from '@/client/remote-supervisor';
import { writeWelcome } from './welcome';



/**
 * Render the Ink UI connected to a remote (headless) supervisor.
 * Returns a handle to wait for UI exit.
 */
export function renderInkUI(supervisor: RemoteSupervisor): Promise<void> {
  return new Promise((resolve) => {
    // Clear screen, then write welcome banner before Ink takes over stdout
    process.stdout.write('\x1B[2J\x1B[H');
    writeWelcome(supervisor.ctx.workspaceDir, supervisor.ctx.workspaces);

    const { waitUntilExit } = render(
      React.createElement(App, { supervisor }),
      // Ctrl+C ownership belongs to AppContent's useInput handler. Ctrl+C
      // only ever quits: in every state the first press shows a notice and a
      // second press within 1s exits. Aborting a turn is ESC's job. Ink's
      // default exitOnCtrlC would unmount on the FIRST press, before the
      // app-level handler ever sees the key.
      { exitOnCtrlC: false },
    );
    waitUntilExit().then(() => resolve());
  });
}
