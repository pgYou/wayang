import { describe, it, expect, vi, afterEach } from 'vitest';
import { webSearchTool } from '@/services/tools/web-search';

async function exec(toolObj: any, args: any): Promise<string> {
  return toolObj.execute(args);
}

describe('webSearchTool', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('should return error when no API key is configured', async () => {
    const tool = webSearchTool({ tavilyApiKey: undefined });
    const result = await exec(tool, { query: 'test' });
    expect(result).toContain('[ERROR]');
    expect(result).toContain('No Tavily API key');
    expect(result).toContain('WAYANG_TAVILY_API_KEY');
  });

  it('should return formatted search results', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          results: [
            { title: 'Test Result', url: 'https://example.com', content: 'Some snippet' },
          ],
        }),
    }) as any;

    const tool = webSearchTool({ tavilyApiKey: 'tvly-test' });
    const result = await exec(tool, { query: 'test query' });
    expect(result).toContain('1. Test Result');
    expect(result).toContain('https://example.com');
    expect(result).toContain('Some snippet');
  });

  it('should return no results message for empty results', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ results: [] }),
    }) as any;

    const tool = webSearchTool({ tavilyApiKey: 'tvly-test' });
    const result = await exec(tool, { query: 'obscure query' });
    expect(result).toBe('No results found');
  });

  it('should return error on API failure', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
    }) as any;

    const tool = webSearchTool({ tavilyApiKey: 'tvly-test' });
    const result = await exec(tool, { query: 'test' });
    expect(result).toContain('[ERROR]');
    expect(result).toContain('429');
  });

  it('should send correct request body to Tavily', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ results: [] }),
    });
    globalThis.fetch = mockFetch as any;

    const tool = webSearchTool({ tavilyApiKey: 'tvly-test' });
    await exec(tool, { query: 'hello world' });

    expect(mockFetch).toHaveBeenCalledWith('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: 'tvly-test',
        query: 'hello world',
        max_results: 5,
        include_answer: false,
      }),
    });
  });
});
