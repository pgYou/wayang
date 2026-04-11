import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['esm'],
  target: 'node20',
  splitting: false,
  sourcemap: true,
  clean: true,
  banner: { js: '#!/usr/bin/env node' },
  external: [
    'ai',
    '@ai-sdk/openai',
    'lodash-es',
    'pino',
    'pino-pretty',
    'zod',
    'react',
    'ink',
  ],
});
