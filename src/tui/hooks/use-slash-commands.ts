import { useMemoizedFn } from './use-memoized-fn';
import type { Supervisor } from '@/services/supervisor';
import type { TaskDetail, ActiveWorkerInfo } from '@/types/index';

/** Slash command definitions for autocomplete suggestions. */
export const SLASH_COMMANDS = [
  { name: 'tasks', args: '[status]', description: 'List tasks' },
  { name: 'workers', description: 'List active workers' },
  { name: 'worker', args: '[id]', description: 'View worker detail' },
  { name: 'cancel', args: '<id>', description: 'Cancel a task' },
  { name: 'compact', description: 'Compact context' },
  { name: 'exit', description: 'Quit' },
  { name: 'help', description: 'Show help' },
] as const;

export interface SlashCommandContext {
  navigate: (route: { page: 'controller' } | { page: 'worker'; workerId: string }) => void;
}

export interface SlashCommandResult {
  handled: boolean;
  output?: string;
  /** Trigger an async action after command handling. */
  action?: 'compact' | 'workers';
  /** Navigate to a different route. */
  navigate?: { page: 'worker'; workerId: string };
}

export function useSlashCommands(supervisor: Supervisor, ctx: SlashCommandContext) {
  const handleCommand = useMemoizedFn((input: string): SlashCommandResult => {
    if (!input.startsWith('/')) return { handled: false };

    const parts = input.slice(1).split(/\s+/);
    const cmd = parts[0]?.toLowerCase();

    switch (cmd) {
      case 'exit':
      case 'quit':
        return { handled: true, output: '__EXIT__' };

      case 'tasks': {
        const status = parts[1] as TaskDetail['status'] | undefined;
        const tasks = supervisor.taskPool.list(status);
        if (tasks.length === 0) return { handled: true, output: 'No tasks' };
        const lines = tasks.map(t =>
          `[${t.status}] ${t.id}: ${t.description}${t.result ? ` → ${t.result}` : ''}`,
        );
        return { handled: true, output: lines.join('\n') };
      }

      case 'workers': {
        return { handled: true, action: 'workers' };
      }

      case 'worker': {
        const workerId = parts[1];
        if (!workerId) {
          // List all workers
          const activeWorkers = supervisor.controllerState.get<ActiveWorkerInfo[]>('runtimeState.activeWorkers');
          if (!activeWorkers || activeWorkers.length === 0) {
            return { handled: true, output: 'No active workers. Usage: /worker <id>' };
          }
          const lines = activeWorkers.map(w =>
            `${w.workerId} → task ${w.taskId}`,
          );
          return { handled: true, output: lines.join('\n') };
        }
        return { handled: true, navigate: { page: 'worker', workerId } };
      }

      case 'cancel': {
        const taskId = parts[1];
        if (!taskId) {
          return { handled: true, output: 'Usage: /cancel <taskId>' };
        }
        supervisor.taskPool.cancel(taskId);
        supervisor.abortWorkerByTaskId(taskId);
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
            '  /worker [id]      — View worker detail or list all',
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
