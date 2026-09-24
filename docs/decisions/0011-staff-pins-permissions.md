# 0011: Staff: memberships, on-device PIN checks, a permission matrix with manager override

- Status: Accepted
- Date: 2026-09-24
- Build plan: P3 (foundation F2). Bible: L27 (cashier PIN, roles, permissions per action), L36 (staff
  from the phone), L32 (multi-store switcher), and the cashier id half of L11/L16
- Builds on: ADR 0002 (offline-first events)

## Context

Every drawer open, void and age check must say who did it, and a cashier must be able to ask a
manager for a void without the store stopping. The register must also sign people in during a
72-hour outage, and owners often run two to five stores. Before this phase a user belonged to
exactly one merchant, events had no cashier, and nothing checked permissions.

## Decisions

### 1. Memberships: a person has a role at each store

`users` is now just the person (name, phone). `memberships (user_id, merchant_id, role, pin_hash)`
gives the role, **per store**. Migration 0004 moves every existing merchant user into a membership
and drops `users.org_id/merchant_id`.
- A merchant token names only `user_id + merchant_id`. **Role and permissions are resolved from
  the membership on every request**, so demoting or removing someone takes effect immediately, not
  when a 12-hour token expires.
- `GET /auth/merchant/memberships` + `POST /auth/merchant/switch` give the app its store switcher.
  Switching to a store you don't work at is a 404, like any cross-tenant id.
- Adding someone by a phone number that already has a login gives that person a second membership,
  not a second account.

### 2. PINs are checked on the register, against a hash in its config snapshot

- **Tap your name, then PIN.** PINs are not unique. A uniqueness check would tell an owner whose PIN
  they had just picked.
- 4–6 digits, refusing repeats and straight runs. Stored as **PBKDF2-SHA256, 10,000 iterations,
  16-byte salt** (`@noble/hashes`, pure JS, the same code on Hermes, the browser and Node). The count
  is in each hash, so it can be raised later. About 16 ms in Node; tolerable on a T2s.
- The hash rides in `/device/catalog` (`staff`), and **only there**. The apps get `has_pin`, and the
  audit log gets "PIN set by X". A PIN is typed once in the merchant app or admin, hashed by the
  API, and never returned.
- A 4-digit PIN is **identification, not a strong secret**: anyone holding a register's snapshot
  could brute-force 10⁴–10⁶ PINs offline. That is accepted and bounded. The snapshot lives on a
  kiosk-locked device of that merchant and is served only to its device token. Five misses lock
  that person out **on that register** for 5 minutes (the state survives a restart), and every miss
  is a `staff.pin_failed` event the ops layer (P4) can alert on.
- A merchant with **no PINs set up yet** runs without sign-in, with an amber "No staff PINs set up"
  pill, rather than locking the counter. Its sales are unattributed until PINs are set.

### 3. Permission matrix with owner-only guard rails

- Twelve named actions (`packages/shared/src/staff.ts`: void, refund, discount, price override,
  no-sale drawer, paid-out, cash drop, view cost, edit catalog, see reports, manage staff).
  **Owners hold all. Managers and cashiers have defaults**, and a merchant stores only its
  differences (`merchants.permission_overrides`), so improving a default later reaches everyone
  who didn't change it.
- The API enforces the app-side permissions (`catalog.edit`, `reports.view`, `staff.manage`).
  Only owners create, promote, demote or remove owners, and a store can never lose its last
  active owner.

### 4. Manager override at the register

When the signed-in person lacks a permission, the register asks someone who holds it to approve
with **their own PIN**. An `override.granted` event records the action, the approver and the
cashier. The action itself is still recorded as the cashier's.

### 5. Who did it, on every event

Every event envelope carries **`actor_user_id`** (additive, nullable; older events parse
unchanged), stored as a column on `sale_events` for per-cashier reports and the compliance export.
`sale.opened.cashier_user_id`, `age_verified.verified_by_user_id` and the `by_user_id` on voids and
drawer opens are now filled. New saleless events: `staff.signed_in`, `staff.signed_out`,
`staff.pin_failed`, `override.granted`.

## Consequences

- **M: manager override by phone** plugs into the same `override.granted` event, with an approver
  who is not at the counter. The F3 command channel (P4) carries the request.
- Time clock (N) can build on `staff.signed_in/out`. Clock-in stays a separate event, because
  signing in to sell and being on the clock are different things.
- Server-side, the ingest trusts the device's `actor_user_id` (device wins on sales). A later check
  can flag an actor who isn't staff there, but it never rejects a sale.
- On Android, the device token and this snapshot move into the keystore with the kiosk work (step 4).
