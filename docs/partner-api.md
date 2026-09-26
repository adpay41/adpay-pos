# AD Pay partner API (v1)

For partners a store has agreed to share its data with: a bookkeeper's sync, a delivery or loyalty
app. **Read-only.** One API key reads **one store**, within its scopes. AD Pay support creates keys
and webhooks in the admin console (Partners) at the store's request.

## Authentication

```
Authorization: Bearer adp_<8 chars>_<secret>
```

The key is shown once, when it is created. We store only a hash, so a lost key is replaced, not
recovered. A revoked key stops working immediately. Anything else gets `401`. A valid key without the
route's scope gets `403`.

## Endpoints

| Method and path | Scope | Returns |
| --- | --- | --- |
| `GET /v1/me` | any | `{ merchant_id, scopes }` |
| `GET /v1/sales?from=YYYY-MM-DD&to=YYYY-MM-DD` (up to 31 days) | `sales:read` | completed sales (see below) |
| `GET /v1/items` | `catalog:read` | `item_id`, `name`, `category`, `cash_price_cents`, `card_price_cents`, `active`, `barcodes` |
| `GET /v1/inventory[?location_id=…]` | `inventory:read` | per tracked item: `on_hand`, `reorder_point`, `low` |

Each completed sale has these fields:
- `sale_id`, `location_id`, `register_id`
- `completed_at`, `business_date` (the store's local date)
- `price_mode` (`cash` / `card` / `split`)
- `subtotal_cents`, `tax_cents`, `total_cents`
- `refunded_cents`, `voided`

**Money is always integer cents.** No card data (the store's card terminal talks to the processor
directly; AD Pay never has it), and no customer data.

## Webhooks

Webhooks are sent as `POST` with a JSON body. They are configured per store for any of
`sale.completed`, `sale.refunded`, `sale.voided` and `eod.closed`.

```json
{
  "id": "<event id>",
  "type": "sale.completed",
  "created": "2026-09-26T14:03:11.000Z",
  "merchant_id": "…",
  "location_id": "…",
  "register_id": "…",
  "data": { "sale_id": "…", "price_mode": "cash", "subtotal_cents": 1398, "tax_cents": 93, "total_cents": 1491 }
}
```

Each request carries these headers:
- `AdPay-Event-Id`: use it to de-duplicate, since a delivery can arrive more than once;
- `AdPay-Delivery-Id`;
- `AdPay-Signature: t=<unix seconds>,v1=<hex>`.

**Verify every request.** Compute `HMAC-SHA256(secret, "<t>.<raw body>")` and compare it to `v1`
in constant time. Reject timestamps more than 5 minutes old. The signing secret (`whsec_…`) is shown
once and can be rotated.

**Respond 2xx within 10 seconds.** Anything else is retried after 1 min, 5 min, 30 min, 2 h, 6 h and
12 h. After the last retry, the delivery is marked failed; support can send it again. We don't follow
redirects. Endpoints must be `https` on a public host.

Events reach us when the register syncs. A store that was offline sends its sales when it comes
back, so `created` (when it happened) can be well before the delivery.
