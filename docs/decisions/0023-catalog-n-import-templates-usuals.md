# 0023: Catalog N: templates, CSV import, repeat-last-sale, cashier usuals, arrange keys

- Status: Accepted
- Date: 2026-09-24
- Build plan: P14 (first tier-N phase). Bible 1.1 (drag-to-arrange, repeat last sale, cashier
  presets), 3.1 (catalog templates, catalog import)
- Extends: ADR 0010 (quick keys), ADR 0013 (register speed), ADR 0002 (server wins on catalog)

## Decisions

### 1. One bulk write path for templates and imports
`services/catalog-bulk.ts` applies a list of rows in **one transaction**: one catalog-version bump,
one audit entry with the counts, and a price-history row for every created item and every price
that changes. Rows match an existing item by barcode (the UPC or an extra barcode) first, then by
name (case-insensitive); otherwise the item is created. Missing categories are created with the
template's settings, including the age restriction.

A **dry run** executes the same code and rolls back, so the preview is exactly what the import will
do.

### 2. Templates live in shared; the demo seed uses the same data
The c-store starter is the NJ/NYC deli-grocery catalog the demo seed always used. It has 7
categories and about 80 items with suggested prices, and **no UPCs**. Moving it into
`packages/shared/src/catalog-templates.ts` means the demo and a real merchant start from identical
data. A licensed 2,000-UPC c-store dataset is ⛔ a data licence; it plugs in as another template.

### 3. Generic CSV first
`parseCatalogCsv` recognises columns by common names:

- name / description / item;
- price / retail;
- card price;
- cost;
- category / department;
- UPC / barcode;
- PLU;
- SKU.

Dollars go through `parseUsdToCents`, never through floats. Bad lines are reported by line
number; importing with bad lines needs an explicit `skip_errors`. Exact parsers for NRS, Clover and
Square exports wait for sample files (⛔).

### 4. Repeat last sale and "the usual" ring through the session
Both build a batch and ring each line with `session.addItem`, exactly like key presses, so today's
prices, tax, charges and events apply.

- One ID confirmation covers a batch that contains age-restricted items.
- An open-price item repeats at the price it was sold at. It is skipped in a usual, since a preset
  has no price for it.
- Fees, returned units and discontinued items are skipped and named on screen.

### 5. Usuals are server configuration, like the catalog
A cashier saves the ticket on screen as a usual from the register. This is an online call, audited,
and it bumps the catalog version. Every register receives it in the snapshot and shows it to that
cashier when they are signed in; a long-press removes it. Usuals are configuration, not ledger, so
removing one touches no sale. There are at most 12 per person.

### 6. Arrange keys in the merchant app
The favorites page gained an arrange view that mirrors the register's key grid: tap a key, then
tap where it goes. This works the same on a phone and on the web, where drag-and-drop is fiddly.
It saves through the existing quick-keys endpoint.

## Not here
- A UPC lookup service for unknown barcodes (⛔ licence).
- Per-system import parsers (⛔ sample files).
