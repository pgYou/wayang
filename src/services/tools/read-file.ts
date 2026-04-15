import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineTool, safeExecute, validatePath } from './common';

export function readFileTool(deps: { cwd?: string } = {}) {
  const workspace = deps.cwd ?? process.cwd();

  return defineTool({
    description: 'Read file content. Path must be within the workspace.',
    parameters: z.object({
      path: z.string().describe('File path (relative to workspace)'),
    }),
    execute: safeExecute('read_file', async ({ path }) => {
      const resolved = resolve(workspace, path);
      const err = validatePath(resolved, workspace);
      if (err) return `[ERROR] read_file: ${err}`;

      return readFileSync(resolved, 'utf-8');
    }),
  });
}
