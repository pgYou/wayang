import { z } from 'zod';
import { defineTool, safeExecute } from './common';

export interface UpdateProgressDeps {
  /** Report progress for the current task. */
  reportProgress: (message: string, percent?: number) => void;
}

export function updateProgressTool(deps: UpdateProgressDeps) {
  return defineTool({
    description: 'Report progress for the current task (replaces automatic step-based progress)',
    parameters: z.object({
      message: z.string().describe('Progress description'),
      percent: z.number().min(0).max(100).optional().describe('Completion percentage (0-100)'),
    }),
    execute: safeExecute('update_progress', async ({ message, percent }) => {
      deps.reportProgress(message, percent);
      const suffix = percent !== undefined ? ` (${percent}%)` : '';
      return `Progress reported: ${message}${suffix}`;
    }),
  });
}
