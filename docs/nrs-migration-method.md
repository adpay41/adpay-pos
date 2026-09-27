# Moving a store off NRS: getting the price book with real barcodes

A repeatable method for every NRS store we sign. It gets the store's whole price book, **with the
real UPCs**, out of the NRS merchant portal, then imports it with the NRS importer (ADR 0043):

- merchant app → Items → Import;
- admin → merchant → Catalog → Move from NRS.

The plain-language, step-by-step version for whoever sits with the owner is
[`nrs-extract-howto.md`](nrs-extract-howto.md).

Found by the founder on the first pilot store (NRS store 45394, 9,284 items), 2026-09-27.

## Why not the portal's "Export" button

The price book CSV the portal exports **encrypts the barcode column**. Every `Upc` cell looks like
`="<96–106 hex characters>|<storeId>"`. We can't reverse it, so a CSV import has no barcodes and
the store would have to scan every item once before it rings by scan.

The importer still accepts that CSV as a fallback: see *CSV fallback* below.

## Where the real barcodes are

The portal's price-book page (the **PB Items** table) fills itself from a DataTables server-side
endpoint:

```
https://pos-papi.nrsplus.com/{userToken}/pbitems/{storeId}/default?<DataTables paging params>
```

- `{userToken}` is the merchant's **session token** for the portal, of the form `u<digits>-<hex>`.
  It is a credential: never paste it into a ticket, a doc, chat or the repo.
- `{storeId}` is the NRS store number (5 digits on the pilot).
- The answer is JSON: one row per item with the **plain barcode**, price in cents, department, and
  NRS's item flags.

The endpoint is **CORS-blocked** from any other origin, so it can't be fetched from our servers or
another page. It has to be read **from inside the portal page, in the merchant's own logged-in
browser**, by asking the page's own table for every row.

## Extraction, step by step

This needs the merchant's **own portal login**. The merchant, or our installer sitting with the
merchant, does it on a computer; we never ask for or store their NRS password. It only reads data
and changes nothing in NRS.

1. On a desktop browser (Chrome), sign in to the NRS merchant portal as the store and open the
   price-book items page, the one with the **PB Items** table.
2. Open the browser's developer console (F12 → Console).
3. Make the table load every item in one page, then read its rows:

   ```js
   const dt = jQuery('#pbitems').DataTable();
   dt.page.len(10000).draw(false);          // use a number above the store's item count
   ```

4. Wait until the table shows the whole list: the footer reads "Showing 1 to N of N". Check
   `dt.page.info().recordsTotal` equals the number of rows you got.

   ```js
   const rows = dt.rows().data().toArray();
   rows.length;                              // must equal dt.page.info().recordsTotal
   ```

5. Save the rows as a file:

   ```js
   const a = document.createElement('a');
   a.href = URL.createObjectURL(new Blob([JSON.stringify(rows)], { type: 'application/json' }));
   a.download = `nrs-pricebook-${location.pathname.match(/\d{4,}/)?.[0] ?? 'store'}-full.json`;
   a.click();
   ```

6. Upload that file in the importer. Check the preview: the item count must equal the portal's
   count, and the barcode count should be "real product barcodes" for nearly every item. Then
   import.

For a store with more than 10,000 items, raise the page length in step 3. A very large store
may be slow to draw.

> Steps 3–5 are the method the founder ran on store 45394, written up here. **For installers, use
> the one-paste snippet in [`nrs-extract-howto.md`](nrs-extract-howto.md)**: it finds the table and the
> store number by itself, clears filters, pages through if the server caps a request, checks the
> count and barcodes, and saves the file. It was tested against a local mock of the portal
> (server-side table, 12,345 items, capped and uncapped, a different table id, an active search).
> We haven't run it on the live portal: our only access was a login page, and we don't sign in to a
> merchant's account. The first time, check that the file's item count matches the portal.

## What the file holds, and where each field goes

As captured on store 45394. All 9,284 rows had every key below. The table reports `plu`; some
notes call it `upcorplu`, and the importer accepts both.

