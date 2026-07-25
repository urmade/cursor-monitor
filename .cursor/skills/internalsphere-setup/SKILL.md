---
name: internalsphere-setup
description: Explains what internalsphere is and answers common questions about setup, deploys, environment variables, secrets, integrations, Vercel access, Passport identity/JWTs, SSH/SSO, branch protection, Bugbot, and the role of the orchestrator. Use when the user asks anything like "why can't I X", "how do I X", "can I X", where X is deploying, reading the signed-in Passport user, running `vercel env pull` / `vercel dev`, adding or editing env vars, force-pushing to `main`, or anything involving `internalsphere`, the `internalsphere-ranger` bot, `anysphere-internal` on Vercel, or the `internal-app-orchestrator`. Also use for first-time repo setup (SSH keys, `sh scripts/setup-repo.sh`, brew dependencies, Vercel access on Okta) and for troubleshooting common baseline errors. Prefer this skill over guessing whenever the question is about *how the internalsphere platform works*, even if the question is phrased casually.
---

# internalsphere (setup + FAQs)

This skill is the on-repo cheat sheet for how internalsphere works. It is distributed to every app repo by the orchestrator and stays in sync with the friendly guide at:

- https://www.notion.so/cursorai/internalsphere-348da74ef0458184af80e67adbcef6b7

You can link the user to that Notion doc for the full story, or explore it yourself via the Notion MCP if you have access. Use this file for quick, in-repo answers; reach for Notion when the user wants more depth or when this file doesn't cover the question.

## What is internalsphere?

**internalsphere** is the GitHub organization (github.com/internalsphere) plus the Vercel team (`anysphere-internal`) that hosts Cursor's internal apps. A control-plane repo called `internal-app-orchestrator` (also called the "ranger") watches every app repo and keeps it configured correctly:

- Creates and links the Vercel project.
- Seeds `app-manifest.yml`, `.sops.yaml`, `secrets/`, CI workflows, and Cursor skills.
- Sets branch protection, CODEOWNERS, and security rulesets.
- Deploys preview on every PR and production on every merge to `main`.
- Opens a baseline PR to fix any drift, auto-admin-merged by the `internalsphere-ranger` bot.

**Mental model:** the app repo owns app code; the orchestrator owns everything else. Do not edit managed files (workflows, CODEOWNERS, `.sops.yaml`, hooks, `scripts/secrets*.py`, distributed skill files, `secrets/inventory.yaml`, `QUICKSTART.md`) — they will be overwritten on the next reconciliation.

## First-time setup (do this once on your laptop)

