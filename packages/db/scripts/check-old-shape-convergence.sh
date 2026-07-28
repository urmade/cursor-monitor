#!/usr/bin/env bash
# Prove renumbered migrations converge from the pre-rename deployed shape.
#
# 1) old-shape: 0001–0012 + fixtures/pre-renumber/{0013_loops,0014_attention,0015_rubrics}
#    clear those migration ids, apply the current tree
# 2) fresh: current migrations from empty
# Diff information_schema.columns for public tables. Exit 1 on drift.
#
# Usage (repo root):
#   DB_POSTGRES_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres \
#     bash packages/db/scripts/check-old-shape-convergence.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
FIX="$ROOT/packages/db/fixtures/pre-renumber"
MIG="$ROOT/packages/db/migrations"

if [[ -z "${DB_POSTGRES_URL:-}${DB_POSTGRES_URL_NON_POOLING:-}" ]]; then
  echo "Set DB_POSTGRES_URL or DB_POSTGRES_URL_NON_POOLING" >&2
  exit 2
fi

BASE_URL="${DB_POSTGRES_URL_NON_POOLING:-$DB_POSTGRES_URL}"

url_for_db() {
  local db="$1"
  python3 - <<PY
from urllib.parse import urlparse, urlunparse
u = urlparse("$BASE_URL")
print(urlunparse((u.scheme, u.netloc, "/$db", "", u.query, "")))
PY
}

ADMIN_URL="$(url_for_db postgres)"
psql_admin() { psql "$ADMIN_URL" -v ON_ERROR_STOP=1 "$@"; }
psql_db() {
  local db="$1"
  shift
  psql "$(url_for_db "$db")" -v ON_ERROR_STOP=1 "$@"
}

dump_columns() {
  local db="$1" out="$2"
  psql_db "$db" -At -F$'\t' -c "
    select table_name, column_name, data_type, udt_name,
           is_nullable, column_default, is_generated, coalesce(generation_expression,'')
    from information_schema.columns
    where table_schema = 'public'
      and table_name not in ('schema_migrations')
    order by table_name, column_name;
  " > "$out"
}

apply_current() {
  local db="$1"
  export DB_POSTGRES_URL
  export DB_POSTGRES_URL_NON_POOLING
  DB_POSTGRES_URL="$(url_for_db "$db")"
  DB_POSTGRES_URL_NON_POOLING="$DB_POSTGRES_URL"
  (cd "$ROOT" && pnpm db:exec-migrations) >/dev/null
}

HOLD="$(mktemp -d)"
cleanup() {
  if compgen -G "$HOLD/*.sql" > /dev/null 2>&1; then
    mv -f "$HOLD"/*.sql "$MIG"/ 2>/dev/null || true
  fi
  rm -rf "$HOLD"
}
trap cleanup EXIT

echo "== old-shape fixture =="
psql_admin -c "DROP DATABASE IF EXISTS nexus_old_shape;"
psql_admin -c "CREATE DATABASE nexus_old_shape;"

shopt -s nullglob
for f in "$MIG"/001[3-9]*.sql "$MIG"/002*.sql; do
  mv "$f" "$HOLD/"
done
apply_current nexus_old_shape
mv "$HOLD"/*.sql "$MIG"/

for pair in "0013_loops:0013_loops.sql" "0014_attention:0014_attention.sql" "0015_rubrics:0015_rubrics.sql"; do
  id="${pair%%:*}"
  file="${pair##*:}"
  if [[ -f "$FIX/$file" ]]; then
    # Skip fixtures whose renumbered successor is not in the current tree yet
    # (phase-05 has loops only; attention/rubrics land on later hops).
    case "$id" in
      0013_loops)
        [[ -f "$MIG/0014_loops.sql" ]] || continue
        ;;
      0014_attention)
        [[ -f "$MIG/0016_attention.sql" ]] || continue
        ;;
      0015_rubrics)
        [[ -f "$MIG/0017_rubrics.sql" ]] || continue
        ;;
    esac
    echo "  apply fixture $file as $id"
    psql_db nexus_old_shape -f "$FIX/$file"
    psql_db nexus_old_shape -c "INSERT INTO schema_migrations (id) VALUES ('$id') ON CONFLICT DO NOTHING;"
  fi
done

psql_db nexus_old_shape -c "
  DELETE FROM schema_migrations
  WHERE id IN ('0013_loops','0014_attention','0015_rubrics');
"

echo "  apply current migrations over old shape"
apply_current nexus_old_shape

echo "== fresh =="
psql_admin -c "DROP DATABASE IF EXISTS nexus_fresh_shape;"
psql_admin -c "CREATE DATABASE nexus_fresh_shape;"
apply_current nexus_fresh_shape

OLD_COLS="$(mktemp)"
FRESH_COLS="$(mktemp)"
dump_columns nexus_old_shape "$OLD_COLS"
dump_columns nexus_fresh_shape "$FRESH_COLS"

DIFF_OUT="${DIFF_OUT:-/tmp/migration_column_diff.txt}"
if ! diff -u "$OLD_COLS" "$FRESH_COLS" > "$DIFF_OUT"; then
  echo "FAIL: public columns diverge between old-shape migrate and fresh migrate" >&2
  cat "$DIFF_OUT" >&2
  exit 1
fi

echo "OK: old-shape and fresh schemas converge ($(wc -l < "$FRESH_COLS") columns)"
rm -f "$OLD_COLS" "$FRESH_COLS"
