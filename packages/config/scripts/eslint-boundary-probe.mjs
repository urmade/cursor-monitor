#!/usr/bin/env node
/**
 * Probes every prohibited static import and dynamic import() per layer.
 * Usage: node packages/config/scripts/eslint-boundary-probe.mjs
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BOUNDARY_LAYERS,
  LAYER_RESTRICTIONS,
} from "../eslint-boundaries.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");

/** @type {Record<string, string>} */
const LAYER_PKG_DIR = {
  contracts: "packages/contracts",
  db: "packages/db",
  core: "packages/core",
  "cursor-client": "packages/cursor-client",
  mcp: "packages/mcp",
  jobs: "packages/jobs",
  ui: "packages/ui",
  web: "apps/web",
  config: "packages/config",
};

/** @param {string} entry */
function sampleModuleSpecifier(entry) {
  if (entry.includes("*")) {
    if (entry.startsWith("@nexus/")) return "@nexus/ui";
    if (entry.startsWith("next")) return "next/headers";
    if (entry.startsWith("react-dom")) return "react-dom/client";
    if (entry.startsWith("react")) return "react/jsx-runtime";
    if (entry.includes("apps/web")) return "apps/web/foo";
    return entry.replace(/\*/g, "probe");
  }
  if (entry.endsWith("/**")) {
    return entry.slice(0, -3);
  }
  return entry;
}

/** @param {import('../eslint-boundaries.mjs').NexusLayer} layer */
function prohibitedSpecimens(layer) {
  const spec = LAYER_RESTRICTIONS[layer];
  /** @type {{ specifier: string; message: string }[]} */
  const out = [];
  const seen = new Set();
  for (const p of spec.paths) {
    if (!seen.has(p.name)) {
      seen.add(p.name);
      out.push({ specifier: p.name, message: p.message });
    }
  }
  for (const pat of spec.patterns) {
    for (const entry of pat.group) {
      const specimen = sampleModuleSpecifier(entry);
      const key = `${specimen}::${pat.message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ specifier: specimen, message: pat.message });
    }
  }
  return out;
}

function runEslintOnProbe(layer, specimens) {
  const pkgDir = LAYER_PKG_DIR[layer];
  if (!pkgDir) return { ok: false, output: `unknown layer ${layer}` };
  const probeFile = path.join(repoRoot, pkgDir, ".eslint-boundary-probe.ts");
  const lines = specimens.flatMap(({ specifier }) => [
    `import '${specifier}';`,
    `void import('${specifier}');`,
  ]);
  fs.writeFileSync(probeFile, lines.join("\n") + "\n");

  const probeConfigPath = path.join(
    repoRoot,
    "packages/config",
    `.eslint-boundary-probe-${layer}.mjs`,
  );
  fs.writeFileSync(
    probeConfigPath,
    `import { boundaryProbeConfig } from "./eslint-boundary-probe.config.mjs";\nexport default boundaryProbeConfig("${layer}");\n`,
  );

  const eslintConfig = probeConfigPath;
  const eslintCandidates = [
    path.join(repoRoot, pkgDir, "node_modules", ".bin", "eslint"),
    path.join(repoRoot, "packages/core/node_modules/.bin/eslint"),
    path.join(repoRoot, "node_modules/.bin/eslint"),
  ];
  const eslintBin = eslintCandidates.find((p) => fs.existsSync(p));
  if (!eslintBin) {
    return { ok: false, output: "eslint binary not found" };
  }
  const result = spawnSync(
    eslintBin,
    ["--no-error-on-unmatched-pattern", "-c", eslintConfig, probeFile],
    { cwd: repoRoot, encoding: "utf8", env: process.env },
  );
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
  try {
    fs.unlinkSync(probeFile);
    fs.unlinkSync(probeConfigPath);
  } catch {
    // ignore
  }
  const hasLintErrors =
    result.status !== 0 &&
    /no-restricted-(imports|syntax)/.test(output);
  return {
    ok: hasLintErrors,
    output,
  };
}

let failed = false;
for (const layer of BOUNDARY_LAYERS) {
  const specimens = prohibitedSpecimens(layer);
  if (specimens.length === 0) {
    console.log(`\n=== @nexus/${layer} (no restrictions) ===`);
    continue;
  }
  console.log(`\n=== @nexus/${layer} (${specimens.length} prohibited edges × static+dynamic) ===`);
  const { ok, output } = runEslintOnProbe(layer, specimens);
  console.log(output);
  if (!ok) {
    console.error(`EXPECTED eslint errors for layer ${layer} but probe passed`);
    failed = true;
  }
}

if (failed) process.exit(1);
console.log("\nAll boundary probes reported ESLint errors as expected.");
