import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  test: {
    globals: true,
    include: ['e2e/**/*.test.ts'],
    testTimeout: 90_000,
    hookTimeout: 30_000,
  },
});
