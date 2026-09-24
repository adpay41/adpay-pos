# 0018: Tax & compliance tables, basic: dated rates, per-unit charges, age rules by state

- Status: Accepted
- Date: 2026-09-24
- Build plan: P10 (foundation F7). Bible: L16, L17
- Extends: ADR 0002 (events), ADR 0004 (integer cents), ADR 0016 (per-location settings in the snapshot)

## Context

Before P10, a location had one sales-tax rate, a category was taxable or not, and a category could
carry a minimum age. The Bible (1.4) asks for state tax tables per location with **effective
dates**: cigarette and vape excise, the NY 5¢ bottle deposit, bag fees, a sugar tax. It also asks
for age verification by category, following each state's rules.

## Decisions

### 1. One rule set per location, as validated JSON
`locations.compliance` (jsonb, `ComplianceSettingsInput` in `packages/shared/src/compliance.ts`)
holds three things:

- a **sales-tax schedule**: `{tax_class, rate_ppm, effective_from}`;
- **per-unit charges**: `{rule_id, kind: excise|deposit|fee|bag, label, amount_cents | rate_ppm,
  category_ids, item_ids, taxable, effective_from, effective_to}`;
- **age overrides** by restriction kind.

This is the pattern ADR 0016 used for receipt settings: the whole set is replaced on save, audited
with before and after, and bumps the catalog version. No new tables, because nothing else queries
these rules; the register reads them from its snapshot.

Categories gain `tax_class` (default `standard`) and `restriction` (`tobacco | vape | alcohol |
lottery`).

### 2. Resolved on the register at ring time, by the store-local date
The snapshot carries the schedule and the charges, not just today's answer. `lineCompliance` runs
when a line is rung and uses the **store's calendar date** (`localDate`, in the location's
timezone). A rate change entered in advance therefore takes effect at midnight store time, even on
a register that is offline that day (72 h offline rule).

Rate lookup order:

1. the latest entry that has started for the item's class;
2. otherwise the latest `standard` entry;
3. otherwise the location's plain `tax_rate_ppm`.

The snapshot's per-item `tax_rate_ppm` is today's answer, kept for older app builds.

### 3. Captured into the sale event; nothing is re-priced later
`sale.line_added` gains three additive fields:

- `tax_class`;
- `restriction`;
- `charges[]`, each `{rule_id, kind, label, unit_cash_cents, unit_card_cents, taxable}`.

`price_source` gains `fee`. Older events default to no charges, so every historical fold is
unchanged.

### 4. How charges price
- A **fixed amount** (deposit, per-pack excise) is the same at the cash and the card price: a
  deposit is not a card surcharge.
- A **percentage** (NY's 20% vapor tax) applies to each price, rounded half-up once per unit.
- Charges are part of the line's total (`lineNet`). Only charges marked `taxable` join the item's
  sales-tax base, and only when the item itself is taxed (`lineTaxBase`).
- The receipt prints each charge under its item. Tax per rate is still computed once per rate
  group, so the itemized lines add up to the total.
- Refunds give the charge back with the unit it was charged on (a returned bottle returns its
  deposit).
- Split tender needs no change: it works on the folded totals, which include charges.

### 5. Bag fees are their own key
A `bag` rule is not attached to items. The register shows a **"+ Paper bag fee 5¢"** key for each
bag rule in force. The key rings a line whose item id is the rule id, at the same price for cash
and card, merging on repeat taps. It prints, refunds and voids like any line.

### 6. Age rules by state
`minAgesFor(state, overrides)` starts from federal Tobacco 21 (tobacco, vapor), alcohol 21 and
lottery 18. It then applies a per-state table (NJ, NY), then the location's overrides. An item's
check is the stricter of its category's own `min_age` and its restriction's rule
(`effectiveMinAge`). The check itself is unchanged from P3: the cashier confirms, and
`sale.age_verified` records who, when, and which line. Scanning an ID is N-tier (P16).

### 7. Templates are drafts, never applied by themselves
`STATE_TEMPLATES` (NJ, NY outside NYC, NYC) fill the admin form as a starting point, and each one
says what it leaves out. **Cigarette excise is deliberately absent.** In NJ and NY it is paid
through tax stamps and is already in the shelf price, so charging it at the register would double
it. Every value needs an accountant's sign-off before a store relies on it (build plan section 4).

## Consequences

- A rate change never touches past sales: they carry the rate and charges they were rung with.
- The rule set is small (at most 60 rates and 100 charges), and it travels in every snapshot.
- Not built here (N-tier, P16): the full jurisdiction tables and an admin editor for them, the
  sales-tax report and export, and the compliance log export.
