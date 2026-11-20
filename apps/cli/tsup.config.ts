import { defineConfig } from 'tsup';

export default defineConfig({
  // App artifact: bundles the workspace libraries' dist into the final CLI
  // deliverable. The MCP bridge is NOT an entry here — core builds it as its
  // own process artifact and the build script copies it into dist/ (§ docs/
  // develop/v1.0-monorepo-design.md).
  entry: {
    cli: 'src/cli.ts',
    'server-entry': 'src/server-entry.ts',
  },
  format: ['esm'],
  target: 'node20',
  splitting: false,
  sourcemap: true,
  clean: true,
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
