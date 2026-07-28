import { boundariesFor } from "./eslint-boundaries.mjs";

/** Tooling package: boundary rules only (no TypeScript sources). */
export default [
  {
    ignores: ["**/node_modules/**"],
  },
  ...boundariesFor("config"),
];
