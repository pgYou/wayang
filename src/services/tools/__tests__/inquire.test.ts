import { describe, it, expect } from 'vitest';
import { inquireTool } from '@/services/tools/inquire';

async function exec(toolObj: any, args: any): Promise<string> {
  return toolObj.execute(args);
}

describe('inquireTool', () => {
  it('should return the user answer for confirm type', async () => {
    const tool = inquireTool({
      inquire: async (q) => {
        expect(q.type).toBe('confirm');
        expect(q.message).toBe('Proceed?');
        return 'Yes';
      },
    });
    const result = await exec(tool, { message: 'Proceed?', type: 'confirm' });
    expect(result).toBe('Yes');
  });

  it('should pass options for select type', async () => {
    const tool = inquireTool({
      inquire: async (q) => {
        expect(q.type).toBe('select');
        expect(q.options).toEqual(['A', 'B', 'C']);
        return 'B';
      },
    });
    const result = await exec(tool, {
      message: 'Choose one',
      type: 'select',
      options: ['A', 'B', 'C'],
    });
    expect(result).toBe('B');
  });

  it('should pass default value', async () => {
    const tool = inquireTool({
      inquire: async (q) => {
        expect(q.default).toBe('react');
        return q.default!;
      },
    });
    const result = await exec(tool, {
      message: 'Framework?',
      type: 'text',
      default: 'react',
    });
    expect(result).toBe('react');
  });

  it('should handle errors via safeExecute', async () => {
    const tool = inquireTool({
      inquire: async () => { throw new Error('User cancelled'); },
    });
    const result = await exec(tool, { message: 'test', type: 'text' });
    expect(result).toContain('[ERROR]');
    expect(result).toContain('User cancelled');
  });
});
