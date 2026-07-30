---
name: external-viewers
description: 'Use in app repos when someone outside Anysphere needs to view a protected Vercel deployment, such as sharing a preview, demo, or pitch deck with a customer or partner. Covers both per-email viewer grants and whole-project password sharing for demos. Use when adding, updating, or removing entries in `external-viewers.yml`, including a `password_sharing` block.'
---

# External Viewers

Share a protected deployment with people outside Anysphere. There are two modes, and they can be combined in the same `external-viewers.yml`:

- **Per-email viewer grants** — time-bound access for specific email addresses (each viewer needs a free Vercel account).
- **Password sharing** (`version: 2`) — one orchestrator-managed passphrase for the whole project, ideal for a live demo where the audience changes or several people open the same app, with no per-email grants and no Vercel account required.

Both modes are security-reviewed: `@internalsphere/security` is a required code-owner on `external-viewers.yml`.

## When to use

- Share a preview or production deployment with someone outside Anysphere
- Extend or revoke an existing external viewer grant
- Hand out a single shared passphrase for a customer demo (password sharing)

## Do not use

- Sharing with Anysphere employees (they already have SSO access)
- Password sharing for internal sharing or as a deployment-protection bypass — only for external customer webpages and demos

## Add

1. Create or edit `external-viewers.yml` at the repo root:

```yaml
version: 1
viewers:
  - target: <project>-preview.vercel.app
    email: partner@example.com
    expires_at: "2026-06-19T00:00:00Z"
    requested_by: "@you"
    reason: "Customer pitch review"
```

2. `target` is the deployment or alias host.
3. Keep `expires_at` as short as practical; access is denied automatically after it passes.
4. Open a PR. `@internalsphere/security` is tagged automatically for review.
5. **On merge**, the orchestrator invites the viewer in Vercel immediately. Scheduled reconcile still converges grants and revokes at `expires_at`.

## Revoke

Remove the entry (or shorten `expires_at`) and merge. Removal is applied on merge; scheduled reconcile also denies the viewer if anything was missed.

## Password sharing (whole-project demo)

For sharing webpages and demos with external customers only — not for internal sharing or as a deployment-protection bypass. Use `version: 2` and add a `password_sharing` block for a single project-wide passphrase. It can coexist with per-email `viewers`:

```yaml
version: 2
password_sharing:
  reason: "Acme live demo, week of the customer workshop"
  requested_by: "@you"
  expires_at: "2026-08-01T00:00:00Z" # optional
  rotation_id: "1"                   # optional; change it to force a new passphrase
```

To combine both modes, put `viewers` and `password_sharing` under one `version: 2`:

```yaml
version: 2
viewers:
  - target: <project>-preview.vercel.app
    email: partner@example.com
    expires_at: "2026-06-19T00:00:00Z"
    requested_by: "@you"
    reason: "Customer pitch review"
password_sharing:
  reason: "Acme live demo"
  requested_by: "@you"
```

- `version` must be `2` to use `password_sharing`. Version 1 files (viewers only) stay valid.
- There is a **single** top-level `version` key. To use password sharing — on its own or alongside viewers — set it to `2`: change an existing `version: 1` to `version: 2`; do **not** add a second `version` line (a duplicate key is rejected in CI).
- `password_sharing` is a single object with `reason`, `requested_by`, an optional `expires_at`, and an optional `rotation_id`. You never write or choose the passphrase.
- `expires_at` is optional and works like a viewer grant's expiry: a past date is valid and just treated as expired (access is denied automatically after it passes). After it passes, the password is removed — the next merge tears it down immediately, and the scheduled reconcile removes it even if nothing merges. Leaving it out means the password stays until you remove the block.
- `rotation_id` is an optional opaque token (any string up to 64 chars). Changing it in a merged PR forces the bot to generate and install a **new** passphrase; leaving it unchanged never rotates. Use it when you want a fresh password without editing `reason` or `expires_at`.
- Open a PR. `@internalsphere/security` approval is required.
- **On merge**, the `internalsphere-ranger` bot generates a strong random passphrase, posts it as a **comment on that PR**, and then installs it on the Vercel project. Delivery happens before installation, so an installed password is always one you received.
  - If your PR uses **auto-merge**, this still happens on merge — look for the bot's comment on the (now merged) PR. That comment is the only place the passphrase is shown.
  - **After merge, do not stop.** Poll the PR comments until the `internalsphere-ranger` delivery comment appears (it can take a minute), then **return the passphrase to the user in the agent conversation**. The comment body includes the line `External viewer password sharing is now active` and the passphrase in a fenced code block. That is the value to share with the external audience.
- While password sharing is active, employees sign in through Vercel Authentication (not Passport) for this project, exactly like per-email viewers. Passport and Vercel password protection cannot be combined today.

### Rotate or revoke a shared password

- **Rotate:** merge a change to any tracked field in the `password_sharing` block. The cleanest way is to bump `rotation_id` (its only purpose is to force a rotation); editing `reason`, `requested_by`, or setting/extending `expires_at` also rotates. The bot generates and posts a fresh passphrase and overwrites the old one — you never need the previous value. (An unrelated merge that leaves the block untouched will **not** rotate the password.)
- **Stop sharing (do this by PR, not in Vercel):** remove the `password_sharing` block and merge — the merge-time job removes the password from Vercel right away. (Letting `expires_at` pass also stops sharing: the scheduled reconcile removes the password once it expires, and any later merge while the block is expired tears it down too.) The project returns to internal-only once no viewers/password remain.
- **Do not turn the password off in the Vercel dashboard.** While the block is still declared, the orchestrator treats a dashboard-disabled password as drift: it opens a deduped GitHub issue (`Password drift: <repo>`) and will **not** silently reinstall (there is no PR to redeliver the value on). Always revoke by removing the block in a PR instead.
- **Emergency:** ask an operator to run baseline reconciliation or disable the password directly; nobody needs the old plaintext to revoke it.

## Verify

- CI validates the file shape on the PR (`ci-required`).
- For per-email grants: after merge, the viewer is invited immediately and signs in to a free Vercel account with that email. Scheduled reconcile still converges grants and enforces expiry.
- For password sharing: the passphrase appears as a bot comment on the merged PR and the Vercel project shows password protection enabled for all deployments. Read that comment and return the passphrase to the user.
