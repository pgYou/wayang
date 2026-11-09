import { useMemoizedFn } from './use-memoized-fn';
import type { RemoteSupervisor } from '@/client/remote-supervisor';
import type { TaskDetail } from '@/types/index';
import { formatContextReport } from '@/tui/utils/context-report';
import { renderShortcutList } from '@/tui/utils/shortcut-catalog';
import { formatTaskList } from '@/tui/utils/task-list';
import { formatTaskDetail, resolveTaskRef } from '@/tui/utils/task-detail';
import { formatWorkerList } from '@/tui/utils/worker-list';
import { formatProjectList } from '@/tui/utils/workspace-display';

/** Slash command definitions for autocomplete suggestions. */
export const SLASH_COMMANDS = [
  { name: 'tasks', args: '[status] | <id>', description: 'List tasks or show task detail' },
  { name: 'workers', description: 'List active workers' },
  { name: 'projects', description: 'List session workspaces' },
  { name: 'cancel', args: '<id>', description: 'Cancel a task' },
  { name: 'context', description: 'Show context token breakdown' },
  { name: 'compact', description: 'Compact context' },
  { name: 'exit', description: 'Quit' },
  { name: 'help', description: 'Show help' },
  { name: 'shortcut', description: 'Show keyboard shortcuts' },
] as const;

/** Statuses `/tasks <arg>` interprets as a filter rather than a task reference. */
const TASK_STATUSES: ReadonlySet<string> = new Set([
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled',
]);

export interface SlashCommandResult {
  handled: boolean;
  output?: string;
  /** Trigger an async action after command handling. */
  action?: 'compact' | 'workers';
}

/**
 * Per-invocation rendering context. `width` is the overlay panel's inner width
 * in display columns (terminal width minus border and padding) — row formatters
 * use it to keep every line a single physical line at any terminal size.
 */
export interface SlashCommandContext {
  width?: number;
}

export function useSlashCommands(supervisor: RemoteSupervisor) {
  const handleCommand = useMemoizedFn(
    async (input: string, context: SlashCommandContext = {}): Promise<SlashCommandResult> => {
      if (!input.startsWith('/')) return { handled: false };

      const parts = input.slice(1).split(/\s+/);
      const cmd = parts[0]?.toLowerCase();

      switch (cmd) {
        case 'exit':
        case 'quit':
          return { handled: true, output: '__EXIT__' };

        case 'tasks': {
          const arg = parts[1];
          // `/tasks <ref>` (non-status argument) shows one task in detail: the
          // full description/error/result, worker session ids and timestamps
          // the one-line list cannot carry.
          if (arg !== undefined && !TASK_STATUSES.has(arg.toLowerCase())) {
            const tasks = await supervisor.engine.list();
            const resolved = resolveTaskRef(tasks, arg);
            return {
              handled: true,
              output: 'task' in resolved
                ? formatTaskDetail(resolved.task, { width: context.width })
                : resolved.error,
            };
          }
          const status = arg?.toLowerCase() as TaskDetail['status'] | undefined;
          const tasks = await supervisor.engine.list(status);
          if (tasks.length === 0) return { handled: true, output: 'No tasks' };
          // Descriptions are digested to one line each and the list is capped —
          // rendering full instructions verbatim hung Ink's re-layout. See
          // task-list.ts; every other column is unchanged. Only tasks running
          // outside the session's default workspace are marked with a slug.
          return {
            handled: true,
            output: formatTaskList(tasks, {
              defaultWorkspacePath: supervisor.ctx.workspaceDir,
              rowMaxWidth: context.width,
            }),
          };
        }

        case 'projects': {
          // Session workspaces (`ctx.workspaces`) plus the workspaces stamped on
          // this session's tasks — the task list is the only place a workspace
          // first touched mid-session shows up, since ctx.workspaces is a
          // bootstrap snapshot. Which is why /projects is not a plain echo of it.
          const tasks = await supervisor.engine.list();
          return {
            handled: true,
            output: formatProjectList({
              workspaces: supervisor.ctx.workspaces,
              taskWorkspaces: tasks.map(task => task.workspace ?? {}),
              defaultWorkspacePath: supervisor.ctx.workspaceDir,
            }),
          };
        }

        case 'workers': {
          const activeWorkers = supervisor.engine.getActiveWorkers();
          if (!activeWorkers || activeWorkers.length === 0) {
            return { handled: true, output: 'No active workers' };
          }
          return {
            handled: true,
            output: formatWorkerList(activeWorkers, { rowMaxWidth: context.width }),
          };
        }

        case 'cancel': {
          const ref = parts[1];
          if (!ref) {
            return { handled: true, output: 'Usage: /cancel <taskId>' };
          }
          // The reference accepts what the panels show: full id, `#tail`
          // handle or unique prefix. Ambiguous/unknown refs resolve to an
          // error instead of a silent no-op.
          const tasks = await supervisor.engine.list();
          const resolved = resolveTaskRef(tasks, ref);
          if (!('task' in resolved)) {
            return { handled: true, output: resolved.error };
          }
          await supervisor.engine.cancel(resolved.task.id);
          return { handled: true, output: `Task ${resolved.task.id} cancelled` };
        }

        case 'context': {
          // Fetched on demand from the server (GET_SNAPSHOT) — no LLM call, no
          // disk writes, no session mutation.
          const usage = await supervisor.getContextUsage();
          if (!usage) {
            return { handled: true, output: 'Context · no data yet (run a turn first)' };
          }
          return { handled: true, output: formatContextReport(usage).join('\n') };
        }

        case 'compact':
          return { handled: true, action: 'compact', output: 'Compacting context...' };

        case 'help':
          return {
            handled: true,
            output: [
              'Commands:',
              '  /tasks [status|id] — List tasks, or show one task in detail (id, prefix or #tail)',
              '  /workers          — List active workers (type, task, elapsed)',
              '  /projects         — List session workspaces (* = default workspace)',
              '  /cancel <id>      — Cancel a task and abort its worker',
              '  /context          — Show context token breakdown',
              '  /compact          — Compact conversation context',
              '  /exit             — Quit',
              '  /help             — Show this help',
              '  /shortcut         — Show keyboard shortcuts',
            ].join('\n'),
          };

        case 'shortcut':
          // Rendered from the shortcut catalog — the single table both this
          // output and the keybinding survey are generated from.
          return { handled: true, output: renderShortcutList() };

        default:
          return { handled: true, output: `Unknown command: /${cmd}. Type /help for commands.` };
      }
    },
  );

  return { handleCommand };
}
