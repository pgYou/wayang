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

/** Default workspace the /tasks and /projects mocks report. */
const DEFAULT_WORKSPACE = '/w/default';

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

describe('handleCommand /tasks', () => {
  const makeTask = (id: string, description: string): TaskDetail => ({
    id,
    title: 'title',
    description,
    priority: 'normal',
    status: 'completed',
    createdAt: 1,
  });

  const withTasks = (tasks: TaskDetail[]): RemoteSupervisor =>
    ({
      engine: { list: async () => tasks },
      ctx: { workspaceDir: DEFAULT_WORKSPACE, workspaces: [] },
    }) as unknown as RemoteSupervisor;

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

  it('keeps active tasks visible when the /tasks list is capped', async () => {
    const tasks: TaskDetail[] = [
      { ...makeTask('p-1', 'queued work'), status: 'pending' },
      { ...makeTask('r-1', 'running work'), status: 'running' },
      ...Array.from({ length: 30 }, (_, i) => makeTask(`h-${i}`, 'done')),
    ];
    const handleCommand = await captureWith(withTasks(tasks));

    const result = await handleCommand('/tasks');

    const lines = result.output!.split('\n');
    expect(lines).toHaveLength(21);
    expect(lines[0]).toContain('[pending] p-1: queued work');
    expect(lines[1]).toContain('[running] r-1: running work');
    expect(lines[20]).toBe('… 显示最近 20 / 共 32 条（另有 12 条历史未显示）');
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
      ctx: { workspaceDir: DEFAULT_WORKSPACE, workspaces: [] },
    } as unknown as RemoteSupervisor;
    const handleCommand = await captureWith(supervisor);

    expect((await handleCommand('/tasks')).output).toBe('No tasks');
    expect((await handleCommand('/tasks failed')).output).toContain('[completed] t-9: boom');
    expect(seen).toEqual([undefined, 'failed']);
  });

  it('shows worker type, elapsed time and error summary through /tasks', async () => {
    const now = Date.now();
    const tasks: TaskDetail[] = [
      {
        ...makeTask('t-run', 'scan repo'), status: 'running',
        workerType: 'puppet', startedAt: now - 5_000,
      },
      {
        ...makeTask('t-done', 'build'), status: 'completed',
        workerType: 'claude-code', startedAt: now - 20_000, completedAt: now - 8_000,
        result: 'all green',
      },
      {
        ...makeTask('t-fail', 'run tests'), status: 'failed',
        workerType: 'puppet', startedAt: now - 9_000, completedAt: now - 2_000,
        error: 'AssertionError: expected 1 to equal 2\n  at spec.ts:42',
      },
    ];
    const handleCommand = await captureWith(withTasks(tasks));

    const output = (await handleCommand('/tasks')).output!;
    const lines = output.split('\n');

    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('🧸 puppet');
    expect(lines[0]).toContain('已运行');
    expect(lines[1]).toContain('🤖 claude-code');
    expect(lines[1]).toContain('耗时');
    expect(lines[1]).toContain('→ all green');
    expect(lines[2]).toContain('✗ AssertionError: expected 1 to equal 2');
    expect(output).not.toContain('\n\n');
  });
});

describe('handleCommand /tasks workspace marks', () => {
  const taskIn = (workspace: { path: string; slug: string }): TaskDetail => ({
    id: 't-1',
    title: 'title',
    description: 'write tests',
    priority: 'normal',
    status: 'completed',
    createdAt: 1,
    workspace,
  });

  const withCtx = (tasks: TaskDetail[], workspaces: Array<{ path: string; slug: string }> = []): RemoteSupervisor =>
    ({
      engine: { list: async () => tasks },
      ctx: { workspaceDir: DEFAULT_WORKSPACE, workspaces },
    }) as unknown as RemoteSupervisor;

  it('shows the slug for a task dispatched outside the default workspace', async () => {
    const handleCommand = await captureWith(withCtx([taskIn({ path: '/w/other', slug: 'other' })]));

    expect((await handleCommand('/tasks')).output)
      .toBe('[completed] t-1: write tests — other');
  });

  it('leaves a default-workspace task unmarked', async () => {
    const handleCommand = await captureWith(withCtx([taskIn({ path: DEFAULT_WORKSPACE, slug: 'default' })]));

    expect((await handleCommand('/tasks')).output).toBe('[completed] t-1: write tests');
  });
});

describe('handleCommand /projects', () => {
  const withProjects = (
    workspaces: Array<{ path: string; slug: string }>,
    tasks: TaskDetail[] = [],
  ): RemoteSupervisor =>
    ({
      engine: { list: async () => tasks },
      ctx: { workspaceDir: DEFAULT_WORKSPACE, workspaces },
    }) as unknown as RemoteSupervisor;

  it('lists every session workspace as "<slug>  <path>" with the default marked', async () => {
    const handleCommand = await captureWith(withProjects([
      { path: '/w/alpha', slug: 'alpha' },
      { path: DEFAULT_WORKSPACE, slug: 'default' },
    ]));

    expect((await handleCommand('/projects')).output?.split('\n')).toEqual([
      'default  /w/default  *',
      'alpha  /w/alpha',
      '* = default workspace',
    ]);
  });

  it('picks up a workspace the session only used through a task', async () => {
    const handleCommand = await captureWith(withProjects(
      [{ path: DEFAULT_WORKSPACE, slug: 'default' }],
      [{ ...({
        id: 't-1', title: 't', description: 'd', priority: 'normal',
        status: 'completed', createdAt: 1,
      }), workspace: { path: '/w/late', slug: 'late' } } as TaskDetail],
    ));

    const lines = (await handleCommand('/projects')).output?.split('\n') ?? [];

    expect(lines[0]).toBe('default  /w/default  *');
    expect(lines[1]).toBe('late  /w/late');
  });

  it('prints "No projects" without any workspace data', async () => {
    const handleCommand = await captureWith({
      engine: { list: async () => [] },
      ctx: { workspaceDir: '', workspaces: [] },
    } as unknown as RemoteSupervisor);

    expect((await handleCommand('/projects')).output).toBe('No projects');
  });

  it('is registered, listed in /help, and does not collide with /workspaces', async () => {
    const names = SLASH_COMMANDS.map(command => command.name);
    expect(names).toContain('projects');
    expect(names).not.toContain('workspaces');

    const handleCommand = await captureWith(withProjects([{ path: DEFAULT_WORKSPACE, slug: 'default' }]));
    const help = (await handleCommand('/help')).output ?? '';

    expect(help).toContain('/projects');
  });
});
