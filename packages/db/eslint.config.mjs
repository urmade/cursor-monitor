import { createNexusEslintConfig } from "@nexus/config/eslint-base.mjs";
import { boundariesFor } from "@nexus/config/eslint-boundaries.mjs";
import { dirname } from "path";
import { fileURLToPath } from "url";

const tsconfigRootDir = dirname(fileURLToPath(import.meta.url));

export default [
  ...createNexusEslintConfig({ tsconfigRootDir }),
  ...boundariesFor("db"),
];
