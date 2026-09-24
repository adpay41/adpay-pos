# 0014: Cash drawer: sessions folded from events, blind count, movements with reasons

- Status: Accepted
- Date: 2026-09-24
- Build plan: P6. Bible: L11 (drawer discipline), L12 (drops, paid-outs, paid-ins), L13 (blind count; over/short by cashier; trend), part of L38 (drawer opened outside a sale)
- Builds on: ADR 0002 (events), ADR 0004 (cents), ADR 0011 (permissions, actor on every event)

## Context

Cash is roughly half of these stores' sales and nearly all of their shrink. Owners reconcile
from a notebook, if at all, and vendors are paid in cash straight from the drawer. The spec's
acceptance line is *"Z-report cash count matches the sum of cash events for the day."*

## Decisions

### 1. A drawer session is events, and "expected" is a fold
Three new saleless events:
- `drawer.session_opened` (counted float);
- `drawer.cash_movement` (`drop` | `paid_out` | `paid_in`, positive integer cents, a reason, and a payee for paid-outs);
- `drawer.session_closed` (counted cash, `blind: true`).

`drawer.opened` gains `movement` and `count` reasons. `manual` means **no sale**. The drawer should hold:

`float + cash tenders − cash refunds + paid-ins − paid-outs − drops`

It is computed by **one shared `foldDrawer`**, used by the register, the reports and the alert
rules, so they cannot disagree. Nothing stores or edits a total. A session never closed (crash,
forgotten) ends where the next one opens, and cash taken with no session is reported as
unassigned rather than lost.

### 2. The count is blind, and nothing leaks the expected amount
The cashier enters the count before seeing what was expected; the result shows afterwards.
While the drawer is open, the register shows "should hold" only to people with `reports.view`.
A "more than the drawer holds" check on paid-outs was **rejected**, because it would let a
cashier probe the expected amount. A wrong amount surfaces as over/short at the count instead.

### 3. Discipline through permissions, not a new mechanism
- A cash sale needs a started drawer. The first Cash press asks for the float.
- **No sale** needs `drawer.no_sale`, drops need `cash.drop` (cashiers by default), and paid-outs
  and paid-ins need `cash.paid_out`. Anything missing becomes a manager's-PIN override (ADR 0011).
- Every movement and every open carries the actor.

### 4. Reports and alerts from the same fold
- `/merchant/cash` and `/admin/merchants/:id/cash`: sessions with names, over/short by cashier
  and by day (the trend), and totals.
- New alert rules: **drawer counted short by more than $5** (closed in the last 24 h) and **five
  or more no-sale opens on one register today**. Both are merchant-facing.

### 5. Short is amber, never red
Over/short, like every amount on the register and in the apps, is never red: short is amber,
even and over are black. The same pass fixed two red buttons that carried a dollar amount (the
cash keypad's "Take $…" and the number pad's money confirm). Both are now black.

## Consequences

- EOD / Z-report (P16) is `foldDrawer` plus sales by tender and category for the business day.
- N items: denominations and a count photo attach to `drawer.session_closed` as additive fields.
  "Cash in drawer now" (merchant app) reads the open session's expected amount. The drawer-over
  alert reads the same number.
- The lottery module (P17) adds payouts as `paid_out` movements with a lottery reason, so its
  cash already reconciles.
