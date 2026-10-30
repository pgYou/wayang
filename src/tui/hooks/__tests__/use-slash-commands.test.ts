import { describe, it, expect } from 'vitest';
import { SLASH_COMMANDS } from '@/tui/hooks/use-slash-commands';

describe('SLASH_COMMANDS', () => {
  it('should register the /context command', () => {
    const context = SLASH_COMMANDS.find(c => c.name === 'context');

    expect(context).toBeDefined();
    expect(context?.description).toBe('Show context token breakdown');
    // Takes no arguments.
    expect((context as { args?: string }).args).toBeUndefined();
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
