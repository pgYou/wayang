import { defineConfig } from 'vitest/config';

// Aggregated run: `npx vitest run` at the root executes every package suite.
export default defineConfig({
  test: {
    projects: ['packages/*/vitest.config.ts'],
  },
});
