# 0030: Multi-store roll-up, accountant access, cashier performance, three more alerts

- Status: Accepted
- Date: 2026-09-26
- Build plan: P19b. Bible 2.1 (multi-store roll-up), 2.2 (accountant access, read-only;
  QuickBooks/Xero), 2.5 (cashier performance), 2.6 (big ticket; slow hour; late first sale)
- Extends: ADR 0011 (roles and permissions), ADR 0012 (alert rules), ADR 0019 (alert settings)

## Decisions

### 1. Roll-up: every store the person may see reports for
`GET /merchant/rollup?range=today|week|month` covers every membership of the signed-in person where
their role (with that merchant's permission overrides) includes `reports.view`. A cashier membership
elsewhere adds nothing.

For each store it shows:
- tickets, gross, average ticket and card share;
- the same-length period before, compared on each store's own local days.

The merchant app shows it on the Sales tab only when there are two or more stores. The existing
store switcher stays the way into one store.

### 2. Accountant: a fourth role, fixed and read-only
- `accountant` has exactly `reports.view`, which isn't adjustable per merchant. That covers sales,
  tickets, cash, hours, the Z-reports, and the tax, compliance and journal exports.
- An accountant signs in to the merchant app by phone and **never has a register PIN**. The API
  refuses one, a DB check backs that up, the register snapshot leaves accountants out, and changing
  someone to accountant clears their PIN.
- The **daily journal** (`/merchant/reports/journal[.csv]`, up to a quarter) has one row per store
  and local day: net sales, tax, gross, refunds, cash, card, paid out, paid in, drops and over/short.
  Money is printed from integer cents. It's the file a bookkeeper imports into QuickBooks or Xero.
- **Deferred:** a direct QuickBooks Online / Xero sync. It needs their developer apps and OAuth
  (accounts), and the journal is what it would send.

### 3. Cashier performance, folded from events
`GET /merchant/reports/cashiers?from&to` gives, per person:
- sales (voided ones excluded) and gross, and average ticket;
- time on the clock (the P15 timesheet) and gross per hour;
- voids, refunds (excluding voids) and "no sale" drawer opens;
- drawer over/short on the counts they closed (P6);
- age checks: done, how many by ID scan, and **age-restricted lines sold on their completed sales
  without a check**.

It shows on the Hours tab for the week in view.

### 4. Three alert rules, each with a merchant threshold
- **Big-ticket sale** (info): a sale at or over `big_ticket_cents` (default $200). One alert per sale.
- **Unusually slow hour** (info): the last full store-local hour against the same hour on the last
  four same weekdays. It only judges when that baseline is real: sales in that hour on 3 of the 4
  days, averaging $50 or more. It fires under `slow_hour_pct` (default 40%).
- **First sale later than usual** (warning): no sale yet today and it is `late_open_minutes`
  (default 45) past the median first-sale time of the last 14 days (5+ days needed). A sale resolves
  it.

All three are in the merchant's alert settings and can be muted. Notifications go through the
existing `Notifier`, which is the log adapter; push and SMS are deferred.
