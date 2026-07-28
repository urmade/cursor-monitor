#!/bin/sh
set -e
cd "$(dirname "$0")/.."
node e2e/webhook-stub.mjs &
STUB_PID=$!
export E2E_WEBHOOK_URL="${E2E_WEBHOOK_URL:-http://127.0.0.1:18765/automation}"
export DEPLOYMENT_URL="${DEPLOYMENT_URL:-http://127.0.0.1:3001}"
trap 'kill "$STUB_PID" 2>/dev/null || true' EXIT INT TERM
pnpm run build
PORT=3001 exec pnpm exec next start -p 3001
