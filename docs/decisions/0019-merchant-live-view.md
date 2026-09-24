# 0019: Merchant app live view: ticker, same-time comparison, cashiers, alert settings

- Status: Accepted
- Date: 2026-09-24
- Build plan: P11. Bible: L30, L31, L37 (settings part), L38 (per-merchant thresholds)
- Extends: ADR 0012 (ops layer, `/ws`), ADR 0014 (cashier on events)

## Decisions

### 1. The ticker rides the existing `/ws` channel
The live sales feed (`adpay_sale` NOTIFY on commit, P4) now carries:

- `location_id`;
- `register_name` ("Register 1 · Main St");
- `cashier_name`: the person signed in at completion.

These are looked up once per ingested batch. The merchant app seeds the ticker from
`/merchant/sales` so it is never empty on open, prepends live messages, and refreshes the figures
1.5 s after the last live sale. If the socket is down, everything still loads; only the "live"
dot changes.

### 2. "Up 12%" compares like with like
`GET /merchant/sales/compare` returns today, yesterday and the same weekday last week in
store-local time, each with its total, its hourly buckets and a **so-far** figure cut at the
current time of day. So at 2:40pm, today is compared with yesterday up to 2:40pm. The percentages
are integer **tenths of a percent**, rounded half away from zero (`pctChangeTenths`), and `null`
when the earlier day had no sales. There are no floats anywhere in the path.

### 3. Cashier = who was signed in when the sale completed
`by_cashier` in the sales summary, and `cashier_name` on ticket rows, use the `actor_user_id` on
`sale.completed` (P3). Sales rung before anyone signed in group as "No one signed in".

### 4. Alert settings per merchant
`merchants.alert_settings` (jsonb, `AlertSettingsInput`) holds:

- `muted` (merchant-facing rules only);
- `large_refund_cents`, default $25;
- `drawer_short_cents`, default $5;
- `no_sale_spike`, default 5.

The rules still run for everyone. A muted alert is still opened, because AD Pay support sees it;
it is only hidden from the merchant's inbox, the realtime push and notifications (`Alert.muted`).
The queries fetch at the loosest allowed bound and each merchant's threshold filters the result,
so one pass still serves every merchant. Editing the settings needs `reports.view`, meaning the
people who see the figures (owners and, by default, managers).

## Not here
- Push, SMS and WhatsApp delivery (accounts ⛔).
- Terminal and paper-out readings (hardware ⛔).
- Multi-store roll-up (N, P19).
