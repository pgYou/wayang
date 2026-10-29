import { useMemoizedFn } from './use-memoized-fn';
import type { RemoteSupervisor } from '@/client/remote-supervisor';
import type { TaskDetail } from '@/types/index';

/** Slash command definitions for autocomplete suggestions. */
export const SLASH_COMMANDS = [
  { name: 'tasks', args: '[status]', description: 'List tasks' },
  { name: 'workers', description: 'List active workers' },
  { name: 'cancel', args: '<id>', description: 'Cancel a task' },
  { name: 'compact', description: 'Compact context' },
  { name: 'exit', description: 'Quit' },
  { name: 'help', description: 'Show help' },
] as const;

export interface SlashCommandResult {
  handled: boolean;
  output?: string;
  /** Trigger an async action after command handling. */
  action?: 'compact' | 'workers';
}

export function useSlashCommands(supervisor: RemoteSupervisor) {
  const handleCommand = useMemoizedFn(async (input: string): Promise<SlashCommandResult> => {
    if (!input.startsWith('/')) return { handled: false };

    const parts = input.slice(1).split(/\s+/);
    const cmd = parts[0]?.toLowerCase();

    switch (cmd) {
      case 'exit':
      case 'quit':
        return { handled: true, output: '__EXIT__' };

      case 'tasks': {
        const status = parts[1] as TaskDetail['status'] | undefined;
        const tasks = await supervisor.engine.list(status);
        if (tasks.length === 0) return { handled: true, output: 'No tasks' };
        const lines = tasks.map(t =>
          `[${t.status}] ${t.id}: ${t.description}${t.result ? ` → ${t.result}` : ''}`,
        );
        return { handled: true, output: lines.join('\n') };
      }

      case 'workers': {
        const activeWorkers = supervisor.engine.getActiveWorkers();
        if (!activeWorkers || activeWorkers.length === 0) {
          return { handled: true, output: 'No active workers' };
        }
        const lines = activeWorkers.map(w =>
          `${w.workerId} [${w.status}] → task ${w.taskId ?? '-'}`,
        );
        return { handled: true, output: lines.join('\n') };
      }

      case 'cancel': {
        const taskId = parts[1];
        if (!taskId) {
          return { handled: true, output: 'Usage: /cancel <taskId>' };
        }
        await supervisor.engine.cancel(taskId);
        return { handled: true, output: `Task ${taskId} cancelled` };
      }

      case 'compact':
        return { handled: true, action: 'compact', output: 'Compacting context...' };

      case 'help':
        return {
          handled: true,
          output: [
            'Commands:',
            '  /tasks [status]   — List tasks',
            '  /workers          — List active workers',
            '  /cancel <id>      — Cancel a task and abort its worker',
            '  /compact          — Compact conversation context',
            '  /exit             — Quit',
            '  /help             — Show this help',
          ].join('\n'),
        };

      default:
        return { handled: true, output: `Unknown command: /${cmd}. Type /help for commands.` };
    }
  });

  return { handleCommand };
}
