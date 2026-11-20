import { z } from 'zod';
import { defineTool, safeExecute } from './common';

export interface DoneToolDeps {
  onComplete: (summary: string) => void;
}

export function doneTool(deps: DoneToolDeps) {
  return defineTool({
    description: 'Report task completion. Worker stops executing after this call.',
    parameters: z.object({
      summary: z.string().describe('Task completion summary'),
    }),
    execute: safeExecute('done', async ({ summary }: { summary: string }) => {
      deps.onComplete(summary);
      return `Task completed: ${summary}`;
    }),
  });
}
