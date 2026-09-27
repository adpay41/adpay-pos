# 0042: Shift = sign-in, tax by category only, PIN length, reusable demo codes

- Status: Accepted
- Date: 2026-09-27
- Source: feedback from a store owner testing the demo (items 1–4 of 7)
- Amends: ADR 0011 (PINs), ADR 0018 / 0026 (tax), ADR 0020 (setup codes), ADR 0024 (time clock)

## Decisions

### 1. Clock in is signing in; clock out is ending the shift and signing out
- **Signing in with a PIN** also starts that person's shift, if they aren't already on the clock. The
  `staff.signed_in` and `staff.clocked_in` events are both recorded, in that order.
- **Clock out** (the top-bar button, with the time on the clock) ends the shift and signs the person
  out in one tap.
- **Lock** is still there, for handing the register to someone else without ending anyone's shift.
  Idle sign-out and switching cashier don't clock anyone out either.

### 2. Tax is set on the category, not on a per-store admin page
- The register already rings every line at its category's rate: `categories.taxable` plus a tax class,
  with the location supplying the state's rate schedule.
- The **owner now switches a category Taxed / No tax** in the merchant app (Items → Categories). The
  change reaches the register on its next snapshot.
- The per-store **admin Tax page and `/admin/tax-tables` are gone**.
- The state-level rules stay per location, set from the state template at onboarding: rate schedule by
  class, deposits and fees, age rules.

### 3. The PIN pad stops at the person's PIN length
- `memberships.pin_length` is recorded when a PIN is set and sent to the register with each person.
- The keypad accepts exactly that many digits and signs in on the last one, with no Enter.
- A PIN set before this has no length recorded and keeps the old 4–6 digits plus Enter. The demo seed
  fills in the length for its own PINs.

### 4. Demo setup codes are reusable
- The five codes `npm run dev` / `npm run logins` arm (`reusable`, outside production only) pair as many
  times as needed.
- Each pairing moves the register to the new browser and signs the previous one out, keeping one device
  per register (ADR 0009 event sequence).
- Install-kit codes issued in admin stay single-use.
- The failure the tester hit: JSQ3-DEMO had already been used successfully once, which burned it.
