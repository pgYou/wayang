import { z } from 'zod';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { defineTool, safeExecute } from './common';

/** Validate that resolved path stays within workspace. */
function validatePath(resolved: string, workspace: string): string | null {
  const rel = relative(workspace, resolved);
  if (rel.startsWith('..') || resolve(workspace, rel) !== resolved) {
    return `Path escapes workspace: ${resolved} (workspace: ${workspace})`;
  }
  return null;
}

export function writeFileTool(deps: { cwd?: string } = {}) {
  const workspace = deps.cwd ?? process.cwd();

  return defineTool({
    description: 'Write content to a file, creating parent directories as needed. Path must be within the workspace.',
    parameters: z.object({
      path: z.string().describe('File path (relative to workspace)'),
      content: z.string().describe('File content'),
    }),
    execute: safeExecute('write_file', async ({ path, content }) => {
      const resolved = resolve(workspace, path);
      const err = validatePath(resolved, workspace);
      if (err) return `[ERROR] write_file: ${err}`;

      mkdirSync(dirname(resolved), { recursive: true });
      writeFileSync(resolved, content, 'utf-8');
      return `Written ${content.length} chars to ${resolved}`;
    }),
  });
}
