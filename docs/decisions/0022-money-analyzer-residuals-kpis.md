# 0022: Statement analyzer, residual/margin report, KPIs: manual inputs until data exists

- Status: Accepted
- Date: 2026-09-24
- Build plan: P13. Bible: L41 (partial), L50 (partial), L53
- Extends: ADR 0004 (integer cents), ADR 0020 (pricing plans)

## Context

These are AD Pay's own numbers. Two inputs don't exist yet:

- parsers for prospects' processor statements, which need **sample PDFs** from Sola, NRS and
  Clover;
- our processor cost, which needs the **signed Finix rate card and settlement data**.

The build plan says to build the shell with manual inputs and swap in the automation when the
data arrives.

## Decisions

### 1. All money math in `packages/shared/src/analyzer.ts`, integer only
Money is in cents and rates in ppm. `ppmOf` and `ratePpm` round half-up once per division. Both
the admin page and the API call the same functions, so the one-pager, the screen and the tests
agree to the cent.

### 2. Statement analyzer = manual entry + the offer, saved together
Each entry records:

- the prospect;
- the processor;
- the month;
- card volume and transaction count;
- total card fees;
- interchange, when the statement shows it;
- POS fees;
- the number of registers;
- **the 1–3 plans offered**.

Keeping the offer with the entry means a saved analysis always reprints exactly what the owner
was shown. The results are effective rate, markup over interchange, average ticket, and cost and
saving per plan:

- **dual pricing**: processing cost is zero to the merchant, so only the subscription counts;
- **interchange-plus**: needs interchange, and says so when it's missing;
- **flat**: rate × volume plus per-transaction fees.

The one-pager is a print-styled page (Print → Save as PDF). No server-side PDF library and no new
dependency.

### 3. Residuals from the ledger and the plan in force at month end
- **Card volume** is approved card tenders minus card refunds, from `sale_events` by business
  date.
- **Revenue** depends on the plan:
  - dual pricing: the surcharge inside card volume, V × r / (1 + r);
  - IC+: markup plus per-transaction fees (interchange is passed through, so it counts as
    neither revenue nor cost);
  - flat: rate × V plus per-transaction fees;
  - plus the subscription on every plan.
- **Cost** is interchange (unless IC+) plus processor fees, typed per merchant-month into
  `processor_costs`. Re-entering it corrects it, and every entry is audited with before and after.
- **Margin** is shown only where a cost has been entered.

### 4. KPIs are computed on read
The dashboard shows:

- live stores (onboarding status), and those with a sale in the last 7 days;
- **quiet stores**: live with no sale in 14 days, which is the churn warning list;
- paired registers, and installs per week over 8 weeks;
- this month's volume and card volume;
- revenue, margin (over stores with cost entered), and effective rate;
- support load: messages in 7 days and unread.

Nothing is pre-aggregated, in keeping with "totals are derived, never edited".

## Consequences / later
- When Finix data arrives, `processor_costs` is filled by an importer instead of by hand; the
  report doesn't change.
- When sample statements arrive, a parser fills `StatementInput` from a PDF; the analyzer doesn't
  change.
