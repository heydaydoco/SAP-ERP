// Shared flat ESLint config (ESLint 9). Consumed via `@erp/config/eslint`.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/.next/**', '**/coverage/**', '**/node_modules/**', '**/*.config.*'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      // Money/amounts must be NUMERIC-backed strings/Decimals, never JS number — enforced in review.
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  {
    // Maintenance/codegen scripts exist to print to the console — that IS their output.
    files: ['scripts/**', '**/scripts/**'],
    rules: {
      'no-console': 'off',
    },
  },
  prettier,
);
