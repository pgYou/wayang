import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['src/**/*.tsx', 'src/**/*.jsx'],
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-hooks/rules-of-hooks': 'warn',
    },
  },
  {
    files: ['src/**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    // Test files and test-only helpers: `any` is often the pragmatic type for
    // mocks/fixtures that intentionally mirror loosely-typed LLM payloads.
    // Scoped to files that only tests import — __tests__ dirs, *.test.ts
    // anywhere under src/, and the e2e/ tree (harness + scenarios). No
    // implementation file under src/ matches these globs, so production code
    // keeps the full no-explicit-any / no-non-null-assertion checking.
    files: ['src/**/__tests__/**/*.ts', 'src/**/*.test.ts', 'e2e/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    // Hand-run fixture generator scripts. tsconfig has no allowJs, so the
    // project service cannot resolve them. Scoped to test fixtures only, so
    // any other .mjs under src/ still goes through lint.
    ignores: ['dist/', 'node_modules/', '*.js', 'src/**/__tests__/fixtures/*.mjs'],
  },
);
