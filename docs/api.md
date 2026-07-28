# Nexus REST API v1

Base URL: `https://<your-nexus-host>/api/v1`

## Authentication

Send `Authorization: Bearer nxpat_<token>`. Tokens are project-scoped and minted in project settings. The plaintext is shown once.

Enable the API per project with feature flag `p8.api`.

## Scopes

| Scope | Grants |
| --- | --- |
| `projects:read` | Projects and pipeline metadata |
| `items:read` | Work items, specs, runs, reports, questions, events |
| `items:write` | Create and update items and specs |
| `items:transition` | Stage transitions |
| `runs:write` | Start runs (spend) |
| `questions:write` | Answer questions |
| `webhooks:manage` | Webhook endpoints and replay |

Missing scope responses are HTTP `403` with `missing_scope` in the JSON body (RFC 9457-style problem object).

## Pagination

List endpoints accept `?cursor=` and return `next_cursor` when more data exists.

## Errors

Errors use `application/problem+json` fields: `type`, `title`, `status`, `detail`, plus extensions such as `missing_scope` or gate `blocking` on HTTP `409`.

## Idempotency

`POST` and `PUT` accept `Idempotency-Key`. Reusing a key with a different body returns HTTP `422`.

## Rate limits

Default: 600 requests per minute per token, burst 60 per second. HTTP `429` includes `Retry-After`.

When Redis is unavailable, a conservative in-process limit applies (never unlimited).

## OpenAPI

`GET /api/v1/openapi.json` serves the generated document.
