import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineTool, safeExecute } from './common';

const DEFAULT_MAX_LINES = 500;

export function readFileTool(deps: { cwd?: string } = {}) {
  const workspace = deps.cwd ?? process.cwd();

  return defineTool({
    description: `Read file content (with line numbers). Returns at most ${DEFAULT_MAX_LINES} lines by default. Use offset (1-based start line) and limit to read specific sections of large files.`,
    parameters: z.object({
      path: z.string().describe('File path (relative to workspace or absolute)'),
      offset: z.number().int().min(1).optional().describe('Start line number (1-based)'),
      limit: z.number().int().min(1).optional().describe('Number of lines to read'),
    }),
    execute: safeExecute('read_file', async ({ path, offset, limit }) => {
      const resolved = resolve(workspace, path);
      const content = readFileSync(resolved, 'utf-8');
      const lines = content.split('\n');
      const totalLines = lines.length;
      const start = offset ? offset - 1 : 0;
      const effectiveLimit = limit ?? DEFAULT_MAX_LINES;
      const slice = lines.slice(start, start + effectiveLimit);
      const result = slice.map((line, i) => `${start + i + 1}\t${line}`).join('\n');

      const end = start + slice.length;
      if (end < totalLines) {
        return `${result}\n\n[Truncated: showing lines ${start + 1}-${end} of ${totalLines}. Use offset and limit to read more.]`;
      }
      return result;
    }),
  });
}
