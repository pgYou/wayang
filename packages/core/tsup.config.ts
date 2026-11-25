import fg from 'fast-glob';
import { defineConfig } from 'tsup';

const libEntries = fg.sync(
  [
    'src/**/*.ts',
    '!src/**/__tests__/**',
    '!src/**/*.test.ts',
    // The bridge is a process artifact, not a library module — apps/cli builds
    // it as its own tsup entry (from this source, version-injected via define).
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

export default defineConfig({
  // Library artifact: dist mirrors src, compiled exactly once. Sibling
  // workspace packages (@wayang-ai/protocol) stay external — they resolve
  // through the consumer's bundler to their own dist. The MCP bridge used to
  // be a second bundle entry here, copied into apps by build scripts; it is
  // now built by apps/cli's tsup so the shipped product version can be baked
  // into it (see apps/cli/tsup.config.ts).
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
});
