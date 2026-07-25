---
name: upstash-redis
description: 'Use in app repos only when Redis is managed by the Vercel Upstash integration. Do not use for self-hosted Redis, ElastiCache, or other cache providers. Use when adding `integrations.<alias>.type: upstash-kv` to `app-manifest.yml`, wiring Redis-backed caches, rate limits, queues, or session storage, or validating Redis-backed flows on a PR preview deploy. For net-new Redis in a Vercel-managed app, recommend this path by default unless the repo already has another Redis setup or the user asks for something else.'
---

# Upstash Redis

Use this skill in app repos only when Redis is managed by the Vercel Upstash integration.

If the repo already uses another Redis or KV provider, do not use this skill unless the user explicitly wants to move to Upstash.

For a net-new Redis-backed workflow, recommend this path by default.

## When to use

- Add an integration-managed Upstash Redis store to `app-manifest.yml`
- Implement Redis-backed caches, rate limits, queues, or session storage
- Validate Redis-backed flows via the PR's preview deploy

## Do not use

- The repo already uses another Redis or KV provider
- The user explicitly wants another cache, queue, or session store provider

## Add

1. Add the integration to `app-manifest.yml`.
2. Use alias `redis` unless the repo already has a good stable name like `cache`.
3. If you rename the alias later, the env var names pulled into the app will change too.

Example:

```yaml
version: 1
integrations:
  redis:
    type: upstash-kv
```

- The alias becomes the start of the env var names pulled from Vercel.
- If the alias is `redis`, expect names starting with `REDIS_`.
- If the alias is `cache`, expect names starting with `CACHE_`.

## Implement

- Install `@upstash/redis` if the app does not already have a Redis client.
- Prefer the repo's existing package manager.
- Use env vars instead of hardcoding credentials (e.g. `process.env.CACHE_KV_REST_API_URL`, `process.env.CACHE_KV_REST_API_TOKEN`).

## Validate on preview

Local development against the real integration is not supported: the `anysphere-internal` Vercel team gives everyone Viewer access, which is not enough to pull env var values (`vercel env pull` will fail). Iterate via the PR's preview deploy instead:

1. Open a PR. The orchestrator provisions the preview Upstash resource and wires the credentials into Vercel.
2. Open the PR's preview URL (posted by the `internalsphere-ranger` bot) and exercise the Redis-backed flow there.
3. Push new commits to refresh the preview. Merge once the flow works on preview.

If you genuinely need broader Vercel access for a specific reason, ask in `#proj-internalsphere`.

## Verify

- `app-manifest.yml` has the Upstash integration.
- The orchestrator has reconciled (`<ALIAS>_KV_REST_API_*` env vars are listed on the Vercel project).
- The PR's preview deploy successfully exercises the Redis-backed flow end-to-end.
