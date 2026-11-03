import { describe, it, expect } from 'vitest';
import { createElement as h, useEffect } from 'react';
import { render } from 'ink';
import { SLASH_COMMANDS, useSlashCommands } from '@/tui/hooks/use-slash-commands';
import type { SlashCommandResult } from '@/tui/hooks/use-slash-commands';
import { renderShortcutList } from '@/tui/utils/shortcut-catalog';
import { ShortcutOverlay } from '@/tui/components/shortcut-overlay';
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

  it('shows the shortcut list through the styled overlay component', async () => {
    const handleCommand = await captureHandleCommand();
    const result = await handleCommand('/shortcut');

    // The styled rendering the UI shows: the overlay component, not a
    // hand-written string.
    expect(result.overlay?.kind).toBe('component');
    if (result.overlay?.kind === 'component') {
      expect((result.overlay.render() as { type: unknown }).type).toBe(ShortcutOverlay);
    }
    expect(result.overlay?.hint).toBe('(esc to dismiss)');
  });

  it('is case-insensitive like the other commands', async () => {
    const handleCommand = await captureHandleCommand();
    const result = await handleCommand('/SHORTCUT');

    expect(result.handled).toBe(true);
    expect(result.output).toBe(renderShortcutList());
  });
});
