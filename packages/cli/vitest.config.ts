import path from 'node:path';
import { defineConfig } from 'vitest/config';

const coreSrc = path.resolve(__dirname, '../core/src');
const protocolSrc = path.resolve(__dirname, '../protocol/src');

export default defineConfig({
  resolve: {
    alias: [
      // `@/*` is package-local; reads that belong to a sibling package land on
      // the owner (mirrors the tsconfig `paths` fallback).
      { find: /^@\/(types|rpc)\//, replacement: `${protocolSrc}/$1/` },
      { find: /^@\/(services|infra|server|utils)\//, replacement: `${coreSrc}/$1/` },
      { find: /^@\/onboard$/, replacement: `${coreSrc}/onboard.ts` },
      { find: /^@\/__tests__\/(helpers|fake-openai-provider)$/, replacement: `${coreSrc}/__tests__/$1` },
      { find: '@', replacement: path.resolve(__dirname, 'src') },
    ],
  },
  test: {
    globals: true,
    include: ['src/**/*.test.ts'],
  },
});
