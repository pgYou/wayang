import React from 'react';
import { render } from 'ink';
import { App } from './app';
import type { Supervisor } from '@/services/supervisor';
import { writeWelcome } from './welcome';



/**
 * Render the Ink UI for a running supervisor.
 * Returns a handle to wait for UI exit.
 */
export function renderInkUI(supervisor: Supervisor): Promise<void> {
  return new Promise((resolve) => {
    // Clear screen, then write welcome banner before Ink takes over stdout
    process.stdout.write('\x1B[2J\x1B[H');
    writeWelcome(supervisor.ctx.workspaceDir);

    const { waitUntilExit } = render(
      React.createElement(App, { supervisor }),
    );
    waitUntilExit().then(() => resolve());
  });
}
