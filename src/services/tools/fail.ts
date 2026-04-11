import { z } from 'zod';
import { defineTool, safeExecute } from './common';

export interface FailToolDeps {
  onFail: (error: string) => void;
}

export function failTool(deps: FailToolDeps) {
  return defineTool({
    description: 'Report task failure. Worker stops executing after this call.',
    parameters: z.object({
      error: z.string().describe('Error description'),
    }),
    execute: safeExecute('fail', async ({ error }: { error: string }) => {
      deps.onFail(error);
      return `Task failed: ${error}`;
    }),
  });
}
