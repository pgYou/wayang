import { defineConfig } from 'tsup';

export default defineConfig({
  // The protocol package is types + RPC framing: the types barrel plus the
  // four rpc modules, emitted as ESM with declarations.
  entry: {
    'types/index': 'src/types/index.ts',
    'rpc/protocol': 'src/rpc/protocol.ts',
    'rpc/rpc-client': 'src/rpc/rpc-client.ts',
    'rpc/rpc-server': 'src/rpc/rpc-server.ts',
    'rpc/transport': 'src/rpc/transport.ts',
  },
  format: ['esm'],
  target: 'node20',
  splitting: false,
  sourcemap: true,
  clean: true,
  external: ['lodash-es'],
});
