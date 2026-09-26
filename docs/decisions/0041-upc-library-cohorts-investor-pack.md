# 0041: Global UPC library, cohorts, investor / bank pack

- Status: Accepted
- Date: 2026-09-26
- Build plan: P25c. Bible 3.4 (global UPC library, deduped) and 3.5 (cohort views, investor / bank
  pack)
- Extends: ADR 0013 (barcode key, items minted at the register), ADR 0022 (residuals and KPIs on read)

## Decisions

### 1. The UPC library is the stores' catalogs, deduped on read
- **Nothing is copied.** The library reads every active item's UPC and single-unit barcodes across all
  stores on `barcode_key` (a SQL function, the same rule as the shared `barcodeKey`, with expression
  indexes). UPC-A, EAN-13 and GTIN-14 spellings of one product meet. A store correcting a name
  improves the library; a removed item leaves it.
- **Only real GTINs are shared** (`isGlobalGtin`): 8, 12, 13 or 14 digits with a valid check digit,
  outside the in-store and restricted ranges (UPC-A 2 / 4 / 5, EAN 20–29, 99 coupons). A store's own
  codes (in-store UPCs, deli price labels, typed labels) never leave it.
- **Dedupe:**
  - one vote per store;
  - names are grouped ignoring case, spacing and punctuation (`8 oz` = `8oz`);
  - the most-used name wins, and on a tie, one that isn't all capitals;
  - the category is the most-used one.
- **Price:** the typical price is the median of the stores' cash prices (lower middle, integer cents),
  shown **only when 3 or more stores** carry the item, so no single store's price can be read off it.
- **Where it's used:**
  - the register's unknown-barcode form (online): the name and category fill in, and "N other stores
    sell this, usually for $X" is shown. The price is never filled; the store sets it;
  - the merchant app's new-item form, the same way;
  - the admin page, with search and a "names disagree" list for clean-up.
- **Seeding** the library from a licensed UPC dataset is a separate ⛔ item (data licence).

### 2. Cohorts and the pack are the ledger, by month
- **Cohort:** a store's cohort is the month of its **first completed sale**. Retention in a later month
  means the store made at least one sale that month. Both come from `sale_events`.
- **The investor / bank pack** covers the last 12 months:
  - stores started and active;
  - sales and card volume;
  - revenue split into subscription and processing;
  - margin, over stores with the processor cost entered, with that count shown;
  - the cohort table;
  - average retention at months 1, 3 and 6, counting complete months only;
  - the method notes.
- Each month is that month's residual report (ADR 0022), so the pack and the Money page can never
  disagree.
- It prints from the browser ("Save as PDF"); the monthly table downloads as CSV. Nothing is typed
  into the pack and nothing is stored.

## Boundary
- Margin is only as complete as the typed processor cost, until processor data arrives (ADR 0022).
- Library coverage grows with the stores. A licensed dataset would seed it (⛔ licence).
