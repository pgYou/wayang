import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { defineTool, safeExecute, validatePath } from './common';

export function editFileTool(deps: { cwd?: string }) {
  const workspace = deps.cwd ?? process.cwd();

  return defineTool({
    description:
      'Edit a file by replacing a unique string. old_string must appear exactly once in the file — if it matches multiple times, expand the surrounding context to make it unique.',
    parameters: z.object({
      path: z.string().describe('File path (relative to workspace)'),
      old_string: z
        .string()
        .describe('Exact text to find (must be unique in file)'),
      new_string: z.string().describe('Replacement text'),
    }),
    execute: safeExecute('edit_file', async ({ path, old_string, new_string }) => {
      const resolved = resolve(workspace, path);
      const err = validatePath(resolved, workspace);
      if (err) return `[ERROR] edit_file: ${err}`;

      let content: string;
      try {
        content = readFileSync(resolved, 'utf-8');
      } catch {
        return `[ERROR] edit_file: File not found: ${path}`;
      }

      const count = content.split(old_string).length - 1;
      if (count === 0)
        return `[ERROR] edit_file: old_string not found in ${path}`;
      if (count > 1)
        return `[ERROR] edit_file: old_string found ${count} times in ${path}. Provide more surrounding context to make it unique.`;

      const newContent = content.replace(old_string, new_string);
      writeFileSync(resolved, newContent, 'utf-8');
      return `Replaced ${old_string.length} chars with ${new_string.length} chars in ${path}`;
    }),
  });
}
