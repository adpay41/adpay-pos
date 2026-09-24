# 0025: End of day (Z-report) and training mode

- Status: Accepted
- Date: 2026-09-24
- Build plan: P16a. Spec v1: "End of day: cash count, Z-report (by tender, by category,
  voids/refunds), print + push to server"; acceptance: "Z-report cash count matches the sum of cash
  events for the day". Bible 1.8 (training mode), 2.6 (EOD not closed)
- Extends: ADR 0002 (events), ADR 0014 (drawer), ADR 0024

## Decisions

### 1. A Z covers everything on the register since the previous Z
That is what a Z is: it closes a period. It is not a calendar day, so a store open past midnight or
closed for two days still gets one Z per close, and nothing falls between two Zs.

The register keeps the next Z number and the first `device_seq` it covers in meta. `eod.closed`
records:

- the Z number and the store-local business date;
- the inclusive `[from_seq, to_seq]` range;
- the totals the register printed: sales count, gross, tax, voids, cash, card, refunds.

### 2. One function builds the Z, on the register and on the server
`buildZReport(events, meta)` in shared produces the report from events alone:

- sales and gross from approved tenders on completed sales;
- by tender, and by category (fees on their own line);
- tax by rate (split sales blended as on their receipts);
- refunds (cash and card), voids, no-sale opens, counterfeits;
- the drawer section, which is `foldDrawer` of the same events. That is how the spec acceptance
  holds: the count matches the cash events.

The server rebuilds each Z from exactly the events in its range and compares with the printed
totals. A difference is **flagged, never corrected**; both stay on record. `renderZReport` prints
48 columns like the receipt.

### 3. The drawer is counted first
The Z refuses while a drawer session is open ("the count is part of the Z") or while a ticket has
lines. The End-of-day screen offers "Count the drawer", then "Take Z & print".

### 4. "End of day not closed" alert
After 1 a.m. store time, a register whose last sale day has no Z after it raises `eod_missing`,
deduplicated per register and day. It resolves by itself once a Z is taken. The rule applies only
to merchants who have taken at least one Z, so stores that haven't adopted end of day yet aren't
flooded on launch.

### 5. Training mode is a separate, in-memory session
The runtime keeps a second `SaleSession` with its own `MemoryEventStore`, which is never synced
and never persisted. The sale screen switches between the real and the training session:

- it is cash only (the Card button is hidden, so no terminal is ever driven);
- the drawer never kicks and no drawer event is written;
- receipts print "*** TRAINING — NOT A SALE ***";
- a black banner says so, and "Save as usual" is off;
- leaving training throws the practice ticket away.

Nothing it rings can reach the ledger: it has no path to the real store or the sync engine.

## Not here (P16b)
- ID scan (AAMVA).
- The sales-tax report and quarterly pack.
- The compliance log export.
- The tax-tables overview.
