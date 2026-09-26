# 0039: Partner API keys and signed webhooks

- Status: Accepted
- Date: 2026-09-26
- Build plan: P25a. Bible 3.4 (API keys & webhooks for partners)
- Partner docs: [`docs/partner-api.md`](../partner-api.md)

## Decisions

### 1. Keys are per store, scoped, read-only, hashed
- **Format:** a key is `adp_<prefix>_<secret>`. The prefix finds the row; only a SHA-256 of the whole
  key is kept, compared in constant time. The key is returned once, in the create response.
- **Scopes:** `sales:read`, `catalog:read` and `inventory:read`. There is nothing that writes. A
  partner changing prices or sales is a separate decision, with its own review.
- **Management:** AD Pay support creates and revokes keys in the admin console. Every action is
  audited.
- **Separate from staff auth:** API keys are not a `Principal` kind. `/v1/*` has its own guard, so a
  key can't reach any other route, and no staff token reaches `/v1`.
- **Last used** is recorded to the minute.

### 2. Webhooks are queued with the sale, posted by the job, signed
- **Queueing:** `ingestEvents` queues `webhook_deliveries` in the same transaction that stores the
  register's events. One row per (endpoint, event), unique, so a re-synced event is never queued
  twice. A partner gets the sale once it is ours, no sooner and never lost.
- **What's sent:** the body is built field by field (`webhookBody`), with integer cents, no card data,
  no customer data and no receipt link.
- **Delivery:** the maintenance job runs every 15 s. It claims due rows with a 5-minute lease (`SKIP
  LOCKED`), then posts outside any transaction.
- **Signature:** `AdPay-Signature: t=…,v1=HMAC-SHA256(secret, "t.body")`, Stripe-style, so partners
  know the pattern.
- **Retries:** 1 min, 5 min, 30 min, 2 h, 6 h and 12 h, then `failed`. Support can send a delivery
  again, rotate the secret or turn the endpoint off. Turning it off gives up its pending deliveries.
- **Seam:** `WebhookTransport`. `http` (fetch, 10 s timeout, no redirects) in the server; a recorder
  in tests.

### 3. Where a webhook may point
- `https` to a public host only, with no credentials in the URL.
- Private, loopback, link-local and `.internal` / `.local` address literals are refused.
- `http://localhost` is allowed outside production, for development.

**Limit:** a public hostname that *resolves* to a private address (DNS rebinding) is not caught by
the literal check. Before production, the transport should resolve and pin the address, or go out
through an egress proxy. This is noted for the AWS deploy.

## Not in v1
- Self-serve keys from the merchant app (support creates them at the store's request).
- Write scopes, OAuth for partner apps, rate limits per key (the API sits behind the same server
  limits).
