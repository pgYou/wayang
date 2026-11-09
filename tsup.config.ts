import { defineConfig } from 'tsup';

export default defineConfig({
  // Named entries keep both bundles flat in dist/: the CLI launches
  // dist/mcp-bridge-entry.js as the ACP agent's stdio MCP server.
  entry: {
    cli: 'src/cli.ts',
    'mcp-bridge-entry': 'src/services/agents/acp/mcp-bridge-entry.ts',
  },
  format: ['esm'],
  target: 'node20',
  splitting: false,
  sourcemap: true,
  clean: true,
  banner: { js: '#!/usr/bin/env node' },
  external: [
    'ai',
    '@ai-sdk/openai',
    'fast-glob',
    'lodash-es',
    'pino',
    'pino-pretty',
    'zod',
    'react',
    'ink',
  ],
});
