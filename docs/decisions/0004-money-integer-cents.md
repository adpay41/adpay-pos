# 0004 — Money is integer cents, everywhere

- Status: Accepted (fixed by the v1 spec)
- Date: 2026-09-23
- Source: `docs/spec-v1-cstore.md` → Decisions → "Money"

## Context

This is a ledger. Average ticket is $13–18 across 1–5k transactions per store per month, and the
merchant's dual-pricing model means every item carries **two** prices (cash and card) that must both
be shown to the customer before tender. Binary floating point cannot represent $0.10; accumulating
rounding error across line discounts, category tax and percentage-based card pricing produces
Z-reports that do not reconcile, which destroys trust in the product faster than any bug.

## Decision

**Integer cents everywhere. No floats.** Not in the database, not on the wire, not in the domain
layer. **Totals are derived from events, never edited.**

## Consequences

- DB columns are `BIGINT` cents. JSON fields are integers named to make the unit obvious
  (`amount_cents`, `cash_price_cents`, `card_price_cents`, `tax_cents`).
- `packages/shared` owns the money type and every arithmetic helper. Application code never does
  raw arithmetic on an amount; it calls the helper.
- Rounding is explicit and happens **once**, at the point a derived price is computed (dual-price
  percentage, percentage discount, tax by category), with the rounding mode chosen and documented
  there — not implicitly at display time.
- Currency conversion is out of scope; v1 is USD only. The money type still carries the currency so
  that assumption is visible rather than ambient.
- Display formatting (`$13.49`) happens only at the edge, in the UI layer. A formatted string never
  travels back into the domain.
- Because totals are derived, a corrected sale is a new event (ADR 0002) — never an edit to a
  stored total.
- Tests: property tests that folding a day of events matches the Z-report to the cent, and that no
  path can produce a non-integer amount.

## Rejected

- **Floating-point dollars** — silent precision loss in a ledger.
- **Decimal/BigNumber libraries** — heavier, and they invite implicit rounding at every operation.
  Integers make the rounding decisions visible because you have to write them down.
