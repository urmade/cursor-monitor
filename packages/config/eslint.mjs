import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export function createTypeScriptConfig({ tsconfigRootDir }) {
  return tseslint.config(
    {
      ignores: [
        '**/node_modules/**',
        '**/dist/**',
        '**/.next/**',
        '**/coverage/**',
        '**/vitest.config.ts',
      ],
    },
    eslint.configs.recommended,
    ...tseslint.configs.recommended,
    {
      files: ['**/*.{ts,tsx,mts,cts}'],
      languageOptions: {
        parserOptions: {
          projectService: true,
          tsconfigRootDir,
        },
      },
      rules: {
        'no-unused-vars': 'off',
        '@typescript-eslint/no-unused-vars': [
          'error',
          {
            argsIgnorePattern: '^_',
            varsIgnorePattern: '^_',
            caughtErrorsIgnorePattern: '^_',
          },
        ],
        '@typescript-eslint/no-explicit-any': 'error',
      },
    },
  );
}
