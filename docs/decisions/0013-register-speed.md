# 0013: Register speed: wedge scanner, one barcode key, fuzzy search, quantity merge, items minted on the register

- Status: Accepted
- Date: 2026-09-24
- Build plan: P5 (foundation F4). Bible: L1 (scan part), L3, L4, L5, L6, L28, L29, L55
- Builds on: ADR 0002 (events), ADR 0010 (catalog), ADR 0011 (permissions)

## Context

The average ticket is $13. The Bible targets under 20 seconds a sale, where 45–60 is normal.
Most of that time is finding the item. Stores are full of barcodes the catalog has never seen,
and the register must keep selling offline.

## Decisions

### 1. Keyboard-wedge scanning, decoded by timing
USB and Bluetooth scanners in HID mode "type" the code and press Enter. `WedgeDecoder` (shared)
treats a burst of four or more characters, each at most 50 ms apart and ending in Enter, as a
scan. A person typing is slower, so a scan is never confused with a search.
- In the browser the register listens in the **capture phase**, so a scan while the search box
  has focus rings the item instead of searching for it.
- On the T2s the same HID scanner arrives through the Kotlin module (P-HW) and calls the same
  handler.

### 2. One key per barcode
`barcodeKey` strips leading zeros from numeric codes, so UPC-A, EAN-13 and GTIN-14 spellings of
one product match. The index covers `upc`, the extra `barcodes` (a case barcode carries its
`pack_qty`: scanning a carton rings 10 packs) and `plu`. The server applies the same rule when it
checks a register-created item for duplicates.

### 3. Search that forgives
Every query word must match a word of the name:
- exact, prefix, or one typo for words of 3+ letters ("coke zro", "marlbro", "cofe lrg");
- initials ("bec" → Bacon Egg & Cheese);
- digits: PLU, full UPC, or the **last digits** of a barcode (for a smudged label).

Enter on a single result rings it. Enter on an unknown number offers to add it.

### 4. Quantity: merge only with the line just rung
Ringing the same item again right after itself emits **`sale.line_qty_changed`** instead of a new
line. That covers "tap twice = qty 2" and "scan three cans". Something else rung in between starts
a new line, so the receipt keeps its order. Open-price items never merge, because two weighings
are two lines. A second pack of an age-checked line needs no second prompt. Long-press a tile to
ring a typed quantity; long-press a line to set it (0 removes it).
Lines now record **`price_source`** (catalog, open, override) and **`entry`** (key, scan,
search, new_item). Both are additive with defaults, and `entry` feeds later speed analytics.

### 5. Unknown barcode → an item minted on the register
One screen: name, price, category. The register **mints the item id**, rings it immediately, and
keeps a create command in a local outbox. The sync engine sends it **before** the events, so the
server knows the item before the sales that use it. The server applies it idempotently
(`POST /device/items`):
- **created**: a new item with the device's id;
- **exists**: a replay;
- **aliased**: the barcode was already in the catalog, because another register or admin got
  there first. The device id goes into `item_aliases`, so sales rung under it resolve to the one
  canonical item. The next snapshot carries the canonical item, and the overlay drops ours.

It is gated by a new permission, **`item.create`**, on for cashiers by default (a manager override
otherwise), and audited with the register and the cashier.

### 6. Price check, and speed as a number
Price check shows cash and card prices without ringing. Cost and margin need `item.view_cost`
(managers and owners, or an override). Speed is measured from the events that already exist:
first action (`sale.opened`) to `sale.completed`. The summaries report the **median** seconds
per sale and the share under 20 s. The median is used because one ticket left open over lunch
would wreck a mean.

## Consequences

- Reports by item must resolve `item_aliases` (P11 and P20 will join through it).
- The UPC-database lookup (N, ⛔ licence) slots into the unknown-barcode form as a pre-fill; the
  form and the command stay the same.
- M "predictive next item" and "voice ring-up" call the same `ring(item, {entry})` entry point.
