import { z } from 'zod';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { defineTool, safeExecute } from './common';
import { expandHome } from './permission-rules';

export function writeFileTool(deps: { cwd?: string } = {}) {
  const workspace = deps.cwd ?? process.cwd();

  return defineTool({
    description: 'Create a new file with the given content. Creates parent directories as needed. Use edit_file to modify existing files.',
    parameters: z.object({
      path: z.string().describe('File path (relative to workspace or absolute)'),
      content: z.string().describe('File content'),
    }),
    execute: safeExecute('write_file', async ({ path, content }) => {
      // `~` / `$HOME` expand against the PROCESS home — the same anchor the
      // permission gate judges (`expandHome`), so an approved write lands on
      // the path that was approved, not on a literal `~` directory inside the
      // workspace.
      const resolved = resolve(workspace, expandHome(path).path);
      if (existsSync(resolved)) {
        return `[ERROR] write_file: File already exists: ${path}. Use edit_file to modify existing files.`;
      }

      mkdirSync(dirname(resolved), { recursive: true });
      writeFileSync(resolved, content, 'utf-8');
      return `Written ${content.length} chars to ${resolved}`;
    }),
  });
}
