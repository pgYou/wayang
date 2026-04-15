import { z } from 'zod';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { defineTool, safeExecute, validatePath } from './common';

export function writeFileTool(deps: { cwd?: string } = {}) {
  const workspace = deps.cwd ?? process.cwd();

  return defineTool({
    description: 'Create a new file with the given content. Creates parent directories as needed. Use edit_file to modify existing files. Path must be within the workspace.',
    parameters: z.object({
      path: z.string().describe('File path (relative to workspace)'),
      content: z.string().describe('File content'),
    }),
    execute: safeExecute('write_file', async ({ path, content }) => {
      const resolved = resolve(workspace, path);
      const err = validatePath(resolved, workspace);
      if (err) return `[ERROR] write_file: ${err}`;

      if (existsSync(resolved)) {
        return `[ERROR] write_file: File already exists: ${path}. Use edit_file to modify existing files.`;
      }

      mkdirSync(dirname(resolved), { recursive: true });
      writeFileSync(resolved, content, 'utf-8');
      return `Written ${content.length} chars to ${resolved}`;
    }),
  });
}
