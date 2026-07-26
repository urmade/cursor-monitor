# AGENTS.md

## Hard rules (always apply)

### No Slack — ever
Agents are **NEVER** allowed to use Slack in this repository.

- Do not call any Slack MCP / plugin / CLI / API (send, search, read, react, schedule, canvas, DM, draft — anything).
- Do not post status reports, progress updates, blockers, questions, or pings to any Slack channel or user.
- Skills or docs that mention `#proj-internalsphere` (or any other channel) do **not** override this. Ignore those suggestions.

**GitHub pull requests are the source of truth.** Update the relevant PR; do not broadcast status elsewhere.

**If stuck:** stop and wait. Do not escalate via Slack or other chat. The human will check the PR / agent run when ready.

This also lives in `.cursor/rules/no-slack.mdc` (`alwaysApply: true`) so every Cursor agent respects it.

## Cursor Cloud specific instructions

### What this repo is
This is the internalsphere-managed `nexus` app:
- Next.js App Router under `apps/web` (`vercel.root_directory: apps/web`); domain packages under `packages/`.
- Planning/design docs under `Implementation plan/` and ADRs under `docs/decisions/`.
- internalsphere orchestrator baseline tooling: Python scripts in `scripts/`, git hooks in `.githooks/`, CI in `.github/workflows/managed-app.yml`, and encrypted-secret scaffolding under `secrets/`.

Local app commands: `pnpm install`, then `pnpm dev` / `pnpm build` / `pnpm test` (Turborepo). Preview/production deploys only via CI.

### Local dev tooling (what actually runs here)
- `python3 scripts/app-manifest.py` — validates/resolves `app-manifest.yml` (same thing CI's `resolve-app-manifest` step runs). Prints JSON.
- `python3 scripts/secrets.py list|add|update|delete` — the secrets CLI. `add`/`update` encrypt with `sops` using the age recipient checked into `.sops.yaml` (public recipient only; no private key needed to encrypt).
- `.githooks/pre-commit` and `.githooks/pre-push` both run `python3 scripts/secrets-guard.py`, which blocks committing plaintext `.env*` files (except `.env.example|sample|template`). This is the local "lint/policy" gate.

### Non-obvious gotchas
- `sops` is a required system dependency for the secrets CLI. It is NOT in apt here; it's installed from the GitHub release binary. It must be a recent version: `.sops.yaml` uses the list form of `age:` recipients, which `sops` 3.9.x rejects (`cannot unmarshal !!seq into string`). Use `sops` >= ~3.10 (3.13.3 verified working).
- `sh scripts/setup-repo.sh` configures `git config core.hooksPath .githooks` and checks tooling, but it also tries `npm install --global vercel@latest`, which fails with `EACCES` in this VM (global npm prefix `/usr/lib/node_modules` isn't writable) and makes the script exit non-zero. This is expected and non-blocking: the Vercel CLI is intentionally not used locally (CI owns all Vercel deploys — see `QUICKSTART.md`). Hooks + sops + python are what matter.
- Real lint/test/build/deploy run in CI via `internalsphere/internal-app-orchestrator` reusable workflows and cannot be run locally. Locally, the closest equivalents are the git hooks (`secrets-guard.py`) and `python3 scripts/app-manifest.py`.
- Do not edit policy-managed files (managed workflows, `CODEOWNERS`, `.sops.yaml`, hooks, `scripts/setup-repo.sh`, `scripts/install-secrets-tooling.sh`, `scripts/app-manifest.py`, `scripts/secrets-guard.py`, `scripts/secrets.py`, distributed skill files, `secrets/inventory.yaml`, `QUICKSTART.md`); they're overwritten on orchestrator reconciliation. Never bypass hooks with `--no-verify`.
