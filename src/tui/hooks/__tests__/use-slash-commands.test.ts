import { describe, it, expect } from 'vitest';
import { createElement as h, useEffect } from 'react';
import { render } from 'ink';
import { SLASH_COMMANDS, useSlashCommands } from '@/tui/hooks/use-slash-commands';
import type { SlashCommandResult } from '@/tui/hooks/use-slash-commands';
import { renderShortcutList } from '@/tui/utils/shortcut-catalog';
import type { TaskDetail } from '@/types/index';
import type { RemoteSupervisor } from '@/client/remote-supervisor';

describe('SLASH_COMMANDS', () => {
  it('should register the /context command', () => {
    const context = SLASH_COMMANDS.find(c => c.name === 'context');

    expect(context).toBeDefined();
    expect(context?.description).toBe('Show context token breakdown');
    // Takes no arguments.
    expect((context as { args?: string }).args).toBeUndefined();
  });

  it('should register the /shortcut command', () => {
    const shortcut = SLASH_COMMANDS.find(c => c.name === 'shortcut');

    expect(shortcut).toBeDefined();
    expect(shortcut?.description).toBe('Show keyboard shortcuts');
    // Takes no arguments.
    expect((shortcut as { args?: string }).args).toBeUndefined();
  });

  it('should keep command names unique', () => {
    const names = SLASH_COMMANDS.map(c => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('should still expose the pre-existing commands', () => {
    const names = SLASH_COMMANDS.map(c => c.name);
    expect(names).toEqual(expect.arrayContaining(['tasks', 'workers', 'cancel', 'compact', 'exit', 'help']));
  });
});

describe('handleCommand /shortcut', () => {
  /**
   * Render a probe that runs the hook and captures its handleCommand. The
   * hook needs a component context (useMemoizedFn uses refs), so a minimal
   * ink render stands in; /shortcut never touches the supervisor, so an
   * empty stand-in is enough.
   */
  async function captureHandleCommand(): Promise<(input: string) => Promise<SlashCommandResult>> {
    const box: { fn?: (input: string) => Promise<SlashCommandResult> } = {};
    function Probe() {
      const { handleCommand } = useSlashCommands({} as unknown as RemoteSupervisor);
      useEffect(() => {
        box.fn = handleCommand;
      }, [handleCommand]);
      return null;
    }
    const stdout = {
      columns: 80,
      rows: 24,
      write: () => true,
      on() { return stdout; },
      off() { return stdout; },
      removeListener() { return stdout; },
    };
    const app = render(h(Probe), {
      stdout: stdout as unknown as NodeJS.WriteStream,
      debug: true,
      patchConsole: false,
    });
    await new Promise<void>(resolve => setImmediate(resolve));
    app.unmount();
    if (!box.fn) throw new Error('handleCommand was never captured');
    return box.fn;
  }

  it('answers with the rendered shortcut catalog', async () => {
    const handleCommand = await captureHandleCommand();
    const result = await handleCommand('/shortcut');

    expect(result.handled).toBe(true);
    // Same table the catalog renders — no second hand-written copy.
    expect(result.output).toBe(renderShortcutList());
    expect(result.output).toContain('Ctrl+J');
    expect(result.output).toContain('Ctrl+U');
    expect(result.output).toContain('Esc');
    expect(result.output).toContain('Ctrl+C');
  });

  it('is case-insensitive like the other commands', async () => {
    const handleCommand = await captureHandleCommand();
    const result = await handleCommand('/SHORTCUT');

    expect(result.handled).toBe(true);
    expect(result.output).toBe(renderShortcutList());
  });
});

describe('handleCommand /tasks', () => {
  /** Same probe as above, but with an injectable supervisor stand-in. */
  async function captureWith(
    supervisor: RemoteSupervisor,
  ): Promise<(input: string) => Promise<SlashCommandResult>> {
    const box: { fn?: (input: string) => Promise<SlashCommandResult> } = {};
    function Probe() {
      const { handleCommand } = useSlashCommands(supervisor);
      useEffect(() => {
        box.fn = handleCommand;
      }, [handleCommand]);
      return null;
    }
    const stdout = {
      columns: 80,
      rows: 24,
      write: () => true,
      on() { return stdout; },
      off() { return stdout; },
      removeListener() { return stdout; },
    };
    const app = render(h(Probe), {
      stdout: stdout as unknown as NodeJS.WriteStream,
      debug: true,
      patchConsole: false,
    });
    await new Promise<void>(resolve => setImmediate(resolve));
    app.unmount();
    if (!box.fn) throw new Error('handleCommand was never captured');
    return box.fn;
  }

  const makeTask = (id: string, description: string): TaskDetail => ({
    id,
    title: 'title',
    description,
    priority: 'normal',
    status: 'completed',
    createdAt: 1,
  });

  const withTasks = (tasks: TaskDetail[]): RemoteSupervisor =>
    ({ engine: { list: async () => tasks } }) as unknown as RemoteSupervisor;

  it('renders one line per task with a digested description', async () => {
    const long = 'instruction '.repeat(500);
    const handleCommand = await captureWith(withTasks([makeTask('t-1', long)]));

    const result = await handleCommand('/tasks');

    expect(result.handled).toBe(true);
    expect(result.output!.split('\n')).toHaveLength(1);
    expect(result.output).toContain('[completed] t-1: instruction instruction');
    expect(result.output).toContain('…');
    // The full instruction must never reach the renderer.
    expect(result.output).not.toContain(long);
  });

  it('caps the list at 20 rows and reports the real total', async () => {
    const tasks = Array.from({ length: 57 }, (_, i) => makeTask(`t-${i}`, 'a\nb\ndo the thing'));
    const handleCommand = await captureWith(withTasks(tasks));

    const result = await handleCommand('/tasks');

    const lines = result.output!.split('\n');
    expect(lines).toHaveLength(21);
    expect(lines[20]).toBe('… 显示最近 20 / 共 57 条');
    expect(result.output).not.toContain('\n\n');
  });

  it('still reports an empty list and keeps the status filter', async () => {
    const seen: Array<string | undefined> = [];
    const supervisor = {
      engine: {
        list: async (status?: string) => {
          seen.push(status);
          return status === 'failed' ? [makeTask('t-9', 'boom')] : [];
        },
      },
    } as unknown as RemoteSupervisor;
    const handleCommand = await captureWith(supervisor);

    expect((await handleCommand('/tasks')).output).toBe('No tasks');
    expect((await handleCommand('/tasks failed')).output).toContain('[completed] t-9: boom');
    expect(seen).toEqual([undefined, 'failed']);
  });
});
