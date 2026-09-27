# 0047: Named key pages, the @ key and the PLU key

- Status: Accepted
- Date: 2026-09-27
- Source: NRS gap analysis, items 2–3 of the suggested order ("named quick-key pages", "keypad with
  @ quantity and PLU")
- Extends: ADR 0010 (quick keys), ADR 0045 (the pad), ADR 0046 (department ring)

## Decisions

### 1. Named key pages
- **What they are.** The owner's own register tabs per store ("Deli", "Coffee bar"), in order, after
  ★ Favorites and before the departments.
- **Keys.** A key is an **item**, or a **department with a fixed amount**: their "$10" and "Medicine
  $2.00" keys, rung through the department ring (ADR 0046). A department key with no amount asks
  for the price.
  - This also covers "size variants" the cheap way: a page per product holds its sizes.
- **Storage.** `key_pages` holds one row per page, with its keys as a validated list
  (`PageKeySchema`: item, or department + amount + label). Limits: 12 pages, 60 keys each, and
  unique names per store.
- **Saving.** A save replaces the store's pages in one transaction. It checks that every item and
  department belongs to the merchant, bumps the catalog version so registers pick it up, and is
  audited. Pages are configuration, not ledger.
- **Delivery.** The catalog snapshot carries `key_pages`. The register drops keys whose item or
  department is inactive or gone.
- **Where the owner edits them.** Merchant app → Items → Pages:
  - add, rename, reorder and delete pages;
  - add items by search, or a department with an optional amount and label;
  - reorder keys (↑ ↓) and remove them.

### 2. The @ key
- Type a count (1–999) on the pad, then press **@**.
- The display shows "3 ×" until the next ring: a tapped key, a scan, a search result, a PLU or a
  department key. That ring comes in that many times, and the count clears.
- A case barcode's pack quantity is multiplied by it.

### 3. The PLU key
Type the digits, then press **PLU**. The lookup order:
1. the PLU as typed;
2. the PLU without leading zeros;
3. any PLU equal once both lose their leading zeros (a cashier typing 9014 finds NRS's 09014);
4. the digits as a barcode.

Nothing found says "No item with PLU …". The pad now keeps leading zeros as typed; they never change
an amount.

## Verified
- **API:** pages save in order, reach the register's snapshot with a version bump, and a save
  replaces them. Foreign items and duplicate names are refused.
- **Register:** pad digits, @ count and PLU lookup are unit-tested.
- **Browser, local stack:** a "Coffee bar" page (three coffee sizes and a "$10 grocery" key) shows as
  a tab. `3 @` then Medium rang "3 × Hot Coffee — Medium $6.75" and cleared the count. The $10 key
  rang Grocery $10.00.
