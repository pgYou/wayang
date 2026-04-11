import { z } from 'zod';
import { defineTool, safeExecute } from './common';

/**
 * Skip-reply tool — allows the Controller to acknowledge a signal without
 * producing any user-visible output. UI skips rendering these entries.
 */
export function skipReplyTool() {
  return defineTool({
    description: 'Acknowledge a signal without responding to the user. Call this when you receive a PROGRESS signal and have nothing meaningful to say. The user will not see anything.',
    parameters: z.object({}),
    execute: safeExecute('skip_reply', async () => {
      return '(skipped)';
    }),
  });
}