1. **Join the GitHub org.** Open [Okta](https://anysphere.okta.com/app/UserHome?session_hint=AUTHENTICATED), find the `GitHub - Internalsphere` tile, and launch GitHub from there. Do not try to sign in to GitHub directly. If the tile is missing, post in `#it-help`.
2. **Authorize your SSH key for internalsphere (most common setup error).** `anysphere` and `internalsphere` are separate GitHub orgs, so SSH access must be SSO-authorized for each one. If you already use GitHub for `anysphere`, you almost certainly have a working key — just go to https://github.com/settings/keys, click **Configure SSO** next to the key, and enable it for `internalsphere`. Test with `ssh -T git@github.com` (should say "Hi <your-username>!"). If `git clone` fails with "Permission denied (publickey)" or "Repository not found", 99% of the time this step is the fix.
3. **Install basics:**
   ```bash
   brew install git gh sops age python pnpm node
   gh auth login
   ```
4. **Vercel access (optional).** Open [Okta](https://anysphere.okta.com/app/UserHome?session_hint=AUTHENTICATED), find the `Vercel-Internal` tile, and launch Vercel from there. Do not try to sign in to Vercel directly. If the tile is missing, post in `#it-help`. Viewer access is enough to view deploys, but **not** enough to view env var names/values or run `vercel env pull` or `vercel dev`. Use the PR preview flow instead (see [Can I run `vercel env pull`, `vercel dev`, or `vercel deploy` locally?](#can-i-run-vercel-env-pull-vercel-dev-or-vercel-deploy-locally) below).

## Per-repo setup

After cloning:

```bash
sh scripts/setup-repo.sh
```

This installs git hooks (including `secrets-guard.py`, which blocks commits with plaintext secrets) and local tooling. Run it once per repo. It does **not** pull Vercel environment variables or link your laptop to the project; managed CI handles Vercel linking and env sync during preview/production deploys.

## Creating a new app

1. Create an empty repo under the **`internalsphere`** org. Pick a clear name. Make it **Private** or **Internal**. Use `main` as the branch.
2. Wait a minute or two. The orchestrator picks up the new repo and bootstraps it (Vercel project, branch protection, `app-manifest.yml`, `.sops.yaml`, `secrets/`, workflows, Cursor skills), opens a bootstrap PR, and admin-merges it automatically via the `internalsphere-ranger` bot.
3. Clone, run `sh scripts/setup-repo.sh`, and push app code.

You do **not** need to scaffold anything by hand — the bootstrap PR does it for you.

## Making changes to an existing app

1. Clone, run `sh scripts/setup-repo.sh` (once per repo).
2. Branch: `git checkout -b my-change`.
3. Commit and push.
4. Open a PR. The `internalsphere-ranger` bot posts the preview URL. Bugbot + Security Bugbot leave review comments. CI runs lint/secret-scan/etc.
5. Merge when green. The orchestrator deploys to production automatically.

Every PR gets its own preview URL with the real preview env. Demo on it, iterate on it, merge once it looks right.

> 🤖 **If two preview-URL comments show up on your PR, use the one from the `internalsphere-ranger` bot — ignore the `Vercel` bot's.**

## Deploying your changes

The short version: **you do not run any deploy commands**. Pushing to GitHub *is* deploying.

1. **Open or push to a PR** → Vercel publishes a **preview deploy** at a unique URL, posted as a comment on the PR by the `internalsphere-ranger` bot. Every new push to the PR updates that same preview URL.
2. **Merge the PR into `main`** → Vercel publishes a **production deploy**.

That's the whole flow. There is nothing to run from your laptop.

> 🚫 **You can't `vercel deploy` from your laptop, and you shouldn't try.** Everyone on `anysphere-internal` has **Viewer** access on Vercel, which can't deploy at all — and even with higher access, deploys must go through the managed GitHub Actions workflow so `secrets/` get decrypted, env vars get synced, and the audit inventory gets written.

## Reading signed-in user identity from Passport

On Passport-protected projects, Vercel forwards the authenticated Passport session as a Vercel-signed JWT in the `x-vercel-oidc-passport-token` request header.

- Read this header **only in server-side code**. Do not expose the token to browser JavaScript or read identity from the `_vercel_passport` cookie.
- Vercel strips any client-supplied value for this header and injects the token after Passport validates the session. Parse it only within that protected Vercel request boundary.
- Use the `external_sub` claim as the stable user ID. The `sub` and `scope` claims also include the owner, `connector_id`, and `external_sub` in Vercel's stable format.
- Treat `email`, `name`, and other profile fields as optional. Okta may return them, but Passport does not guarantee them.
- Validate that the token has a JWT shape and that `external_sub` is a non-empty string before creating an application user/session. Use the app's existing server-side JWT library rather than hand-rolling parsing.
- A missing header means there is no Passport identity. This is expected in local development, on unprotected requests, and on projects that retain Vercel Authentication for external viewers. Do not fall back to user-supplied identity headers; require a separately approved application-auth mechanism if those projects need in-app identity.

Reference: https://vercel.com/docs/passport#access-visitor-identity

## Environment variables and secrets

All env vars — sensitive or not — go through SOPS-encrypted files in `secrets/` and flow to Vercel as sensitive env vars. Use `scripts/secrets.py` (see the `secrets-operations` skill for full details):

```bash
python3 scripts/secrets.py list --scope local
python3 scripts/secrets.py list --scope remote --env production
python3 scripts/secrets.py add    --scope production --key MY_VAR
python3 scripts/secrets.py update --scope production --key MY_VAR
python3 scripts/secrets.py delete --scope production --key MY_VAR
```

Scopes: `shared` (all envs), `preview`, `production`. Keys must match `^[A-Z][A-Z0-9_]*$`. Commit the resulting `secrets/<scope>/<KEY>.sops.json`, open a PR, merge — CI syncs to Vercel.

**Never** paste plaintext values into `.env` files, code, tests, commit messages, or `vercel env add`. The `secrets-guard.py` pre-commit hook, CI scanning, and Security Bugbot all catch it.

## Integrations (databases, caches, storage)

Declare integrations in `app-manifest.yml` under `integrations:`. Each entry is keyed by an **alias you choose**:

```yaml
version: 1
integrations:
  db:
    type: supabase
  cache:
    type: upstash-kv
  assets:
    type: blob
```

`version: 1` is the **manifest schema version**, not a per-change revision — leave it at `1`. The orchestrator only bumps it when the schema itself changes in a backwards-incompatible way. Do not increment it when you add, remove, or edit integrations or any other manifest fields.

The alias is prepended to the integration's canonical env var names:

| Alias | Type | Example env vars |
| --- | --- | --- |
| `db` | `supabase` | `DB_POSTGRES_URL`, `DB_SUPABASE_URL`, `DB_SUPABASE_SERVICE_ROLE_KEY`, … |
| `cache` | `upstash-kv` | `CACHE_KV_REST_API_URL`, `CACHE_KV_REST_API_TOKEN` |
| `assets` | `blob` | `ASSETS_READ_WRITE_TOKEN` |

Open a PR and merge. The orchestrator provisions the backing resource and injects credentials into Vercel. The next deploy picks them up. Use the distributed per-integration skills for hands-on guidance: `supabase-database`, `upstash-redis`, `vercel-blob-store`.

## Sharing with external viewers

To share a deployment with a specific person outside Cursor (customer demo, partner pitch), add a time-bound grant to `external-viewers.yml` at the repo root:

```yaml
version: 1
viewers:
  - target: my-app-preview.vercel.app
    email: partner@example.com
    expires_at: "2026-06-19T00:00:00Z"
    requested_by: "@you"
    reason: "Customer pitch review"
```

Open a PR — `@internalsphere/security` is tagged automatically for review. After merge, the orchestrator grants access in Vercel and revokes it at `expires_at` or when the entry is removed. `target` is the deployment or alias host. The viewer signs in to a free Vercel account with that email. Grants apply on the next reconciliation (daily; ask in `#proj-internalsphere` for an urgent run).

## FAQs

### How do I get access to internalsphere?

You probably already have access. Open [Okta](https://anysphere.okta.com/app/UserHome?session_hint=AUTHENTICATED) and look for the `Vercel-Internal` and `GitHub - Internalsphere` tiles. Launch these apps from Okta; do not try to sign in to Vercel or GitHub directly.

If you do not see the tile you need, post in `#it-help`. If the tiles are present, you already have access.

### I don't see internalsphere in Cursor cloud agents. What should I do?

If you are trying to use cloud agents with `internalsphere` and don't see it, it's likely you need to reconnect your GitHub account (your token needs to be picked up with SSO approval). Open https://cursor.com/dashboard/integrations; under GitHub you should see an error message like:

> internalsphere is missing due to SSO – reconnect to authorize access

Click **reconnect** and complete the flow. If you still do NOT see `internalsphere` after that, ask in `#proj-internalsphere`.

### I opened an internalsphere deployment and see "You need access." What should I do?

Reopen the deployment URL and complete the Okta Passport sign-in flow. Most deployments use the `internalsphere-okta-passport` identity provider application. Projects configured for external viewers keep Vercel Authentication instead: Cursor employees should launch the `Vercel-Internal` Okta tile, while approved guests sign in to Vercel with the exact email address in their grant. If the expected flow denies access, post in `#it-help`.

### Who can access my app?

By default, Passport-protected through Cursor's Okta identity provider. Declaring an external viewer switches the project to Vercel Authentication so approved guests can sign in with their granted email. See [Sharing with external viewers](#sharing-with-external-viewers) above.

### How do I share my app with someone outside Cursor?

Add a time-bound grant to `external-viewers.yml` and open a PR; security approval is required automatically. See [Sharing with external viewers](#sharing-with-external-viewers) above or `@external-viewers`.

### A webhook integration is blocked by deployment protection. What should I do?

Deployment protection blocks unauthenticated webhook requests. If a third-party provider such as Slack or Stripe needs to send webhooks to your app, ask in `#proj-internalsphere` for a Protection Bypass for Automation and explain which integration needs it and why.

### Do I need to set anything up on Vercel myself?

No. The orchestrator creates the project, links the repo, configures environments + guardrails (Passport by default, Vercel Authentication for external-viewer projects, fork protection, no-direct-deploys), and syncs env vars. Your job: write code and open PRs.

### How do I transfer an existing repo to internalsphere?

**Admin:** Transfer only the GitHub repo to `internalsphere`. The orchestrator will scaffold it and create a new Vercel project in **Anysphere - Internal** (`anysphere-internal`); once that exists, delete the old Vercel project. **Do not transfer the existing Vercel project.**

**Repo owner:** If the transferred app has application-level issues after bootstrap, troubleshoot and resolve them.

### Which bot's preview-URL comment should I trust?

The `internalsphere-ranger` bot. If a comment from the `Vercel` bot also shows up on your PR, ignore it — `internalsphere-ranger` is the source of truth.

### How do my changes get deployed?

See [Deploying your changes](#deploying-your-changes) above.

### How do I find my deployments on Vercel?

All internalsphere apps live under https://vercel.com/anysphere-internal — click your repo name to open the project, then go to the **Deployments** tab. It lists every preview + production deploy (the top Production entry has the canonical app URL), and each deploy has its own **Build Logs** and **Runtime Logs** — usually the fastest path to diagnosing a broken build or runtime error.

Direct link if you know the project name: `https://vercel.com/anysphere-internal/<PROJECT-NAME-HERE>/deployments`.

### What if I don't see a preview URL on my PR?

Find your project under https://vercel.com/anysphere-internal and check its deployments at `https://vercel.com/anysphere-internal/<PROJECT-NAME-HERE>/deployments`.

### How do I roll back a bad deploy?

Revert the PR on GitHub (use the "Revert" button on the merged PR) and merge the revert. Git stays in sync with what's live.

### Why is my deployed app showing a 404?

The deploy went green but the page says "Not Found". Start with Vercel's walkthrough:

📖 [Why is my deployed project giving a 404?](https://vercel.com/kb/guide/why-is-my-deployed-project-giving-404)

The most common causes:

1. **You're on the wrong URL.** A project's default `*.vercel.app` hostname can be either `{project}.vercel.app` or `{project}-{teamSlug}.vercel.app` (e.g. `web-playground-weld.vercel.app`) — Vercel picks one at creation and it isn't always predictable. Confirm the canonical URL from the project's Deployments tab at `https://vercel.com/anysphere-internal/<PROJECT-NAME-HERE>/deployments` and click the live URL listed there.
2. **Wrong framework preset.** For Next.js apps, Vercel must use the Next.js framework adapter. If the dashboard shows **Framework Preset = Other**, pin it from the repo with a `vercel.json`:
   ```json
   { "framework": "nextjs" }
   ```
   Do not point `outputDirectory` at `.next` for a server-rendered Next.js app — that can make Vercel deploy build internals instead of the Next.js runtime.
3. **Wrong "Output Directory" in Project Settings.** Static or SPA apps can 404 when Vercel serves the wrong folder. Use a concrete value such as `"dist"` or `"public"` only when your framework really emits static files there. For Next.js apps, prefer the framework preset above and omit `outputDirectory`.
4. **Wrong Root Directory** (monorepos). If the **Build Logs** show `npm install` / `next build` running at the repo root when your app actually lives in a subfolder — or you see "no framework detected" — Vercel is pointing at the wrong directory. Not a `vercel.json` knob; set `vercel.root_directory` in `app-manifest.yml` (e.g. `dashboard`) and the orchestrator will reconcile it on the next run.
5. **Single-page app missing a rewrite.** Vite, CRA, and other client-only apps need a catch-all so deep links don't 404:
   ```json
   { "rewrites": [{ "source": "/(.*)", "destination": "/index.html" }] }
   ```

Still stuck? The Vercel doc also points at the dashboard's **Build Logs** and **Runtime Logs** tabs — those usually pinpoint the actual error. Otherwise, drop the URL into `#proj-internalsphere`.

### How do I add or update an environment variable?

See [Environment variables and secrets](#environment-variables-and-secrets) above (or `@secrets-operations`).

### Can I run `vercel env pull`, `vercel dev`, or `vercel deploy` locally?

**No** — none of these work for internalsphere apps. Everyone on `anysphere-internal` has **Viewer** access on Vercel, which means you won't be able to run:

- `vercel env pull` and `vercel dev` (which depends on it)
- `vercel deploy` and `vercel --prod`

These limits exist to contain credentials sprawl. Production credentials — API keys, OAuth tokens, database passwords — are only decrypted inside the ephemeral GitHub Actions runner that runs the deploy, and never touch anyone's laptop. The fewer places these credentials live, the smaller the blast radius when something upstream goes wrong — see, for example, [Vercel's April 2026 security incident](https://vercel.com/kb/bulletin/vercel-april-2026-security-incident).

**To iterate, just open a PR and keep pushing to it.** Every push redeploys to the same preview URL with the real preview env — that's the supported way to test changes end-to-end. No local Vercel CLI needed. If you genuinely need broader Vercel access for a specific reason, ask in `#proj-internalsphere`.

### Is it safe to put secrets in git?

**Not** safe usually, and will get caught: raw values in `.env` files, code, tests, PR descriptions, or commit messages. The `secrets-guard.py` pre-commit hook, CI secret scanning, and Security Bugbot all catch these.

The clean path is to always use `scripts/secrets.py` (see [Environment variables and secrets](#environment-variables-and-secrets) above). This is safe because the secrets are **encrypted**.

### Why can't I force-merge into `main`?

`main` is protected by a GitHub ruleset that requires a PR, passing CI, and CODEOWNER approval for managed files. This is intentional: `main` is what Vercel deploys to production. The only thing that can admin-merge is the `internalsphere-ranger` bot, and only for its own baseline PRs.

The PR requirement is also a built-in smoke test: every PR builds and deploys to its own preview URL, so a broken build, missing env var, or runtime error shows up there *before* you ship to production. Force-merging would skip that safety net entirely. If you genuinely need to break glass, ask in `#proj-internalsphere`.

### Why do we have Bugbot and Security Bugbot on every PR?

Internal apps often talk to real customer data or production systems, which makes them juicy targets. **Bugbot** reviews code for bugs and quality. **Security Bugbot** hunts for leaked secrets, unsafe SQL, XSS, missing authN/authZ, dangerous shell calls. They comment as normal reviewers; almost never hard-block.

## Troubleshooting

### `git clone` fails with "Repository not found" or "Permission denied (publickey)"

Your SSH key isn't SSO-authorized for `internalsphere`. Go to https://github.com/settings/keys, find the key, click **Configure SSO**, enable it for both `anysphere` and `internalsphere`, retry.

### My bootstrap PR never showed up after creating a new repo

Bootstrap usually kicks off within a minute. If nothing happens after a few, double-check the repo is under `internalsphere` (not `anysphere`); if it is, ping `#proj-internalsphere` — they can manually kick off bootstrap if the webhook got missed.

### CI is failing with a SOPS / decryption error

The age public keys in the repo's `.sops.yaml` got out of sync with the org-level secret that holds the private keys. Ask in `#proj-internalsphere`.

### A pre-commit or pre-push hook is blocking me

Usually `secrets-guard.py` caught a plaintext secret. **Do not use `git commit --no-verify`** — CI will catch it anyway. Instead, move the value into `secrets/<env>/` via `python3 scripts/secrets.py add`. If it's a false positive (e.g. a test fixture that looks like a key), add a comment explaining and ping `#proj-internalsphere`.

### I need to change something that's managed (CI file, Vercel setting, branch ruleset)

Don't edit the managed file directly — it will be overwritten. App-specific toggles live in `app-manifest.yml`; change them there. If you're not sure, ask in `#proj-internalsphere`.

### My deploy is green but the URL 404s

See [Why is my deployed app returning a 404?](#why-is-my-deployed-app-returning-a-404) above — the usual suspects are wrong hostname, wrong framework preset, wrong Output Directory in Project Settings, missing SPA rewrite, or a deprecated function runtime. The Vercel KB has the canonical checklist: https://vercel.com/kb/guide/why-is-my-deployed-project-giving-404.

## Where to get help

- **Slack:** `#proj-internalsphere` for questions or bugs.
- **Full guide:** https://www.notion.so/cursorai/internalsphere-348da74ef0458184af80e67adbcef6b7
- **Orchestrator repo:** https://github.com/internalsphere/internal-app-orchestrator
