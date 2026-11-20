import { z } from 'zod';
import { defineTool, safeExecute } from './common';

export function webSearchTool(deps: { tavilyApiKey?: string }) {
  const apiKey = deps.tavilyApiKey;

  return defineTool({
    description:
      'Search the web using Tavily. Returns top results with title, URL, and content snippet.',
    parameters: z.object({
      query: z.string().describe('Search query'),
    }),
    execute: safeExecute('web_search', async ({ query }) => {
      if (!apiKey) {
        return '[ERROR] web_search: No Tavily API key configured. Set WAYANG_TAVILY_API_KEY environment variable or add tavilyApiKey to config file.';
      }

      const response = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: apiKey,
          query,
          max_results: 5,
          include_answer: false,
        }),
      });

      if (!response.ok) {
        return `[ERROR] web_search: Tavily API returned ${response.status} ${response.statusText}`;
      }

      const data = (await response.json()) as {
        results: Array<{ title: string; url: string; content: string }>;
      };
      if (!data.results || data.results.length === 0) return 'No results found';

      return data.results
        .map(
          (r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.content}`,
        )
        .join('\n\n');
    }),
  });
}
