import { z } from 'zod';
import type { TaskDetail } from '@/types/index';
import { clampToolOutput, resolveToolOutputMaxChars } from '@/services/agents/utils/tool-output-clamp';
import { defineTool, safeExecute } from './common';

export function listTasksTool(deps: { listTasks: (status?: TaskDetail['status']) => TaskDetail[] }) {
  // Single source of truth for the tool-output cap (WAYANG_TOOL_OUTPUT_MAX_CHARS,
  // default 20000). Bound once so field-level clamps, the whole-output clamp
  // and safeExecute's guard all agree on the same limit.
  const maxChars = resolveToolOutputMaxChars();
  return defineTool({
    description: 'View the task list',
    parameters: z.object({
      status: z.enum(['pending', 'running', 'completed', 'failed', 'cancelled']).optional()
        .describe('Filter by status'),
    }),
    execute: safeExecute('list_tasks', async ({ status }) => {
      const tasks = deps.listTasks(status);
      if (tasks.length === 0) return status ? `No ${status} tasks` : 'No tasks';
      const body = tasks.map(t => {
        // Workspace slug is additive: older tasks have no identity, so the
        // parenthetical stays exactly as before for them.
        const scope = t.workspace ? `, ws: ${t.workspace.slug}` : '';
        // Task-scoped extra directories, shown only when the task has any.
        const dirs = t.taskAllowedDirs && t.taskAllowedDirs.length > 0
          ? `, dirs: ${t.taskAllowedDirs.join(', ')}`
          : '';
        // result / error are free-form worker output: clamp each to the shared
        // tool-output cap (head + tail kept, omission marked) so a multi-KB
        // report or stack trace cannot bloat the controller's context.
        const result = t.result ? ` → ${clampToolOutput(t.result, maxChars)}` : '';
        const error = t.error ? ` ✗ ${clampToolOutput(t.error, maxChars)}` : '';
        return `[${t.status}] ${t.id} (worker: ${t.workerSessionId ?? 'none'}${scope}${dirs}): ${t.description}${result}${error}`;
      }).join('\n');
      // Field clamps bound each result/error, but several long fields joined
      // together can still exceed the cap. Clamp the whole output once more so
      // safeExecute's coarse head-only truncate never fires and the head/tail
      // omission markers survive in the text the controller actually sees.
      return clampToolOutput(body, maxChars);
    }, { maxResultChars: maxChars }),
  });
}
