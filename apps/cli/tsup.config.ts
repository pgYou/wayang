import { defineConfig } from 'tsup';

export default defineConfig({
  // Both entries stay flat in dist/: the CLI launches dist/mcp-bridge-entry.js
  // as the ACP agent's stdio MCP server. The bridge lives in @wayang-ai/core and
  // is bundled here so the CLI ships a single dist/ directory.
  entry: {
    cli: 'src/cli.ts',
    'mcp-bridge-entry': '../core/src/services/agents/acp/mcp-bridge-entry.ts',
  },
  format: ['esm'],
  target: 'node20',
  splitting: false,
  sourcemap: true,
  clean: true,
  // Workspace packages ship as TypeScript sources; bundle them instead of
  // leaving an @wayang-ai/* import that only Node's type stripping could follow.
  noExternal: [/^@wayang-ai\//],
  banner: { js: '#!/usr/bin/env node' },
  // Same external set the pre-split build had (tsup externalises the
  // package.json dependencies; with the deps hoisted at the workspace root
  // they are listed explicitly here).
  external: [
    'ai',
    '@ai-sdk/openai',
    '@ai-sdk/openai-compatible',
    '@anthropic-ai/claude-agent-sdk',
    'fast-glob',
    'ink',
    'lodash-es',
    'meow',
    'pino',
    'pino-pretty',
    'prompts',
    'react',
    'yaml',
    'zod',
  ],
});