| NRS field | On the pilot | Goes to | Notes |
| --- | --- | --- | --- |
| `upc` | 9,284 of 9,284 filled; 12-, 13- or 8-digit; no duplicates | `items.upc` (scans by `barcode_key`) | 9,263 real GTINs. 21 are in the in-store ranges: 7 store-made 2-prefix codes, plus 14 vape/nicotine codes starting 4 or 5. These scan in this store but are never shared to the UPC library. |
| `plu` / `upcorplu` | Same as `upc` on 9,277 items; a short code on 7 | `items.plu` when 3–6 digits (4 items) | `00`, `01` and `1` can't be PLUs here: kept on the item as `short_code`, flagged. |
| `name` | always | `items.name` (trimmed, 120 max) | 1,277 duplicate names (same name, different barcode): each stays its own item. About 120 placeholder names ("1", "A") are flagged "rename". |
| `desc` | name + size | `attrs.nrs.description` when it differs | |
| `size` | 2/3 empty | `attrs.nrs.size` | |
| `dept` | 21 departments | category (created if new) | The preview suggests Taxed / No tax and the age rule from the name ("Grocery Non-Taxable" → No tax; "all smoke", "Premium cigar" → tobacco 21+; "Beers" → alcohol 21+). **The owner confirms each one** before importing. Existing categories keep their settings. |
| `cents` | integer cents | cash price | |
| `cents` = 0 or `variableprice` | 5 | `items.open_price = true` | The cashier types the price. |
| `cost_cents` / `cost_qty` | **cost on only 2 items** (both equal to price) | `items.cost_cents` = cost ÷ qty | NRS carries almost no cost for this store, so margin reports start "uncosted" until costs are entered, for example from the first vendor invoices (receiving, ADR 0034/0035). |
| `isebt` | true 421, false 499, null 8,364 | `attrs.nrs.ebt` | Kept for when EBT tender exists. |
| `byweight` | 6 | `attrs.nrs.by_weight` | Rung per each (no scale). The 6 are packaged goods (Blow Pops, Babybel), so the NRS flag looks wrong. |
| `includes_taxes` | 582 | `attrs.nrs.price_includes_tax` | **Not applied.** We add tax on top by category, so these shelf prices ring higher than in NRS: see *Open*. |
| `includes_fees` | 605 | `attrs.nrs.price_includes_fees` | Not applied: deposits and fees come from the location's per-unit charges by tax class (ADR 0018). |
| `fee_multiplier` | 1 item ≠ 1 | `attrs.nrs.fee_multiplier` | Flagged. |
| `ismodifier` | never true | `attrs.nrs.modifier` | |
| `unit_upc` / `unit_count` | empty on every item | case-break: pack `stock_of` the unit, `stock_ratio` = count | Mapped and tested. The pilot has no packs. |
| `status` | 1 on every item | `items.active` | Anything other than 1 imports inactive. |
| `qty` | 1 on every item | — | |
| `numpromos`, `item_groups` | 0 / empty on every item | — | NRS promotions and groups aren't in this table. |
| one-click keys | not in the JSON; the CSV's `is_oneclick` is `n` on every row | quick keys: **0** | The report says so. Favorites are set in Items → Favorites. |

## Re-uploading

Uploading an updated price book later **updates in place**:

- items match by barcode, so a new price, name or department updates the existing item;
- price changes go to the price history;
- nothing is duplicated.

Items the store added with us since the migration are left alone. Items gone from NRS are not
deleted: we never delete from an upload.

## CSV fallback

The importer also takes the portal's CSV export as-is. Each row's encrypted `Upc` is kept as the
item's NRS key, so re-importing the same export matches instead of duplicating. Those items have
no barcode: the first scan of an unknown barcode on the register attaches it to the item.

Whether the encryption gives the same value in every export is unknown: we have one export. If it
doesn't, re-importing a CSV matches by name instead. **Prefer the JSON.**

## Caveats

- **The merchant's own login, every time.** We don't hold NRS credentials, and the session token
  is theirs.
- **Read-only.** The method only reads the table. Nothing in the store's NRS configuration
  changes.
- **The endpoint is NRS's, undocumented.** It can change without notice. If it does, the rows'
  field names are what to check: the importer reads by field name and reports anything it can't
  read, by line.
- **Data.** The file is the store's whole price book. Keep it off shared drives; it isn't
  committed to our repo. The full-file test reads it from the local disk.
