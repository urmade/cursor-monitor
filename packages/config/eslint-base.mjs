import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import { sqlDateGuardPlugin } from "./eslint-sql-dates.mjs";

/**
 * Shared TypeScript ESLint flat config for Nexus workspace packages.
 * @param {{ tsconfigRootDir: string; files?: string[] }} options
 */
export function createNexusEslintConfig(options) {
  const { tsconfigRootDir, files = ["**/*.{ts,tsx,mts,cts}"] } = options;

  return tseslint.config(
    {
      ignores: [
        "**/node_modules/**",
        "**/dist/**",
        "**/.next/**",
        "**/coverage/**",
        "**/vitest.config.ts",
      ],
    },
    eslint.configs.recommended,
    ...tseslint.configs.recommended,
    {
      files,
      languageOptions: {
        parserOptions: {
          projectService: true,
          tsconfigRootDir,
        },
      },
      plugins: {
        "sql-dates": sqlDateGuardPlugin,
      },
      rules: {
        "no-unused-vars": "off",
        "@typescript-eslint/no-unused-vars": [
          "error",
          {
            argsIgnorePattern: "^_",
            varsIgnorePattern: "^_",
            caughtErrorsIgnorePattern: "^_",
          },
        ],
        "@typescript-eslint/no-explicit-any": "error",
        "sql-dates/no-raw-date-bindings": "error",
      },
    },
  );
}
