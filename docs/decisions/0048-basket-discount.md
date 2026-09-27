# 0048: Basket (whole-ticket) discount

- Status: Accepted
- Date: 2026-09-27
- Source: NRS gap analysis, item 4 ("basket discount")
- Extends: ADR 0031 (promotions as line discounts), ADR 0015 (refunds at the price paid)

## Decisions

### 1. One event; the fold spreads it
- `sale.basket_discounted` carries either `percent_ppm` or `amount_cents` (cash-price cents), and a
  reason. The latest one wins. One that takes nothing off removes the discount.
- The fold spreads it over the goods lines (never a fee line, never a deposit) by each line's net
  after its own discount, largest remainder first, so the shares add up exactly.
- The spread is recomputed whenever the ticket changes. A line added after the discount gets its
  share.
- **Why not write it as line discounts:** promotions reprice lines on every change and would
  overwrite them (ADR 0031). A ticket-level event keeps the owner's intent ("10% off this ticket")
  on record.

### 2. Card price
- A percent applies to the card goods too.
- An amount off is cash cents. At the card price it is scaled by card goods ÷ cash goods, so paying
  by card never gets a bigger discount than paying cash, and dual pricing stays consistent.

### 3. Everything reads it through one helper
`lineDiscount(line, mode)` is the line's own discount plus its basket share. Tax, totals, refunds
(partial and full), the sales-tax report's refund tax, profit and the receipt all use it.
- A tax-inclusive line (ADR 0044) stays tax-inside: $10.00 less 10% rings $9.00, with the tax backed
  out of $9.00.
- The receipt shows one "Discount 10%" line before the subtotal it comes off.
- On the register ticket, lines show their own price (`lineAmount`) and the discount shows once, as
  its own row.
- The customer screen has no discount row, so each line shows its amount after its share and the
  lines plus tax still add up to the total.

### 4. Permission and screen
- New permission `ticket.discount`. Owners and managers have it; a cashier gets a manager's override.
- The register's shortcut bar has **Discount**. The panel offers:
  - 5 / 10 / 15 / 20%, or "$x off" from what's typed on the pad;
  - a reason (regular customer, damaged item, price match, manager's call), which is required;
  - remove.
- The ticket shows a "Ticket discount" row.

## Tests
Through the session, with hand-worked figures:
- 10% on a taxed soda and an untaxed sub, with the exact per-line split in both modes;
- $5 off scaled to card;
- removal;
- re-spread when a line is added;
- the receipt lines, the Z, and a refund giving back the unit's price paid;
- a tax-inclusive line under 10%;
- permission defaults.
