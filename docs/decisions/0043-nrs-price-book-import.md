# 0043: NRS price book import: real barcodes from the portal JSON, CSV fallback, scan-to-attach

- Status: Accepted
- Date: 2026-09-27
- Source: tester feedback item 7 ("bring my NRS price book over"); the founder's extraction of the
  pilot store's items with real barcodes (store 45394, 9,284 items). Method:
  [`docs/nrs-migration-method.md`](../nrs-migration-method.md)
- Extends: ADR 0023 (one bulk catalog write, dry-run preview), ADR 0013 (items minted on the
  register, outbox), ADR 0034 (case-break)

## Decisions

### 1. Two inputs, one parser, in shared
`parseNrsPricebook` (packages/shared) detects the file and turns either format into one row shape,
with problems by line and counts of what can't be carried over (`flags`).

| Input | Barcodes |
| --- | --- |
| Portal items JSON: an array, or a DataTables `{ data: [...] }` | **Primary.** Real barcodes |
| Portal CSV export | **Fallback.** Encrypted `Upc`: no barcode; the hash is kept as the item's NRS key |

- It reads by field name (`plu` or `upcorplu`).
- Money arrives as integer cents and stays integer.
- A barcode that appears twice in one file is a line error.

### 2. Same bulk write as templates and CSV, now batched
`bulkUpsert` (ADR 0023) plans in memory and writes in 1,000-row `unnest` batches: items, updates,
price history.

- One transaction, one version bump, one audit entry, as before.
- The preview is the same write, rolled back.
- The pilot's 9,284 items preview in about 2 s and import in about 2 s. Row by row, this took 44 s.

### 3. Matching: barcode, then NRS key, then name, never duplicating
1. By barcode, including extra barcodes.
2. By NRS key (CSV rows).
3. By name, with limits:
   - only onto an item that was already in the catalog before this import;
   - each item is taken at most once;
   - never onto an item that another row of the same file reaches by barcode or key;
   - a row with a barcode only takes over an item that has none.

What this guarantees:
- One name on two barcodes stays two items. The pilot has 1,277 duplicate names.
- Re-uploading updates in place.
- A CSV export whose encrypted barcodes changed still lands on the same items.
- An NRS import also updates the item's name.
- Nothing is ever deleted by an upload.

### 4. Departments become categories the owner confirms
The preview lists every department with a suggestion taken from its name:

- "Non-Taxable" → No tax;
- smoke / cigar / tobacco → tobacco 21+;
- vape → vape 21+;
- beer / wine / liquor → alcohol 21+.

The owner switches Taxed / No tax and the age rule per department before importing. Categories
already in the catalog keep their own settings.

### 5. What maps, and what is kept but not applied
- **Maps directly:**
  - `upc` → UPC;
  - a 3–6 digit short code → PLU;
  - `cents` → cash price;
  - `cost_cents ÷ cost_qty` → cost;
  - `$0` or `variableprice` → open price;
  - `status` ≠ 1 → inactive;
  - `unit_upc` / `unit_count` → case-break (`stock_of`, `stock_ratio`).
- **Kept on the item (`items.attrs.nrs`) for later features and support:** EBT, by-weight,
  price-includes-tax, price-includes-fees, fee multiplier, modifier, size, NRS description, NRS
  key, short codes that can't be PLUs.
- **Counted in the preview and the final report as "couldn't carry over exactly":**
  - tax-inclusive prices;
  - fee-inclusive prices;
  - by-weight items;
  - the fee multiplier;
  - store-range barcodes;
  - short codes;
  - placeholder names;
  - missing cost.

  Each comes with examples.
- **Quick keys:** the JSON has none, and the CSV's `is_oneclick` is `n` on every row. The report
  says "0" and points to Favorites.

### 6. Upload in the merchant app and in admin
- Merchant app: Items → Import (web build; a phone gets a pointer).
- Admin: merchant → Catalog → "Move from NRS".

Both call `POST …/catalog/import/nrs` (16 MB body) and show the same text through
`nrsImportReport`: items, categories, quick keys, and what couldn't be mapped.

### 7. Scan-to-attach on the register
An unknown barcode's form now also offers "It's an item we already have": search by name, pick,
and it rings.

- The barcode becomes the item's UPC if it has none, else an extra barcode.
- It rings at once and is queued in the new-items outbox. That works offline and survives a
  restart; attaches are sent after new items.
- Server: `POST /device/items/barcodes`, idempotent by barcode key. A barcode another item already
  has changes nothing (`taken`).
- It uses the same `item.create` permission as creating an item.

This is how items from a CSV import get their barcodes, and how any item without one gets fixed.

### 8. The store's file is not in the repo
It is a real store's whole price book (4.6 MB). A built-in fixture covers the rules in CI. The full
JSON and CSV files run when they are on disk (`NRS_FIXTURE`, `NRS_FIXTURE_CSV`) and are asserted
completely: 9,284 and 9,279 items imported, then re-imported as all unchanged.

## Open (for the founder)
- **Tax-inclusive prices (582 items on the pilot).** NRS rings these with the tax inside the shelf
  price. We add tax on top, so they ring higher than in NRS. They are kept and flagged, not
  converted.
  - Choice A: back the tax out at import. The shelf price stays the same; the pre-tax price
    becomes odd cents.
  - Choice B: support a "price includes tax" item that the register rings inclusive.

  B is right for cigarettes and similar items, but it touches the pricing fold.
- **Cost:** NRS has cost on 2 of 9,284 items, so margin starts almost empty. Costs arrive with
  receiving (ADR 0034/0035) or a cost CSV.
