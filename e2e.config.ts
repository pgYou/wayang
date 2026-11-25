import path from 'node:path';
import { defineConfig } from 'vitest/config';

const coreSrc = path.resolve(__dirname, 'packages/core/src');
const protocolSrc = path.resolve(__dirname, 'packages/protocol/src');

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@\/(types|rpc)\//, replacement: `${protocolSrc}/$1/` },
      { find: /^@\/__tests__\//, replacement: `${coreSrc}/__tests__/` },
    ],
  },
  test: {
    globals: true,
    include: ['e2e/**/*.test.ts'],
    testTimeout: 90_000,
    hookTimeout: 30_000,
  },
});
