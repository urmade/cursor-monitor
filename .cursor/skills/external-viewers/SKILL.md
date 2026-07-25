---
name: external-viewers
description: 'Use in app repos when someone outside Anysphere needs to view a protected Vercel deployment, such as sharing a preview, demo, or pitch deck with a customer or partner. Use when adding, updating, or removing entries in `external-viewers.yml`.'
---

# External Viewers

Share a protected deployment with a specific external email address, time-bound and security-reviewed.

## When to use

- Share a preview or production deployment with someone outside Anysphere
- Extend or revoke an existing external viewer grant

## Do not use

- Sharing with Anysphere employees (they already have SSO access)

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

## Revoke

Remove the entry (or shorten `expires_at`) and merge. The orchestrator denies the viewer in Vercel before dropping it from tracked state, so removal is safe even before expiry.

## Verify

- CI validates the file shape on the PR (`ci-required`).
- After merge, the orchestrator reconciles grants on its next baseline run.
- The viewer signs in to a free Vercel account with that email.
