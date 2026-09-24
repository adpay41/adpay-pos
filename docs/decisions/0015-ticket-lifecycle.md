# 0015: Ticket lifecycle: hold/recall, refunds at the price paid, voids as refund + void

- Status: Accepted
- Date: 2026-09-24
- Build plan: P7. Bible: L7 (hold/recall), L15 (dual pricing on refund and void paths, cash side), L21 (reprint any ticket), rest of L38 (void/refund over $X)
- Builds on: ADR 0002 (events), ADR 0011 (permissions), ADR 0014 (cash drawer)

## Decisions

### 1. Hold and recall are events plus a local list
- **Hold** emits `sale.suspended` on the open ticket, adds it to a parked list in the local store,
  and frees the register for the next customer.
- **Recall** emits `sale.resumed`. If another ticket is open at that moment, **it is held first,
  never discarded**.
- Several tickets can be parked; they survive a restart and show with their contents and totals.
- The server sees `suspended`/`resumed` in the ledger, so a forgotten held ticket is visible in
  replay.

### 2. A refund gives back what was paid, by line
`sale.refunded` gains `lines: [{line_id, qty}]` (additive, default `[]`). The fold tracks refunded
units per line, so nothing is refunded twice. The amount comes from the shared `refundQuote`:
- It uses the **price mode the sale was paid in** (cash price for a cash sale, card price for a
  card sale), with that line's tax. This is the Bible's "dual pricing correct on refund".
- A line discount is spread over its units and its share rounded **up**, so a partial return
  never pays back more than those units cost.
- **Returning everything left pays exactly the remainder** (paid − already refunded), so
  per-line rounding can't strand or double-pay a cent.

### 3. Voiding a completed sale is "refund the rest, then void"
One path, and the drawer and reports stay right without special cases: the cash goes back as a
`sale.refunded` (reason `Void: …`), then `sale.voided`. Reports drop a voided sale from the gross
and show the returned money under refunds. The drawer fold sees the cash leave.

### 4. Card refunds wait for the card path
A refund or void of a card sale goes back to the card through the terminal. Until P9 (stub) and
P-HW (PAX), the register says so and refuses, rather than handing out cash for a card sale.

### 5. Permissions and alerts
- Refunds need `sale.refund` and voids need `sale.void`; otherwise a manager approves with a PIN.
- The override, the refund and the drawer opening are separate events, all carrying the actor.
- A refund or void of **$25 or more** raises a merchant-facing alert naming who did it. A
  per-merchant threshold is N.

### 6. Reprint any ticket
The register's **Tickets** list covers the last 40 tickets rung there: time, status, total,
and any refunds. Any of them can be reprinted, and a refund prints the ticket with the refund
shown and a refund footer. The receipt layout itself is P8.
