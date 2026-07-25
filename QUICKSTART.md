# Quickstart

This repository lives in the `internalsphere` GitHub org and is managed end-to-end by [`internal-app-orchestrator`](https://github.com/internalsphere/internal-app-orchestrator) (the "ranger" / control plane). The orchestrator creates the Vercel project, sets branch protection, seeds the baseline files, and deploys preview on every PR and production on every merge to `main`.

**Full guide (recommended read):** https://www.notion.so/cursorai/internalsphere-348da74ef0458184af80e67adbcef6b7 — what internalsphere is, how to set up your laptop, how to ship changes, and answers to the questions people ask most often.

## Access FAQs

### How do I get access to internalsphere?

You probably already have access. Open [Okta](https://anysphere.okta.com/app/UserHome?session_hint=AUTHENTICATED) and look for the `Vercel-Internal` and `GitHub - Internalsphere` tiles. Launch these apps from Okta; do not try to sign in to Vercel or GitHub directly. If the tile you need is missing, post in `#it-help`.

### I opened a deployment and see "You need access." What should I do?

Reopen the deployment URL and complete the Okta Passport sign-in flow. Most deployments use the `internalsphere-okta-passport` identity provider application. Projects configured for external viewers keep Vercel Authentication instead: Cursor employees should launch the `Vercel-Internal` Okta tile, while approved guests sign in to Vercel with the exact email address in their grant. If the expected flow denies access, post in `#it-help`.

### I don't see internalsphere in Cursor cloud agents. What should I do?

You likely need to reconnect your GitHub account (your token needs to be picked up with SSO approval). Open https://cursor.com/dashboard/integrations; under GitHub you should see an error message like "internalsphere is missing due to SSO – reconnect to authorize access". Click **reconnect** and complete the flow. If you still do NOT see `internalsphere` after that, ask in `#proj-internalsphere`.

## First time on this repo

1. Clone the repo and install app-specific dependencies as your app requires.
2. Run once per repo:
   ```bash
   sh scripts/setup-repo.sh
   ```
3. Verify git hooks are active:
   ```bash
   git config core.hooksPath  # should print: .githooks
   ```

Setup does not pull Vercel environment variables or run local Vercel deploys. Use PR previews for testing with the real preview environment.

If `git clone` or setup fails with "Permission denied (publickey)" or "Repository not found", your SSH key almost certainly isn't SSO-authorized for `internalsphere`. See the [full guide](https://www.notion.so/cursorai/internalsphere-348da74ef0458184af80e67adbcef6b7) for the one-time fix.

## How to ship a change

1. Branch off `main`, commit, push.
2. Open a PR. The `internalsphere-ranger` bot posts the preview URL, Bugbot and Security Bugbot leave review comments, and CI runs lint/secret-scan/etc.
3. Merge when green. The orchestrator deploys to production automatically.

Every PR gets its own preview URL with the real preview env — iterate on it end-to-end before merging.

## Distributed Cursor skills (dispatched by the orchestrator)

If you use Cursor, invoke any of these with `@<skill-name>`:

- **`@internalsphere-setup`** — what internalsphere is, first-time setup, FAQs, and common troubleshooting. Start here when an agent is unsure *how the platform works*.
  - Path: `.cursor/skills/internalsphere-setup/SKILL.md`
- **`@secrets-operations`** — list/add/update/delete encrypted env vars via `scripts/secrets.py`.
  - Path: `.cursor/skills/secrets-operations/SKILL.md`
- **`@supabase-database`** — when the repo uses the Supabase integration.
  - Path: `.cursor/skills/supabase-database/SKILL.md`
- **`@upstash-redis`** — when the repo uses the Upstash Redis integration.
  - Path: `.cursor/skills/upstash-redis/SKILL.md`
- **`@vercel-blob-store`** — when the repo uses the Vercel Blob integration.
  - Path: `.cursor/skills/vercel-blob-store/SKILL.md`
- **`@external-viewers`** — share a protected deployment with someone outside Anysphere.
  - Path: `.cursor/skills/external-viewers/SKILL.md`

CI writes the remote key inventory to `secrets/inventory.yaml`; do not edit that file manually.

## Sharing a deployment with someone outside Anysphere

Add a time-bound grant to `external-viewers.yml` at the repo root (create the file if it does not exist):

```yaml
version: 1
viewers:
  - target: <project>-preview.vercel.app
    email: partner@example.com
    expires_at: "2026-06-19T00:00:00Z"
    requested_by: "@you"
    reason: "Customer pitch review"
```

Open a PR — `@internalsphere/security` is tagged automatically for review. After merge, the orchestrator grants the viewer access in Vercel (they sign in to a free Vercel account with that email) and revokes it at `expires_at` or when the entry is removed.

## Required checks

- `ci-required / ci-required`
- `secrets-policy / secrets-policy`
- `deploy-preview / sync-and-deploy`

## Important guardrails

- Do not bypass hooks with `--no-verify` — CI will catch the same issues and may trigger security monitoring.
- Do not directly edit policy-managed files (managed workflows, `CODEOWNERS`, `.sops.yaml`, hooks, `scripts/setup-repo.sh`, `scripts/install-secrets-tooling.sh`, `scripts/app-manifest.py`, `scripts/secrets-guard.py`, `scripts/secrets.py`, distributed skill files, `secrets/inventory.yaml`, or this `QUICKSTART.md`). They're overwritten on every orchestrator reconciliation; make policy changes in [`internal-app-orchestrator`](https://github.com/internalsphere/internal-app-orchestrator) and run baseline sync.
- Don't use `vercel env add`, `vercel env pull`, `vercel dev`, or `vercel deploy` — everyone has Viewer access on `anysphere-internal`, which isn't enough for any of those. Iterate via preview deploys instead.

## Need help?

- Full guide (setup + FAQs + troubleshooting): https://www.notion.so/cursorai/internalsphere-348da74ef0458184af80e67adbcef6b7
- On-repo cheat sheet: `@internalsphere-setup` (Cursor) or [`.cursor/skills/internalsphere-setup/SKILL.md`](./.cursor/skills/internalsphere-setup/SKILL.md)
- Runbook: https://github.com/internalsphere/internal-app-orchestrator/blob/main/docs/runbooks/troubleshooting.md
- Slack: `#proj-internalsphere`
