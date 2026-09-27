# 0044: Tax-inclusive prices

- Status: Accepted
- Date: 2026-09-27
- Source: the founder picked Option B from ADR 0043's Open list. 582 of the pilot store's NRS items
  (mostly tobacco, frozen, dairy) are marked with the tax already inside the shelf price.
- Amends: ADR 0004 (money), ADR 0009 (cart = fold of events), ADR 0016 (receipt), ADR 0017 (split
  tender), ADR 0018 (tax by rate)

## Decisions

### 1. The flag lives on the item and is captured on the line
- `items.tax_included` is set by the owner in the merchant app (item → "Price includes tax") or
  by the NRS import from `includes_taxes`. The migration also sets it on items already imported
  from NRS.
- `sale.line_added` records `tax_included` next to the unit prices and `tax_rate_ppm`. Those three
  values rebuild the split of any line from the event alone, forever, whatever the item says later.
- Older events default to `false`.

### 2. Tax is backed out once per rate group
Within a rate group:

| Tax | How it's computed |
| --- | --- |
| Added on top | Base summed, rounded half-up once (as before) |
| Inside tax-inclusive prices | Marked prices summed; base = gross ÷ (1 + rate) half-up once; tax = gross − base |

- The customer pays exactly the marked prices.
- Three $10.00 packs at 6.625% hold $1.86 of tax, not 3 × $0.62.
- Per-unit charges (a deposit) on a tax-inclusive item are still added on top, as before.

### 3. The stored totals keep one meaning: total = subtotal + tax
- `subtotal_cents` is **before all tax**: a tax-inclusive price with its tax taken out.
- `tax_cents` is **all the tax**.
- `included_tax_cents` (new, additive) is the part of the tax that was inside marked prices.

So the Z-report, sales-tax report, journal, loyalty, partner webhooks and the server's mismatch check
read the totals exactly as before and stay right. `sale.completed` carries `included_tax_cents`.
Split tender blends it by coverage, as it blends tax.

### 4. What people see
- **Receipt, register ticket, customer screen:** lines at their marked price (`lineAmount`).
  - The receipt marks tax-inclusive lines `*`.
  - **Subtotal** is the sum of marked prices. Only tax **added on top** is listed before TOTAL,
    so Subtotal + those lines = TOTAL.
  - After TOTAL: "* Incl. tax r% on base" per rate, "Total tax", and "* Price includes tax".
  - The customer never sees tax added to a price that already had it; the ticket's whole tax is
    still printed.
- **Admin sale page (back office):** "Subtotal before tax", Tax, and "of which inside tax-inclusive
  prices".
- **Reports:**
  - category sales (`lineTotal`) and profit revenue are before tax;
  - the tax report's taxable amount per rate is the backed-out base.

### 5. Refunds and voids are unchanged in rule
- A refund gives back what was paid for the units: a tax-inclusive unit refunds its marked price.
  The tax report takes its backed-out tax back out.
- Split sales are still voided whole (ADR 0017).

## Tests
Rung through the register session:
- a tax-inclusive item alone;
- a mixed ticket: totals, receipt, Z, tax report and profit;
- replay from events;
- refunding a tax-inclusive line, then the remainder;
- a tax-inclusive item in a split tender, and a mixed ticket in a split tender.

Also: the rounding unit test, the owner set/clear through the API and snapshot, and the NRS import
setting 582 items on the real file.
