import fg from 'fast-glob';
import { defineConfig } from 'tsup';

const entries = fg.sync(['src/**/*.ts', '!src/**/__tests__/**', '!src/**/*.test.ts'], {
  cwd: __dirname,
});

export default defineConfig({
  // Library artifact: every module compiled exactly once, dist mirrors src so
  // subpath exports (`@wayang-ai/protocol/rpc/*`) resolve without rewrites.
  entry: entries,
  preserveModules: true,
  format: ['esm'],
  target: 'node20',
  // splitting is required with preserveModules: without it tsup bundles each
  // entry with its full dependency graph, duplicating shared modules (two
  // RpcError classes → instanceof failures across files).
  splitting: true,
  sourcemap: true,
  clean: true,
  external: ['lodash-es'],
});
