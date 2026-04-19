import { z } from 'zod';
import { defineTool, safeExecute } from './common';
import type { InboxMessage } from '@/services/agents/worker-state';

export interface CheckMessagesToolDeps {
  drainInbox: () => InboxMessage[];
}

export function checkControllerMessagesTool(deps: CheckMessagesToolDeps) {
  return defineTool({
    description:
      'Check for messages from the controller. Call this periodically during execution — ' +
      'at the start of each major phase, before long-running operations, or when you encounter ' +
      'an unexpected situation. Returns pending messages and clears the inbox. Returns "No messages." if empty.',
    parameters: z.object({}),
    execute: safeExecute('check_controller_messages', async () => {
      const messages = deps.drainInbox();
      if (messages.length === 0) return 'No messages.';
      return messages.map(m => `[Controller] ${m.content}`).join('\n');
    }),
  });
}
