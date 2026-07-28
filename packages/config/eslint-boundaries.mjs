/** @typedef {'contracts' | 'db' | 'core' | 'cursor-client' | 'mcp' | 'jobs' | 'ui' | 'web' | 'config'} NexusLayer */

const WEB_APP_PATHS = [
  {
    group: ["apps/web", "apps/web/**", "**/apps/web/**"],
    message:
      "Domain packages must not import the Next.js app tree (apps/web). Pass an Actor into core services instead.",
  },
];

/** @type {Record<NexusLayer, { paths: { name: string; message: string }[]; patterns: { group: string[]; message: string }[] }>} */
export const LAYER_RESTRICTIONS = {
  contracts: {
    paths: [],
    patterns: [
      {
        group: ["@nexus/*"],
        message:
          "@nexus/contracts must not depend on other workspace packages (architecture-baseline §2).",
      },
    ],
  },
  db: {
    paths: [],
    patterns: [
      {
        group: [
          "@nexus/core",
          "@nexus/mcp",
          "@nexus/jobs",
          "@nexus/ui",
          "@nexus/cursor-client",
        ],
        message:
          "@nexus/db may only depend on @nexus/contracts among workspace packages (architecture-baseline §2).",
      },
      {
        group: ["next", "next/*"],
        message: "@nexus/db must not import Next.js.",
      },
    ],
  },
  core: {
    paths: [
      {
        name: "react",
        message:
          "packages/core must not import React; it is framework-agnostic (architecture-baseline §2).",
      },
      {
        name: "react-dom",
        message:
          "packages/core must not import React DOM; it is framework-agnostic (architecture-baseline §2).",
      },
    ],
    patterns: [
      {
        group: ["next", "next/*"],
        message:
          "packages/core must not import Next.js (architecture-baseline §2).",
      },
      {
        group: ["react", "react/*", "react-dom", "react-dom/*"],
        message:
          "packages/core must not import React (architecture-baseline §2).",
      },
      {
        group: ["@nexus/mcp", "@nexus/jobs", "@nexus/ui"],
        message:
          "packages/core may only depend on db, contracts, and cursor-client among adapters (architecture-baseline §2).",
      },
      ...WEB_APP_PATHS,
    ],
  },
  "cursor-client": {
    paths: [],
    patterns: [
      {
        group: ["@nexus/*"],
        message:
          "@nexus/cursor-client is a leaf HTTP client and must not import other workspace packages.",
      },
    ],
  },
  mcp: {
    paths: [
      {
        name: "react",
        message: "MCP adapters must not import React.",
      },
      {
        name: "react-dom",
        message: "MCP adapters must not import React DOM.",
      },
    ],
    patterns: [
      {
        group: ["next", "next/*"],
        message: "MCP adapters must not import Next.js.",
      },
      {
        group: ["@nexus/jobs", "@nexus/ui", "@nexus/cursor-client"],
        message:
          "@nexus/mcp may depend on core, db, and contracts only (thin adapter over core).",
      },
      ...WEB_APP_PATHS,
    ],
  },
  jobs: {
    paths: [
      {
        name: "react",
        message: "Background jobs must not import React.",
      },
      {
        name: "react-dom",
        message: "Background jobs must not import React DOM.",
      },
    ],
    patterns: [
      {
        group: ["next", "next/*"],
        message: "Background jobs must not import Next.js.",
      },
      {
        group: ["@nexus/mcp", "@nexus/ui"],
        message:
          "@nexus/jobs may depend on core, db, contracts, and cursor-client (architecture-baseline §2).",
      },
      ...WEB_APP_PATHS,
    ],
  },
  ui: {
    paths: [],
    patterns: [
      {
        group: [
          "@nexus/core",
          "@nexus/db",
          "@nexus/mcp",
          "@nexus/jobs",
          "@nexus/cursor-client",
        ],
        message:
          "@nexus/ui is presentation-only; depend on @nexus/contracts for shared types, not domain packages.",
      },
      ...WEB_APP_PATHS,
    ],
  },
  web: {
    paths: [],
    patterns: [],
  },
  config: {
    paths: [],
    patterns: [
      {
        group: ["@nexus/*"],
        message: "@nexus/config is tooling-only and must stay dependency-free.",
      },
    ],
  },
};

/**
 * Turn a no-restricted-imports pattern entry into a RegExp for dynamic `import()`.
 * @param {string} entry
 */
export function importPatternToRegExp(entry) {
  if (entry === "**" || entry === "*") {
    return /^/;
  }
  let normalized = entry;
  if (normalized.endsWith("/**")) {
    normalized = normalized.slice(0, -3);
  }
  const escaped = normalized
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, ".*")
    .replace(/\*/g, "[^/]*");
  if (entry.includes("*") || entry.endsWith("/**")) {
    return new RegExp(`^${escaped}`);
  }
  return new RegExp(`^${escaped}(\\/|$)`);
}

/**
 * @param {{ paths: { name: string; message: string }[]; patterns: { group: string[]; message: string }[] }} spec
 */
export function dynamicImportSyntaxRules(spec) {
  /** @type {{ selector: string; message: string }[]} */
  const rules = [];
  for (const pathRule of spec.paths) {
    const re = importPatternToRegExp(pathRule.name);
    rules.push({
      selector: `ImportExpression[source.type='Literal'][source.value=${re}]`,
      message: `${pathRule.message} (dynamic import)`,
    });
  }
  for (const patternRule of spec.patterns) {
    for (const entry of patternRule.group) {
      const re = importPatternToRegExp(entry);
      rules.push({
        selector: `ImportExpression[source.type='Literal'][source.value=${re}]`,
        message: `${patternRule.message} (dynamic import)`,
      });
    }
  }
  return rules;
}

/**
 * ESLint flat-config blocks enforcing architecture-baseline §2 import layering.
 * @param {NexusLayer} layer
 */
export function boundariesFor(layer) {
  const spec = LAYER_RESTRICTIONS[layer];
  if (!spec) {
    throw new Error(`Unknown Nexus ESLint layer: ${layer}`);
  }
  const blocks = [];
  if (spec.paths.length > 0 || spec.patterns.length > 0) {
    blocks.push({
      files: ["**/*.{ts,tsx,mts,cts}"],
      rules: {
        "no-restricted-imports": [
          "error",
          {
            paths: spec.paths,
            patterns: spec.patterns,
          },
        ],
      },
    });
    const dynamicRules = dynamicImportSyntaxRules(spec);
    if (dynamicRules.length > 0) {
      blocks.push({
        files: ["**/*.{ts,tsx,mts,cts}"],
        rules: {
          "no-restricted-syntax": ["error", ...dynamicRules],
        },
      });
    }
  }
  return blocks;
}

/** @type {NexusLayer[]} */
export const BOUNDARY_LAYERS = Object.keys(LAYER_RESTRICTIONS);
