#!/usr/bin/env sh
set -eu
git config core.hooksPath .githooks
if [ -f "scripts/install-secrets-tooling.sh" ]; then
  sh scripts/install-secrets-tooling.sh
fi
echo "Configured core.hooksPath to .githooks and checked secrets tooling dependencies."
echo "Skipped Vercel local link for nexus; CI links Vercel and syncs env vars during preview/production deploys."
echo "Do not run vercel env pull, vercel dev, or vercel deploy locally for internalsphere apps."
echo "Docs: https://github.com/internalsphere/internal-app-orchestrator#environment-variables"
