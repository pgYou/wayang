import { describe, it, expect } from 'vitest';
import { readNotebookTool, updateNotebookTool } from '@/services/tools/notebook';

async function exec(toolObj: any, args: any): Promise<string> {
  return toolObj.execute(args);
}

describe('readNotebookTool', () => {
  it('should return notebook content', async () => {
    const tool = readNotebookTool({ getNotebook: () => 'my plan notes' });
    const result = await exec(tool, {});
    expect(result).toBe('my plan notes');
  });

  it('should return empty message when notebook is empty', async () => {
    const tool = readNotebookTool({ getNotebook: () => '' });
    const result = await exec(tool, {});
    expect(result).toBe('(notebook is empty)');
  });
});

describe('updateNotebookTool', () => {
  it('should call setNotebook with replace mode', async () => {
    const calls: Array<{ content: string; mode: string }> = [];
    const tool = updateNotebookTool({
      setNotebook: (content, mode) => calls.push({ content, mode }),
    });
    const result = await exec(tool, { content: 'new content' });
    expect(calls).toEqual([{ content: 'new content', mode: 'replace' }]);
    expect(result).toContain('replace');
    expect(result).toContain('11 chars');
  });

  it('should call setNotebook with append mode', async () => {
    const calls: Array<{ content: string; mode: string }> = [];
    const tool = updateNotebookTool({
      setNotebook: (content, mode) => calls.push({ content, mode }),
    });
    const result = await exec(tool, { content: 'appended', mode: 'append' });
    expect(calls).toEqual([{ content: 'appended', mode: 'append' }]);
    expect(result).toContain('append');
  });

  it('should default to replace mode', async () => {
    const calls: Array<{ content: string; mode: string }> = [];
    const tool = updateNotebookTool({
      setNotebook: (content, mode) => calls.push({ content, mode }),
    });
    await exec(tool, { content: 'hello' });
    expect(calls[0].mode).toBe('replace');
  });
});
