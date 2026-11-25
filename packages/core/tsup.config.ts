import fg from 'fast-glob';
import { defineConfig } from 'tsup';

const libEntries = fg.sync(
  [
    'src/**/*.ts',
    '!src/**/__tests__/**',
    '!src/**/*.test.ts',
    // The bridge is a process artifact, not a library module — it is built by
    // the dedicated bundle config below.
    '!src/services/agents/acp/mcp-bridge-entry.ts',
  ],
  { cwd: __dirname },
);

const thirdPartyExternals = [
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
];

export default defineConfig([
  {
    // Library artifact: dist mirrors src, compiled exactly once. Sibling
    // workspace packages (@wayang-ai/protocol) stay external — they resolve
    // through the consumer's bundler to their own dist.
    entry: libEntries,
    preserveModules: true,
    format: ['esm'],
    target: 'node20',
    // splitting is required with preserveModules: without it tsup bundles each
    // entry with its full dependency graph, duplicating shared modules (two
    // RpcError classes → instanceof failures across files).
    splitting: true,
    sourcemap: true,
    clean: true,
    external: thirdPartyExternals,
  },
  {
    // Process artifact: the MCP bridge is spawned as a standalone stdio
    // server by ACP agents, so it ships as one self-contained bundle (only
    // node: builtins external). Apps copy this file next to their host entry.
    entry: { 'mcp-bridge-entry': 'src/services/agents/acp/mcp-bridge-entry.ts' },
    format: ['esm'],
    target: 'node20',
    splitting: false,
    sourcemap: false,
    clean: false,
    banner: { js: '#!/usr/bin/env node' },
    // Workspace deps are bundled here too: tsup auto-externalises the
    // package.json dependencies (@wayang-ai/protocol), which would leave the
    // copied bridge importing a workspace package at runtime — breaking the
    // "self-contained, only node: builtins external" contract above.
    noExternal: [/^@wayang-ai\//],
  },
]);
