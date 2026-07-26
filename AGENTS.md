# AGENTS.md

## Cursor Cloud specific instructions

### What this repo is
This is the internalsphere-managed `nexus` app. Right now it contains **no application source code** — only:
- Planning/design docs under `Implementation plan/` (`VISION.md`, `Implementation Phases.md`, `phases/`).
- internalsphere orchestrator baseline tooling: Python scripts in `scripts/`, git hooks in `.githooks/`, CI in `.github/workflows/managed-app.yml`, and encrypted-secret scaffolding under `secrets/`.

There is nothing to `build`/`serve` as an application yet. Do not expect a `package.json`, framework, or dev server. When app code is added, extend this section.

### Local dev tooling (what actually runs here)
- `python3 scripts/app-manifest.py` — validates/resolves `app-manifest.yml` (same thing CI's `resolve-app-manifest` step runs). Prints JSON.
- `python3 scripts/secrets.py list|add|update|delete` — the secrets CLI. `add`/`update` encrypt with `sops` using the age recipient checked into `.sops.yaml` (public recipient only; no private key needed to encrypt).
- `.githooks/pre-commit` and `.githooks/pre-push` both run `python3 scripts/secrets-guard.py`, which blocks committing plaintext `.env*` files (except `.env.example|sample|template`). This is the local "lint/policy" gate.

### Non-obvious gotchas
- `sops` is a required system dependency for the secrets CLI. It is NOT in apt here; it's installed from the GitHub release binary. It must be a recent version: `.sops.yaml` uses the list form of `age:` recipients, which `sops` 3.9.x rejects (`cannot unmarshal !!seq into string`). Use `sops` >= ~3.10 (3.13.3 verified working).
- `sh scripts/setup-repo.sh` configures `git config core.hooksPath .githooks` and checks tooling, but it also tries `npm install --global vercel@latest`, which fails with `EACCES` in this VM (global npm prefix `/usr/lib/node_modules` isn't writable) and makes the script exit non-zero. This is expected and non-blocking: the Vercel CLI is intentionally not used locally (CI owns all Vercel deploys — see `QUICKSTART.md`). Hooks + sops + python are what matter.
- Real lint/test/build/deploy run in CI via `internalsphere/internal-app-orchestrator` reusable workflows and cannot be run locally. Locally, the closest equivalents are the git hooks (`secrets-guard.py`) and `python3 scripts/app-manifest.py`.
- Do not edit policy-managed files (managed workflows, `CODEOWNERS`, `.sops.yaml`, hooks, `scripts/setup-repo.sh`, `scripts/install-secrets-tooling.sh`, `scripts/app-manifest.py`, `scripts/secrets-guard.py`, `scripts/secrets.py`, distributed skill files, `secrets/inventory.yaml`, `QUICKSTART.md`); they're overwritten on orchestrator reconciliation. Never bypass hooks with `--no-verify`.
