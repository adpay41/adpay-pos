# 0038: Opening and closing checklists with photos

- Status: Accepted
- Date: 2026-09-26
- Build plan: P24c. Bible 2.8 (open/close checklists with photos)
- Extends: ADR 0009 (register event log), ADR 0021 (config in the snapshot), ADR 0024 (count-sheet
  photo)

## Decisions

### 1. The lists are config; the ticking is an event
- **The lists** are `merchants.checklists`: an opening and a closing list of up to 20 items each. An
  item has a label and "asks for a photo". Null means the starter lists in `@adpay/shared`, a c-store
  / deli starting point. A change bumps the catalog version, so the lists reach the register in the
  snapshot and work offline. Editing needs `staff.manage`.
- **Ticking it off** at the register is one `checklist.completed` event. It carries the kind, every
  item as it stood (label, done or not, photo required, photo id) and an optional note. Stored in the
  append-only register log like every event, it is never stored a second time. Unticked items are
  recorded as not done, not dropped, so the owner sees what was skipped.

### 2. Photos go the count-sheet way
A photo item uses the same camera / upload path as the drawer count-sheet photo (P15): shrunk on
the device, uploaded to `/device/media`, with the media id in the event. Photos need the register
online. Offline, the item can still be ticked; the photo shows as "missing" to the owner rather than
blocking the store from opening.

### 3. The owner's view is read from the events
`/merchant/checklists/report` covers each store and store-local day in the range:
- whether it was opened and closed, when, and by whom (the event's `actor_user_id`);
- done / total and the missing photos, with the photos themselves;
- "not done" for a day with no run.

It lives in the merchant app's Hours tab next to the timesheet.

## Not built
- An alert for a checklist not done by a set time. The report shows it; a rule can come later if
  owners ask.
