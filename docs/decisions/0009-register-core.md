# 0009 — Register core: expo-sqlite event log, text receipts, customer display channel

- Status: Accepted
- Date: 2026-09-23
- Decides spec **Open** items: "SQLite lib (op-sqlite vs WatermelonDB)", "Receipt template format"
- Builds on: ADR 0002 (offline-first events), ADR 0008 (Expo)

## Context

Step 2 is the register core: catalog → cart → cash tender → receipt → drawer → SQLite events → sync,
plus the customer display. The register has to take cash for 72 hours with no server, and every sale
has to reach the server exactly once, to the cent.

## Decisions

### 1. SQLite library: **expo-sqlite** (neither of the two named options)

- **What we store** is an append-only log plus a key-value table. There is no relational model
  on the device and no ORM need. A few thousand inserts a day is nothing for any SQLite binding.
- **expo-sqlite** is first-party for our toolchain (ADR 0008). It runs on Android and **in the browser**
  (wa-sqlite + OPFS), which is how the founder checks the register before hardware arrives. It
  supports WAL and transactions, and triggers make the events table append-only on the device too.
- We use its **async API only**. The sync API on web needs `SharedArrayBuffer` (a cross-origin-isolated
  page). The async API doesn't.

Rejected:
- **WatermelonDB**: built around mutable records and its own sync protocol. Our model is the opposite
  (immutable events, device wins on sales, server wins on catalog, no CRDTs). We would be fighting it.
- **op-sqlite**: the fastest binding, but no web target, and its speed isn't needed at this write volume.
  If profiling on the T2s ever shows SQLite as the bottleneck, only `SqliteEventStore` changes.

### 2. The cart *is* the event log

Every cashier action (add, remove, age check, void, tender, complete, drawer, receipt) appends an
event through `SaleSession`. What the screen shows is `foldSale(events)`, the same function the
server and reports use. There is no second, mutable cart that could disagree with what syncs.
Actions are serialized so `device_seq` is strictly increasing even when someone double-taps.

Cash tender appends `sale.tender_added` and `sale.completed` in one step, before the drawer opens. A
power cut can leave a completed sale without its drawer event, but never a paid sale that isn't
completed. The open ticket's id is kept in the store, so a restart resumes it.

### 3. Sync

`SyncEngine` pushes unacknowledged events oldest-first in batches of 500, and acks go in a separate
table. Because the server is idempotent on `event_id`, a lost response is harmless: the retry
comes back as duplicates. A rejected event is acked as rejected, so it can't block the queue, and is
counted in the device view. Backoff runs from 5s to 60s. The catalog snapshot is cached locally, so
the register boots and sells offline. Unpairing is refused while events are still queued.

### 4. Receipt format: structured text lines, not ESC/POS

`packages/shared/src/receipt.ts` renders a folded sale to 48-column lines, each with a style hint
(`normal | bold | double | center`). The Kotlin printer module maps hints to ESC/POS, and the web
preview maps them to CSS. Rendering from events means a reprint shows the prices actually charged.
Every receipt ends with both the cash-price and card-price totals (dual-pricing disclosure).

### 5. Customer display channel

The register publishes a `DisplayState` (lines with cash and card prices, both totals, the paid/change
screen). On Android, the Kotlin Presentation module will render it on the 10.1" screen. In the browser
it goes over a `BroadcastChannel` to a second window at `?display=customer`.

## Consequences

- **Still to build in step 2, on the device:** a Kotlin/Expo module for the 80mm printer, the RJ12 drawer
  kick, the HID scanner, and the Presentation display. They slot in behind the `Hardware` and
  `DisplayChannel` interfaces; nothing in the session changes.
- The device token is in AsyncStorage for now. On Android it moves to the keystore (expo-secure-store)
  with the kiosk work in step 4.
- Card tender is visible but disabled until the terminal adapter (step 6).
