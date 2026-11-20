import { z } from 'zod';
import { defineTool, safeExecute } from './common';

/**
 * Skip-reply tool — allows the Controller to acknowledge a signal without
 * producing any user-visible output. UI skips rendering these entries.
 */
export function skipReplyTool() {
  return defineTool({
    description: 'Acknowledge a signal without responding to the user. IMPORTANT: this tool terminates the turn immediately. You MUST NOT output any text in the same response — your response must contain ONLY this tool call. Any co-emitted text will leak to the user as a broken message.',
    parameters: z.object({}),
    execute: safeExecute('skip_reply', async () => {
      return '(skipped)';
    }),
  });
}
