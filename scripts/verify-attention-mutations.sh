#!/usr/bin/env bash
# Apply each Phase 6 attention mutation, run the attention vitest suite, record pass/fail, revert.
# Usage: DB_POSTGRES_URL=... ./scripts/verify-attention-mutations.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/packages/core"
VITEST=(pnpm exec vitest run src/attention)
RESULTS="$ROOT/packages/core/src/attention/MUTATION_MATRIX_OBSERVED.md"

if [[ -z "${DB_POSTGRES_URL:-}" ]]; then
  echo "DB_POSTGRES_URL is required" >&2
  exit 1
fi

run_suite() {
  "${VITEST[@]}" 2>&1 | tail -3
}

record() {
  local id="$1" desc="$2" observed="$3"
  echo "| $id | $desc | $observed |" >>"$RESULTS"
}

git -C "$ROOT" checkout -- packages/core/src/attention packages/core/src/budgets/actions.ts 2>/dev/null || true

cat >"$RESULTS" <<EOF
# Attention mutation matrix (observed)

Command: \`cd packages/core && pnpm exec vitest run src/attention\`

| ID | Mutation | Observed red? |
|----|----------|---------------|
EOF

baseline_out="$(run_suite)"
if echo "$baseline_out" | rg -q "failed"; then
  echo "Baseline suite not green; fix before mutation run." >&2
  echo "$baseline_out"
  exit 1
fi

mutate() {
  local file="$1"
  shift
  "$@" 
}

# M14 — remove executeAction authz guard
perl -i -0pe 's/  if \(\n    !can\(ctx\.actor, '\''work_item\.update'\''.*?return err\(coreError\('\''forbidden'\'', '\''You cannot perform this action'\''\)\);\n  \}\n\n/  \/\/ MUTATION M14: authz removed\n/s' "$ROOT/packages/core/src/attention/actions.ts"
if run_suite | rg -q "failed"; then record M14 "executeAction authz removed" "yes"; else record M14 "executeAction authz removed" "no"; fi
git -C "$ROOT" checkout -- packages/core/src/attention/actions.ts

# M20 — noop dispatcher
perl -i -pe 'if (/export async function dispatchAttentionEvents/) { $noop=1 } if ($noop && /const cursor =/) { $_="  return { processed: 0, attentionHandled: 0 };\n"; $noop=0 }' "$ROOT/packages/core/src/attention/dispatch.ts"
if run_suite | rg -q "failed"; then record M20 "dispatchAttentionEvents noop" "yes"; else record M20 "dispatchAttentionEvents noop" "no"; fi
git -C "$ROOT" checkout -- packages/core/src/attention/dispatch.ts

# M16 — drop project scoping in listInbox
perl -i -pe 's/inArray\(attentionItems\.projectId, pids\)/eq(attentionItems.status, "open") \/* M16 *\//' "$ROOT/packages/core/src/attention/list.ts"
if run_suite | rg -q "failed"; then record M16 "listInbox project inArray removed" "yes"; else record M16 "listInbox project inArray removed" "no"; fi
git -C "$ROOT" checkout -- packages/core/src/attention/list.ts

# M1 — projection kind not updated
perl -i -pe 's/kind: source\.kind,\n/ \/* kind: source.kind, M1 *\//' "$ROOT/packages/core/src/attention/projection.ts"
if run_suite | rg -q "failed"; then record M1 "projection kind omitted on update" "yes"; else record M1 "projection kind omitted on update" "no"; fi
git -C "$ROOT" checkout -- packages/core/src/attention/projection.ts

# M2 — reconcile kind repair removed
perl -i -0pe 's/} else if \(open\.kind !== exp\.kind\) \{.*?repaired \+= 1;\n    \}/} else if (false) { \/* M2 *\//s' "$ROOT/packages/core/src/attention/reconcile.ts"
if run_suite | rg -q "failed"; then record M2 "reconcile kind repair disabled" "yes"; else record M2 "reconcile kind repair disabled" "no"; fi
git -C "$ROOT" checkout -- packages/core/src/attention/reconcile.ts

# M4 — invalid cursor accepted
perl -i -pe 's/return err\(coreError\('\''validation'\'', '\''Invalid inbox cursor'\''\)\);/return ok({ groups: [], nextCursor: null, totalOpen: 0 }); \/* M4 *\//' "$ROOT/packages/core/src/attention/list.ts"
if run_suite | rg -q "failed"; then record M4 "invalid cursor returns empty ok" "yes"; else record M4 "invalid cursor returns empty ok" "no"; fi
git -C "$ROOT" checkout -- packages/core/src/attention/list.ts

# M8 — age boost zeroed
perl -i -pe 's/function ageBoost/function ageBoost_m8_disabled/; s/return Math\.round\(raw \* 10\) \/ 10;/return 0; \/* M8 *\//' "$ROOT/packages/core/src/attention/score.ts"
if run_suite | rg -q "failed"; then record M8 "ageBoost always 0" "yes"; else record M8 "ageBoost always 0" "no"; fi
git -C "$ROOT" checkout -- packages/core/src/attention/score.ts

# M13 — snooze cap removed
perl -i -pe 's/return err\(coreError\('\''validation'\'', '\''Snooze capped at 24 hours'\''\)\);/return ok(undefined); \/* M13 *\//' "$ROOT/packages/core/src/attention/actions.ts"
if run_suite | rg -q "failed"; then record M13 "snooze cap removed" "yes"; else record M13 "snooze cap removed" "no"; fi
git -C "$ROOT" checkout -- packages/core/src/attention/actions.ts

# M17 — budget.item_overridden handler removed
perl -i -0pe 's/case '\''budget\.item_overridden'\'': \{.*?break;\n    \}/case '\''budget.item_overridden'\'': break; \/* M17 *\//s' "$ROOT/packages/core/src/attention/handlers.ts"
if run_suite | rg -q "failed"; then record M17 "budget.item_overridden handler gutted" "yes"; else record M17 "budget.item_overridden handler gutted" "no"; fi
git -C "$ROOT" checkout -- packages/core/src/attention/handlers.ts

# M18 — run.launched handler removed
perl -i -0pe 's/case '\''run\.launched'\'': \{.*?break;\n    \}/case '\''run.launched'\'': break; \/* M18 *\//s' "$ROOT/packages/core/src/attention/handlers.ts"
if run_suite | rg -q "failed"; then record M18 "run.launched handler gutted" "yes"; else record M18 "run.launched handler gutted" "no"; fi
git -C "$ROOT" checkout -- packages/core/src/attention/handlers.ts

# M3/M5-M7/M9-M12/M15/M19/M21/M22 — source or unit-only; run suite after trivial mutations
perl -i -pe 's/readAttentionDispatchCursor/undefinedCursor \/* M3 *\//' "$ROOT/packages/core/src/attention/dispatch.ts"
if run_suite | rg -q "failed"; then record M3 "dispatch cursor read broken" "yes"; else record M3 "dispatch cursor read broken" "no"; fi
git -C "$ROOT" checkout -- packages/core/src/attention/dispatch.ts

perl -i -pe 's/AttentionWeightsSchema\.safeParse/AttentionWeightsSchema.parse \/* M22 *\//' "$ROOT/packages/core/src/attention/weights.ts"
if run_suite | rg -q "failed"; then record M22 "weights uses parse not safeParse" "yes"; else record M22 "weights uses parse not safeParse" "no"; fi
git -C "$ROOT" checkout -- packages/core/src/attention/weights.ts

echo "" >>"$RESULTS"
echo "Generated $(date -u +%Y-%m-%dT%H:%MZ)" >>"$RESULTS"
cat "$RESULTS"
