import { defineConfig } from 'tsup';

export default defineConfig({
  // ESM for the core surface: the server entry and the system context
  // that every service layer hangs off.
  entry: {
    'server/wayang-server': 'src/server/wayang-server.ts',
    'infra/system-context': 'src/infra/system-context.ts',
  },
  format: ['esm'],
  target: 'node20',
  splitting: false,
  sourcemap: true,
  clean: true,
  // Workspace packages ship as TypeScript sources; bundle them instead of
  // leaving an @wayang/* import that only Node's type stripping could follow.
  noExternal: [/^@wayang\//],
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
