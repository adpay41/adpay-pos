# 0032: Bulk price change, price history, profit

- Status: Accepted
- Date: 2026-09-26
- Build plan: P20b. Bible 2.2 (profit, not just sales: margin by item and category), 2.3 (bulk price
  change; price history and who changed what)
- Extends: ADR 0023 (one bulk catalog write, price history)

## Decisions

### 1. Bulk price change: preview, then one write
`POST …/catalog/bulk-price` takes categories and/or items, and a change:
- ±% (parts per million, −50%…+200%);
- ±$;
- set to $.

It can round the new cash price up to one ending in 9 cents or in .99. Every step uses integer
cents, and half-up rounding for percentages.

A **dry run** returns the plan: what changes, from and to, and how many would fall **below cost**.
Applying runs in one transaction with one catalog-version bump, a price-history row per item (as a
single edit writes) and one audit entry.

An explicit card price moves with the same change; "set to" returns the item to the derived card
price. Open-price and inactive items are never touched.

"Match this vendor invoice" (updating costs from a photographed invoice) is the Bible's M-tier
vendor-invoice AI and is not built.

### 2. Price history in the item editor
The append-only `item_price_history` has recorded every price and cost change since P2. The merchant
app now shows it under each item: date, cash price (and a fixed card price), cost, and who made the
change.

### 3. Profit folds sales at the cost in force when sold
`GET /merchant/reports/profit` (up to a quarter, `reports.view`) folds the period's completed
sales:

- **Revenue** is what customers paid for the goods: price × units − discounts, in each sale's price
  mode, less refunded units at the price paid. Deposits, excise and fees are pass-through and are
  excluded.
- **Cost** is each unit's cost **in force when it was sold**: the latest history row at or before the
  sale, falling back to today's cost for items older than their history.
- **Margin** is measured only on units with a cost. Units without one are counted and shown
  ("12 of 340 units have no cost"), never guessed.
- Units sold **below cost** are flagged, with their names.

The merchant app's Sales tab shows total profit and margin, and each category's share of sales
against its share of profit ("tobacco is 31% of sales and 6% of profit").
