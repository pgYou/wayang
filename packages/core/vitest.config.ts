import path from 'node:path';
import { defineConfig } from 'vitest/config';

const protocolSrc = path.resolve(__dirname, '../protocol/src');

export default defineConfig({
  resolve: {
    alias: [
      // `@/*` is package-local; reads that belong to @wayang/protocol land on
      // the owning package (mirrors the tsconfig `paths` fallback).
      { find: /^@\/(types|rpc)\//, replacement: `${protocolSrc}/$1/` },
      { find: '@', replacement: path.resolve(__dirname, 'src') },
    ],
  },
  test: {
    globals: true,
    include: ['src/**/*.test.ts'],
  },
});
