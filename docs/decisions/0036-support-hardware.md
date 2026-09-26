# 0036: Support tickets, runbooks, hardware inventory & RMA

- Status: Accepted
- Date: 2026-09-26
- Build plan: P24a. Bible 3.2 (support tickets with SLA timers and canned fixes; runbooks with fix
  buttons; hardware inventory & RMA) and 2.8 (equipment and hardware tickets from the merchant app)
- Extends: ADR 0012 (ops layer: remote actions, alerts), ADR 0021 (support chat)

## Decisions

### 1. A ticket is a row; its conversation is append-only
`support_tickets` holds the subject, the store (and optionally the register and sale), the category,
the priority, the status (`open` → `pending` → `solved`) and the SLA due time. `ticket_notes` is
append-only (`forbid_mutation`): every reply, status change, canned fix and internal note is a new
note, so the history of a ticket cannot be rewritten.

- **SLA** is first response: urgent 4 h, normal 24 h (`SLA_MINUTES`, shared). The first note from AD
  Pay stamps `first_response_at`; `slaMinutesLeft` is shared, and the admin list counts it down.
- A merchant reply to a `pending` ticket moves it back to `open`.
- **Internal notes** are never returned to the merchant scope.

### 2. Canned fixes press the remote-action button
`CANNED_FIXES` (shared) pairs the steps the store reads with the remote action that fixes it:
printer paper → printer test, Wi-Fi changed / not syncing → force sync, frozen → restart app, price
not updated → push config, need logs → upload logs. Picking one writes the steps to the ticket and
queues the action on the ticket's register through the ADR 0012 queue (the same `requestAction`, so
it is audited and delivered on the next heartbeat). A fix with an action is refused on a ticket
without a register.

### 3. Runbooks sit next to the alert
`RUNBOOKS` is typed as `Record<AlertRule, …>`, so a new alert rule does not compile without its
runbook. The admin Alerts page shows the text, the fix button (when the rule has an action and the
alert has a register), and "Open a ticket", which pre-fills the ticket from the alert.

### 4. Hardware units by serial, moves in an append-only history
`hardware_units` (unique serial; installed ⇔ has a store) is the current state; `hardware_events`
(append-only) is every move: added, installed, swapped out, swapped in, RMA closed. A **swap** is one
transaction: the faulty unit goes to `rma`, a unit from stock of the same kind goes in at the same
register. An RMA closes as repaired (back to stock) or retired. The merchant app shows the store's
installed equipment and its warranty.

## Built to the boundary / deferred
- Remote actions that need the Android device (reboot, re-pair the terminal, roll back a build) stay
  with P-HW; tickets link to the register either way.
- Shipping labels and carrier tracking for RMAs are not built (a carrier account).
