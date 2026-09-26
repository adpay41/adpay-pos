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

## P22b (register)
Receiving a delivery by scan, write-offs at the register behind a PIN, low-stock badges on the tiles,
and sell-by alerts on the cashier's idle screen.
