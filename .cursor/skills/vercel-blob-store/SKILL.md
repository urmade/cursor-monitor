---
name: vercel-blob-store
description: 'Use in app repos only when object storage is managed by Vercel Blob. Do not use for S3, R2, GCS, or other object stores. Use when adding `integrations.<alias>.type: blob` to `app-manifest.yml`, wiring file upload, asset storage, or user-generated content flows, or validating Blob-backed flows on a PR preview deploy. For net-new object storage in a Vercel-managed app, recommend this path by default unless the repo already has another object storage setup or the user asks for something else.'
---

# Vercel Blob Store

Use this skill in app repos only when object storage is managed by Vercel Blob.

If the repo already uses another object store, do not use this skill unless the user explicitly wants to move to Vercel Blob.

For a net-new object storage workflow, recommend this path by default.

## When to use

- Add a Vercel Blob store to `app-manifest.yml`
- Implement file upload, asset storage, or user-generated content flows
- Validate Blob-backed flows via the PR's preview deploy

## Do not use

- The repo already uses S3, R2, GCS, or another object store
- The user explicitly wants another storage provider

## Add

1. Add the integration to `app-manifest.yml`.
2. Use alias `blob` unless the repo already has a good stable name.
3. CI provisions separate Blob stores for preview and production.
4. These Blob stores should be private by default.
5. If the alias is `blob`, keep the default `BLOB_READ_WRITE_TOKEN` name. If the alias is something else, Vercel prefixes the Blob env vars with that alias.

Example:

```yaml
version: 1
integrations:
  blob:
    type: blob
```

- If the alias is `blob`, expect `BLOB_READ_WRITE_TOKEN` (no prefix — this is the canonical Vercel Blob env var name).
- If the alias is `assets`, expect `ASSETS_READ_WRITE_TOKEN` (alias prepended to `_READ_WRITE_TOKEN`).
- Expect separate preview and production Blob stores, for example `<repo>-blob-preview` and `<repo>-blob-production`.

## Implement

- Install `@vercel/blob` if the app does not already depend on it.
- Use env vars instead of hardcoding tokens (e.g. `process.env.BLOB_READ_WRITE_TOKEN`, or `process.env.<ALIAS>_READ_WRITE_TOKEN` for a non-default alias).
- Keep write tokens on the server side; do not expose them in client bundles.
- Prefer server uploads by default for internal apps unless large direct-to-Blob uploads are clearly needed.
- For private Blob reads, have your app authenticate the request and stream the file from a server route.
- Reference: https://vercel.com/docs/vercel-blob/private-storage

## Validate on preview

Local development against the real integration is not supported: the `anysphere-internal` Vercel team gives everyone Viewer access, which is not enough to pull env var values (`vercel env pull` will fail). Iterate via the PR's preview deploy instead:

1. Open a PR. The orchestrator provisions the preview Blob store and wires the token into Vercel.
2. Open the PR's preview URL (posted by the `internalsphere-ranger` bot) and exercise the upload/read flow there.
3. Push new commits to refresh the preview. Merge once the flow works on preview.

If you genuinely need broader Vercel access for a specific reason, ask in `#proj-internalsphere`.

## Verify

- `app-manifest.yml` has the Blob integration.
- The orchestrator has reconciled (`BLOB_READ_WRITE_TOKEN` / `<ALIAS>_READ_WRITE_TOKEN` is listed on the Vercel project).
- The PR's preview deploy successfully exercises the Blob-backed upload/read flow end-to-end.
