import { z } from 'zod';
import { defineTool, safeExecute } from './common';

export function readNotebookTool(deps: { getNotebook: () => string }) {
  return defineTool({
    description:
      'Read the current notebook content. The notebook is a private scratchpad that persists across context compaction — use it to store plans, notes, and working context.',
    parameters: z.object({}),
    execute: safeExecute('read_notebook', async () => {
      const content = deps.getNotebook();
      return content || '(notebook is empty)';
    }),
  });
}

export function updateNotebookTool(deps: {
  setNotebook: (content: string, mode: 'replace' | 'append') => void;
}) {
  return defineTool({
    description:
      'Update the notebook content. Use "replace" to overwrite the entire notebook, or "append" to add to the end. The notebook persists across context compaction.',
    parameters: z.object({
      content: z.string().describe('Content to write'),
      mode: z
        .enum(['replace', 'append'])
        .optional()
        .describe('Write mode: "replace" overwrites, "append" adds to the end (default: replace)'),
    }),
    execute: safeExecute('update_notebook', async ({ content, mode }) => {
      deps.setNotebook(content, mode ?? 'replace');
      return `Notebook updated (${mode ?? 'replace'} mode, ${content.length} chars)`;
    }),
  });
}
