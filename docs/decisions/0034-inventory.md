# 0034: Inventory: stock folded from movements and sales

- Status: Accepted
- Date: 2026-09-26
- Build plan: P22a (model, merchant app) and P22b (register). Bible 1.9 (receive by scan, low-stock
  badge, case-break, expiry, write-offs), 2.4 (stock levels, low stock, dead stock)
- Extends: ADR 0002 (events), ADR 0032 (price history)

## Decisions

### 1. No editable stock number
Stock per store and item is **folded** (`foldStock`) from:
- **counts**, which set the level at that moment (everything before a count is ignored);
- **receipts**, which add;
- **adjustments**, where a write-off with a reason subtracts;
- **the sales themselves**: completed sales remove what they sold, refunded units come back, and a
  voided sale counts for nothing.

Movements live in one **append-only** table, `inventory_movements` (with the `forbid_mutation`
trigger). They come from the merchant app, or from the register's `inventory.received`,
`inventory.written_off` and `inventory.counted` events, copied in on ingest with the event id as the
row id (idempotent). A wrong count is fixed by the next count.

### 2. Case-break by stock ratio
An item can be kept **in another item's units**: "Marlboro Red — Carton" is 10 × "Marlboro Red —
Pack". Stock is held on the base item, so selling a carton takes 10 packs and receiving 3 cartons adds
30. There's no manual "break a carton" step; the conversion happens in every movement and sale.

A pack can't break into another pack, and an item can't be a pack of itself.

### 3. Low, dead, expiring
- **Low**: on hand at or below the item's low-stock point.
- **Dead**: something on the shelf with no sale in 60 days (Bible 2.4).
- **Expiring**: perishable receipts carry an `expires_on`. Lots dated within 3 days (or past) are
  listed, capped at what the shelf can still hold. There is no lot-level FIFO tracking; the cap
  keeps the number honest.

### 4. Reading it
`GET …/inventory?location_id=` folds on read: movements for the store, and sales since the oldest
last count (at most a year). Correctness comes first; a projection can come later if big catalogs
need one.

The merchant app → **Stock** tab has:
- levels with All / Low / Not selling;
- "Sell soon";
- per item: count, received (invoice number, and expiry for perishables), write off with a reason,
  and the low-stock point;
- "Track an item", including setting up a carton as a pack.

The catalog snapshot carries each item's stock settings, for the register in P22b.

## At the register (P22b)
- **Receive**: scan each case or item. A case barcode counts its pack size; a name search covers items
  without a barcode. The panel takes an invoice number, and an expiry date for perishables. It writes
  one `inventory.received` event per line with a shared receipt id, so it works offline.
  Permission: `inventory.receive` (cashiers have it by default).
- **Write off**: an item, a quantity and a reason, as `inventory.written_off`. Permission:
  `inventory.write_off` (managers), so a cashier needs a manager's PIN.
- **Low-stock badges**: `GET /device/stock` gives the store's levels. The register refreshes them
  every 5 minutes and counts its own completed sales down in between (a carton counts in cartons). A
  tile shows "3 left" at or below the low point, or "Out". Offline, the last levels stay: it's a
  glance, and the server's fold is the truth.
- **Sell soon**: lots near their date show on the cashier's screen between customers.

## Shrink (P23b)
Every count after an item's first records a **variance**: what the fold expected against what was on
the shelf. `GET …/inventory/shrink` (up to a quarter) reports, by category and item and valued at
today's cost:
- units **missing** at counts;
- units **found**, where a count came in over;
- **write-offs by reason**.

Units without a cost are counted apart. The same report carries the cashier patterns from P19b:
sales, voids, refunds and "no sale" opens.

The merchant app shows it on the Stock tab for the last 30 days. Valuing at today's cost keeps the
report simple; margin reports use the cost in force at the time (ADR 0032).
