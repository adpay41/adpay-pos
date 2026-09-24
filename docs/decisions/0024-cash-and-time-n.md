# 0024: Cash & time N: drop needed, counterfeits, denomination counts, handover, time clock, hourly ribbon

- Status: Accepted
- Date: 2026-09-24
- Build plan: P15. Bible 1.2 (drawer-over alert, counterfeit flag, denominations + photo), 1.8
  (time clock, shift handover), 1.10 (hourly target ribbon), 2.1 (cash in drawer now), 2.5 (hours
  and payroll export)
- Extends: ADR 0014 (cash drawer), ADR 0011 (staff), ADR 0019 (alert settings)

## Decisions

### 1. Everything new is an event, folded like the drawer
The event schema changes are all additive; older events still fold unchanged.

- `drawer.session_closed` gains `denominations` (face value in cents → count; must add up to
  `counted_cents`, checked on the register), `photo_media_id` and `handover`.
- New saleless events: `drawer.counterfeit` (which note, an optional note, the session),
  `staff.clocked_in` and `staff.clocked_out`.

### 2. "Drop needed" has one threshold per merchant
`drop_over_cents` joins the alert settings (default $600) and rides in the register snapshot as
`cash_settings`.

- **Register**: when the open drawer's expected cash is over it, a banner on the **cashier's**
  screen (never the customer's) suggests a drop. The suggestion is the excess over the float, in
  whole $20s.
- **Merchant app**: *In the drawers now* lists every open session (looking back 7 days, so
  overnight shifts count), with its expected cash and "drop needed".
- **Alerts**: the `drawer_over` rule opens a merchant alert and resolves by itself after the drop.

### 3. Counterfeits are refused, not taken
Refusing a bill is reachable from the cash tender ("Reject a bill") and from the drawer panel. The
drawer does not open and the total doesn't change. The event records which note, who and when,
and the merchant's cash report counts refusals and lists them per session.

### 4. Count by denomination, with a photo, as an option
The blind close can take a total, as before, or bill-by-bill and coin-by-coin. The running total is
the cashier's own count; the expected amount stays hidden. A photo of the count sheet is taken with
the camera (a file picker in the web build), shrunk on the device, and uploaded through a new
`POST /device/media`. It is online only; the close works without it.

### 5. Handover = close + start with the counted float
"Hand over to the next cashier" closes the drawer with the blind count, starts the next session
with that count as its float (no recount), clocks the outgoing cashier out (`reason: handover`),
and signs them out so the next person signs in.

### 6. Time clock separate from sign-in
Signing in to approve a void is not starting a shift, so clock in/out is its own button by the
cashier's name. It shows "On the clock 3:12". Punches are events; who is on the clock on this
register is kept in meta so it survives a restart.

The server folds shifts with `foldShifts`:

- a double punch-in keeps the first;
- a punch-out with no open shift is ignored;
- an open shift runs to now.

Timesheets count a shift on the store-local day it started. **Overtime is weekly, over 40 hours
Monday–Sunday** (federal FLSA; NJ/NY retail follow the weekly rule; confirm per store). The merchant
app's **Hours** tab exports the payroll CSV: a column per day, total and overtime as h:mm.

### 7. The hourly ribbon comes from the server
The ribbon reads "Today $412 · yesterday by now $380 up 8.4%". `GET /device/pulse` reuses the
sales comparison from ADR 0019 for this location. The register refreshes it every 5 minutes and
after each sale; offline, the ribbon is hidden and nothing else changes.
