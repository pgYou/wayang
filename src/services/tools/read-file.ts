import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { defineTool, safeExecute } from './common';

/** Validate that resolved path stays within workspace. */
function validatePath(resolved: string, workspace: string): string | null {
  const rel = relative(workspace, resolved);
  if (rel.startsWith('..') || resolve(workspace, rel) !== resolved) {
    return `Path escapes workspace: ${resolved} (workspace: ${workspace})`;
  }
  return null;
}

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
