import { z } from 'zod';
import { defineTool, safeExecute } from './common';

/**
 * DEPRECATED stub (0.6): controller messages are now injected automatically
 * as `[Controller message]` user messages at each LLM step — workers no
 * longer poll. The stub exists because historical task descriptions may
 * embed "call check_controller_messages periodically" instructions; it
 * returns a redirect instead of the inbox contents. Remove in the next
 * minor version.
 */
export function checkControllerMessagesTool() {
  return defineTool({
    description:
      'Deprecated — controller messages now arrive automatically as injected user messages. ' +
      'You do not need to call this tool.',
    parameters: z.object({}),
    execute: safeExecute('check_controller_messages', async () => {
      return '[DEPRECATED] Controller messages are injected automatically as "[Controller message]" user messages — no need to check. Do not call this tool again.';
    }),
  });
}
