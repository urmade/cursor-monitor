import { boundariesFor } from "./eslint-boundaries.mjs";

/** @param {import('./eslint-boundaries.mjs').NexusLayer} layer */
export function boundaryProbeConfig(layer) {
  return [
    {
      files: ["**/*.{ts,tsx,mts,cts}"],
      languageOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
      },
    },
    ...boundariesFor(layer),
  ];
}
