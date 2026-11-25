import { createRequire } from 'node:module';
import { defineConfig } from 'tsup';

const require = createRequire(import.meta.url);
const cliVersion: string = require('./package.json').version;

export default defineConfig({
  // App artifact: bundles the workspace libraries' dist into the final CLI
  // deliverable. The MCP bridge is the THIRD entry, built from core SOURCE
  // (not from core's dist): it stays a self-contained process artifact, and
  // building it here lets `define` bake the shipped product version —
  // @wayang-ai/cli's package.json version — into its MCP initialize answer
  // (serverInfo) and into the host-side dispatcher bundled into the other
  // entries (§ docs/develop/monorepo-design.md).
  entry: {
    cli: 'src/cli.ts',
    'server-entry': 'src/server-entry.ts',
    'mcp-bridge-entry': '../../packages/core/src/services/agents/acp/mcp-bridge-entry.ts',
  },
  format: ['esm'],
  target: 'node20',
  splitting: false,
  sourcemap: true,
  clean: true,
  noExternal: [/^@wayang-ai\//],
  banner: { js: '#!/usr/bin/env node' },
  define: { __WAYANG_PRODUCT_VERSION__: JSON.stringify(cliVersion) },
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
