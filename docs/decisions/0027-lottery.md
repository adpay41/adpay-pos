# 0027: Lottery module

- Status: Accepted
- Date: 2026-09-26
- Build plan: P17. Bible 1.4 (lottery module: pack activation, per-game tracking, inventory,
  reconciliation vs the state terminal, payouts vs drawer; compliance export)
- Extends: ADR 0018 (restriction kinds), ADR 0014 (drawer paid-outs), ADR 0026 (compliance log)

## Decisions

### 1. Instant tickets are tracked by pack and bin, online sales by terminal totals
Four tables, all carrying org / merchant / location ids:

- `lottery_games`: game number, name, ticket price in cents, tickets per pack.
- `lottery_packs`: one physical pack. Status goes `received → active → sold_out`, or
  `received|active → returned`. Other transitions are refused with a plain-language 400. At most one active pack per
  bin per location (partial unique index).
- `lottery_counts`: the ticket number showing in a bin at a count. **Append-only**
  (`forbid_mutation`); a miscount is corrected by a later count, never by an edit.
- `lottery_terminal_reports`: the day's totals typed from the state terminal report (online sales,
  instant cashes, online cashes), one row per location and business date, replaced by a later PUT.

There is no state lottery API. The terminal report is manual entry, which is how stores reconcile
today.

### 2. Tickets sold come from counts, never from a running total
`ticketsSold(before, now, size)` is the difference between two counts. A pack activated today counts
from ticket 0, and a pack that went sold out counts to its size. Instant sales for a day are the sum
across packs of tickets × price. Nothing stores a derived total.

### 3. Reconciliation is a read-time fold
`reconcileDay` (packages/shared) compares:

- **sales difference** = rung on the registers − (instant from counts + terminal online sales);
- **payout difference** = drawer paid-outs whose reason mentions lottery − (terminal instant + online
  cashes).

Rung lottery is folded from `sale_events` for the location and business date: lines whose captured
`restriction` is `lottery`. A line rung before its category was marked also counts when it has no
captured restriction and its category is lottery-restricted now. Refunds of lottery lines are not netted yet: stores refund lottery rarely, and the difference shows up as a variance. Differences are
shown, never corrected.

### 4. Export
`GET …/lottery/export.csv?from&to` (at most 93 days) returns one row per day with the same figures:
the lottery section of the compliance export. The age-check log (ADR 0026) is the other section.

### 5. Access
Merchant app, **Lottery** tab, behind `reports.view`. It has five sections: Reconciliation, Count,
Terminal, Packs and Games. Everything is audited through `audit()`.

## Not done / blocked
- No state lottery system integration (NJ/NY), and no results or jackpot feed (P-3P, ⛔).
- Pack barcode scanning on receive: packs are typed for now. The pack barcode layout differs by
  state and needs real packs to verify.
