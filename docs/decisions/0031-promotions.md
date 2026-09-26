# 0031: Promotions: builder, register pricing, receipts, deals of the day

- Status: Accepted
- Date: 2026-09-26
- Build plan: P20a. Bible 2.3 (promotions builder: 2 for $5, mix and match, buy X get Y, happy
  hour, start/end, per store), 1.5 (deals of the day on the customer screen)
- Extends: ADR 0009 (sales as events), ADR 0004 (money), ADR 0029 (loyalty discounts)

## Decisions

### 1. A promotion is configuration; what it gave is in the sale
Promotions are merchant configuration (`promotions`), delivered in the register snapshot and
bumping the catalog version when edited.

At the register the session **reprices after every line change**: it applies the running
promotions and writes only what changed as ordinary `sale.line_discounted` events. Those events
carry `promo_id` (an additive field) and the reason `Promo: <name>`. When a promotion stops
applying (one of a pair is removed), its discount is reset with another event.

The sale stays a fold of its events, so receipts, refunds, reports and a reprint weeks later all see
exactly what was given, even after the deal has been edited or ended. The builder's "last 30 days"
usage comes from those events.

Discounts from anything else, such as a manual discount or a loyalty reward, win: a line carrying
one is left out of promotions, and the loyalty reward skips promotional lines.

### 2. Three rule kinds cover the Bible's list
- `multi_price`: N qualifying units for a group price. This is mix and match across items and
  categories.
- `buy_get`: in each block of buy+get, the cheapest `get` units at a percentage off (100 = free).
- `percent_off`: every qualifying unit; with a time window, this is the happy hour.

Units are grouped most expensive first, in the customer's favor. Each unit counts in at most one
promotion. A deal that would make the ticket dearer is skipped.

Scheduling uses start and end dates, weekdays and a store-local time window (which may cross
midnight), per store or for all stores.

### 3. Dual pricing holds
The promotional price is set in cash cents. The card side derives from it with the location's
dual-price rate, like any card price: 2 for $5.00 is $5.20 by card at 4%. A group discount is split
across its lines with the largest remainder, so the line discounts add up exactly.

### 4. What people see
- **Register**: under each line, the deal's name and what it took off.
- **Customer screen**: a ★ with the deal's name on the line and, while idle, the running deals the
  store chose to show ("deals of the day").
- **Receipt**: the deal's name as the discount line, and "You saved $X" under the total, in the
  customer's language.
- **Merchant app → Deals**: the builder, with a live preview of the customer-facing text; end or
  resume a deal; usage over the last 30 days.

## Not in P20a
Bulk price changes, the price-history view and profit/margin reports are P20b.
