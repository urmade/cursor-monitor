# Outbound webhooks

## Subscriptions

Register HTTPS endpoints in project settings (flag `p8.webhooks`). Choose explicit event types — no wildcards.

## Signature

```
X-Nexus-Signature: t=<unix>,v1=<hex>
X-Nexus-Event-Id: evt_…
X-Nexus-Event-Type: work_item.created
X-Nexus-Delivery-Id: <uuid>
```

`v1` is HMAC-SHA256 of `"<t>.<raw body>"` using the endpoint secret (`whsec_…` shown once at creation).

### Verification (Node.js)

```js
import crypto from 'node:crypto';

const TOLERANCE_SEC = 300;

export function verifyNexusWebhook(secret, rawBody, signatureHeader, nowSec = Math.floor(Date.now() / 1000)) {
  const parts = Object.fromEntries(signatureHeader.split(',').map((p) => p.split('=')));
  const t = Number(parts.t);
  const v1 = parts.v1;
  if (!t || !v1) return false;
  if (Math.abs(nowSec - t) > TOLERANCE_SEC) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(v1, 'hex'), Buffer.from(expected, 'hex'));
}
```

Reject replays outside the five-minute window.

## Delivery

- At-least-once; dedupe on `X-Nexus-Event-Id`.
- Ordering is best-effort by `occurred_at`; retries may reorder.
- 2xx → delivered; 4xx (except 408/429) → permanent failure; 5xx/timeout/429 → backoff (1m, 5m, 15m, 1h, 6h, 24h).
- Endpoints auto-disable after 100 consecutive failures.

## SSRF

Private addresses and hostnames resolving to RFC1918 space are rejected at registration and re-checked at delivery. Redirects to private targets are not followed.

See `docs/events.md` for the catalogue.
