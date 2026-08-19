import { createTypeScriptConfig } from '@cursor-monitor/config/eslint';

export default [
  ...createTypeScriptConfig({
    tsconfigRootDir: import.meta.dirname,
  }),
  {
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['drizzle-orm', 'drizzle-orm/*'],
              message: 'Use the backend-neutral @cursor-monitor/db contract.',
            },
            {
              group: ['@cursor-monitor/db/src/*'],
              message: 'Database adapter internals are private to packages/db.',
            },
          ],
        },
      ],
    },
  },
];
