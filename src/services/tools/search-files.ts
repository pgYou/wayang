import fg from 'fast-glob';
import { resolve } from 'node:path';
import { z } from 'zod';
import { defineTool, safeExecute, validatePath } from './common';

export function searchFilesTool(deps: { cwd?: string }) {
  const workspace = deps.cwd ?? process.cwd();

  return defineTool({
    description:
      'Search for files matching a glob pattern. Returns matching file paths relative to workspace.',
    parameters: z.object({
      pattern: z
        .string()
        .describe('Glob pattern (e.g. "**/*.ts", "src/**/*.test.ts")'),
      path: z
        .string()
        .optional()
        .describe('Base directory for search (default: workspace root)'),
    }),
    execute: safeExecute('search_files', async ({ pattern, path }) => {
      const basePath = path ? resolve(workspace, path) : workspace;
      const err = validatePath(basePath, workspace);
      if (err) return `[ERROR] search_files: ${err}`;

      const entries = await fg(pattern, {
        cwd: basePath,
        onlyFiles: true,
        ignore: ['node_modules', '.git'],
      });

      if (entries.length === 0) return 'No files matched the pattern';
      return entries.join('\n');
    }),
  });
}
