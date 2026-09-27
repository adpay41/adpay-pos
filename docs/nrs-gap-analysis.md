# NRS feature gap analysis

- Date: 2026-09-27
- Source: 20 photos of a working NRS register at a customer store (`WhatsApp_Image_2026-09-27*`). They
  show the sale screen, back office, pricebook, departments, one-click pages, reports, vendors and
  promotions.
- Purpose: a **feature** reference only. We copy capabilities where the founder decides they're worth
  it, never their layout, styling or wording.
- Method: every row was checked against our code on `main` (plus PR #44), not from memory. Where the
  code settles it, the file is named.

**Status key**
- **Have**: works today.
- **Partial**: the core exists, but a real piece of what NRS does is missing.
- **Missing**: not built.

**Size key** (engineering, including tests)
- **S**: up to 1 day.
- **M**: 2–4 days.
- **L**: 1–2 weeks.
- **XL**: more than 2 weeks, or an open design question.

## The one structural gap

**Ringing an amount straight to a department, with no item record, is not possible today.**
- Every sale line (`sale.line_added`, `packages/shared/src/events.ts`) requires an `item_id`. The
  register can only ring an item from the catalog.
- The closest we have is an item flagged "open price", where the cashier types the price. That still
  needs one item per department to be set up first.
- NRS stores work this way all day: "Grocery not tax $2.00" in the photos is a department ring, and
  so are the one-click keys "$10", "$15", "$20", "Medicine $2.00".
- Stores migrating from NRS will expect this on day one.
- Fixing it touches the core: the line event, the fold, receipts, the Z-report, the sales-tax report,
  inventory (department lines carry no stock) and the profit report (no cost).
- **Size L. Nothing external blocks it.**

## Sale screen

| Capability | Us | Evidence in our code | If missing or partial: size, blocker |
| --- | --- | --- | --- |
| Department ring (amount to a department, no item) | **Missing** | `LineAdded.item_id` required; only per-item `open_price` | L, see above. No blocker |
| Named, tabbed quick-key pages (e.g. In-Store / Deli / Coffee) | **Partial** | One ★ Favorites page per store (`location_quick_keys`) plus a page per category. No owner-named pages | M: pages = named, ordered lists of keys, editable in the merchant app, carried in the snapshot. No blocker |
| Size variants under a key (12 / 16 / 20 / 24 oz) | **Missing** | No variants or modifiers anywhere. Sizes are separate items ("Hot Coffee — Small/Medium/Large") | Cheap version S: a quick-key page per product holds the sizes, which falls out of the pages work. Real variants or modifier groups ("Modifiers" in their pricebook): L |
| Keys that ring a fixed amount ("$10", "$15") | **Partial** | Possible only by creating an item per amount | Falls out of the department ring (a key = department + preset amount). S once that exists |
| `@` key for quantity × item | **Missing** | Quantity comes only from tapping a tile repeatedly (qty merge). No numeric entry before the item | S–M, with the on-screen keypad (layout items 5–6) |
| SKU / PLU direct entry | **Have** | Search box takes UPC/PLU/name + Enter (`packages/shared/src/scan.ts`); items carry `plu` | A dedicated PLU key on the keypad is part of items 5–6 |
| Keypad and quick cash on the main screen | **Partial** | Quick amounts (Exact / $5 … $100) exist inside the Cash popup | Items 5–6 in progress (layout proposal pending the founder) |
| Tender: Credit/Debit | **Have** | Card via `PaymentProvider` (stub until the A35 / Finix) | Real card processing: ⛔ terminal + Finix account |
| Tender: Cash | **Have** | | |
| Tender: Check | **Missing** | `TenderTypeSchema = ['cash','card']` | S–M: a new tender type across the fold, drawer, Z, reports and receipt. No blocker |
| Tender: Other (EBT, gift card, house account…) | **Missing** | Same | M for a generic "other" tender with a named sub-type and a reference. Each real sub-type is its own row below |
| Second card processor as its own tender (their "Sola CC") | **Missing** | One `PaymentProvider` per deployment | Not recommended: one processor by design (ADR 0003) |
| Refund (with a receipt) | **Have** | Tickets → pick lines → refund, manager approval (ADR 0015) | |
| Refund without a receipt (their free "Refund" key) | **Missing** | Refunds only against a ticket on this register | M: a refund-mode sale (negative lines) with a permission and reason, through the fold, drawer and Z. No blocker |
| Lottery payout | **Dropped** | Lottery was dropped at the founder's request (P17) | — |
| Basket (whole-ticket) discount | **Missing** | Only line discounts (`sale.line_discounted`) | M: a ticket-level discount event (amount or %) spread across lines for tax, with a permission and receipt line. No blocker |
| Tax-free sale (whole ticket) | **Missing** | Tax comes only from the category (ADR 0042) | S–M: a ticket-level exemption with reason and permission, captured on the sale; the tax report shows exempt sales. No blocker |
| Food service mode (kitchen tickets) | **Missing** | The restaurant pack is a stub | L, and a printer: kitchen tickets need a network kitchen printer (P-HW) |
| Print basket (print the open ticket, e.g. to the kitchen) | **Missing** | Receipts print only after payment (or reprint) | S for a guest "bill" before payment. Kitchen routing: with food service, above |
| Hold / recall | **Have** | ADR 0015 | |
| Cancel (void open ticket) | **Have** | "Void ticket" | |
| Check price | **Have** | Price check mode (cost behind permission) | |
| No sale | **Have** | Drawer → No sale, with approval | Main-screen shortcut: items 5–6 |
| Cash drop | **Have** | Drawer → Safe drop | Main-screen shortcut: items 5–6 |
| Vendor payout | **Partial** | Paid-out with reason "Vendor delivery" and a free-text payee (`DrawerCashMovement.payee`). Not linked to our vendor list or a purchase order | S–M: choose the vendor and optionally a PO; merchant app shows spend per vendor (their Vendor Management totals). No blocker |
| Customer account (store tab / khata) | **Missing** | No house accounts. Loyalty-by-phone exists but holds no balance | L: account per customer, charge as a tender, payments against it, statement, limit, permission. Must not keep phone numbers without consent (ADR 0029). No external blocker |
| Built-in calculator | **Missing** | — | S |
| Receipts lookup | **Partial** | Register "Tickets": this register's last 40 sales, with reprint and refund | S: browse by date (their picker) and search by total or time |
| "Other functions" menu | **Have** (different shape) | All functions are buttons; items 5–6 regroup them | — |
| Configurable prompt line for the cashier ("ask for their club number…") | **Missing** | Only the loyalty prompt on the customer screen | S: an owner-set message on the register, in the snapshot |
| Terminal ID on screen | **Partial** | Register name and store in the top bar; a device ID is not shown | S |
| Store prepaid-services balance on screen ("BOSS Bal") | **Missing** | — | Only matters with top-up services (below) |
| Panic alarm button | **Missing** | — | ⛔ needs an alarm-monitoring service or hardware |

## Services and integrations

| Capability | Us | Evidence | Size, blocker |
| --- | --- | --- | --- |
| Order management / online orders arriving at the register | **Missing** | No ecommerce or delivery-order intake | XL. ⛔ Each marketplace (DoorDash / Uber Eats / Grubhub) needs a partner account and API contract. Our partner webhooks (ADR 0039) go outward only |
| Phone top-up, PINless and mobile recharge | **Missing** | — | L plus contract. ⛔ Needs a top-up provider agreement (their "BOSS Revolution"), a prepaid balance and settlement |
| Store club / points shown at checkout ("BOSS Club") | **Have** (ours) | Loyalty by phone, punch card or points (ADR 0029) | "Promo requires club membership" is missing: S on top of loyalty |
| EBT SNAP / EBT Cash tenders; EBT-eligible departments and items | **Missing** | No EBT anywhere | The eligibility flags are S. The tender needs an EBT-capable processor/terminal (⛔ Finix + A35) and USDA FNS retailer authorization per store |
| Weighed items / scale | **Missing** | No by-weight items | M software, plus a scale integration (⛔ P-HW, NTEP-approved scale; their "NTEP CC" line is this). Deli price-embedded labels already ring at the printed price (ADR 0033) |
| Kitchen / USB printer choice when printing | **Missing** | — | Comes with food service (P-HW) |
| ID scanning | **Have** (built, hardware-blocked) | ADR 0026 | Proof needs the 2D scanner (P-HW) |
| Marketplace (buy store supplies) | **Missing** | Deferred earlier as ⛔ (needs fulfilment) | — |

## Back office on the register (their home menu)

| Capability | Us | Evidence | Size, blocker |
| --- | --- | --- | --- |
| Manage pricebook, departments, one-click pages, vendors, users and promotions **on the register itself** | **Partial by design** | We do all of this in the merchant app (phone/web) and admin. The register can only add an unknown item | M–L if the founder wants a register-side back office: the merchant app's screens behind an owner PIN in a kiosk-safe view. No blocker; a product choice |
| Department settings: name, colour, hide from register, minimum age, taxes, EBT-eligible, dept type | **Partial** | Category name, hide, restriction (state age), Taxed / No tax (ADR 0042); `categories.color` and `min_age` columns exist but aren't editable in the merchant app; no EBT; no dept type | S for colour and min age in the editor; EBT flag with EBT |
| Pricebook list: UPC/PLU, department, stock, promos, profit, cost, price, with sort and search | **Have** | Merchant app Items, Stock, price history, profit (ADRs 0032, 0034) | |
| Multi-select edit (by item / by department) | **Partial** | Bulk price change by category (ADR 0032). No general multi-select for other fields (department, tax, hide) | S–M |
| Item: quantity pricing ("N items for $X") | **Have** (as a promotion) | Promotions `multi_price` (ADR 0031) | |
| Item: modifier groups | **Missing** | — | L (with food service or variants) |
| Item: "is a carton" | **Have** | Case-break, stock ratio (ADR 0034) | |
| Item: price includes tax | **Missing** | Prices are always before tax | M: tax-inclusive items (tax backed out at ring time), everywhere tax is computed. No blocker |
| Item: fees and fee multiplier (e.g. bottle deposit × 6 for a six-pack) | **Partial** | Per-unit charges by category, including deposits (ADR 0018). No per-item multiplier for multi-packs | S |
| Promotions: regular, BOGO, buy X get Y, bundle | **Have** | `multi_price` (N for $X, mix and match = bundle), `buy_get` (BOGO / BXGY), `percent_off` (happy hour) | |
| Promotions: by weight | **Missing** | No weighed items | With the scale |
| Promotions: clubs and points | **Partial** | Loyalty is separate from promotions | "Deal only for members": S |
| Terminal statistics: baskets, items, net sales, average, **scan ratio**, payments by method, net sales by department, payouts / drops | **Partial** | Merchant app Sales (by hour, register, cashier), Cash (drops, payouts, over/short), Z-report by category. The register only has the X/Z preview. **Scan ratio** isn't reported, though every line records how it was entered (`entry: key \| scan \| search \| new_item`) | Scan ratio: S (data already captured). Terminal stats on the register: S–M |
| Report tabs: shift, CC transactions, cash-discount (dual pricing), CC batch, ecommerce, kiosk, loyalty | **Partial** | Shift = drawer sessions; loyalty = Customers; dual-pricing totals are in reports | CC transaction / batch: ⛔ processor data (Finix). A cash-discount (dual pricing) report is S |
| Vendor management: list with number of payments, total spent and last payment | **Partial** | Vendors with delivery days and orders (ADR 0035); no payout history per vendor | Comes with the vendor-payout link above (S–M) |
| Users | **Have** | Staff, PINs, roles, permissions (ADR 0011) | |
| Training and help | **Have** | Training mode (ADR 0025), support chat and tickets (ADR 0036) | |
| Licence, warranty and version info | **Have** | Hardware warranty in admin and merchant app (ADR 0036); build version in heartbeat / Fleet | |

## Things we have that NRS doesn't show

These are useful for the founder's pitch:
- dual pricing shown on every tile and on the customer screen;
- a customer-facing second screen in the customer's language;
- a 72-hour offline cash register;
- live owner ticker and alerts on the phone;
- inventory folded from receipts and write-offs with reorder suggestions;
- open/close checklists with photos;
- documents vault;
- remote support actions.

## Suggested order, if the founder wants to close gaps

1. **Department ring** (L). The biggest migration blocker, and the fixed-amount keys depend on it.
2. **Named quick-key pages** (M), with size keys as a page per product.
3. **Keypad on the main screen with `@` quantity and PLU** (items 5–6, M).
4. **Basket discount** (M), **tax-free sale** (S–M), **check and "other" tenders** (S–M), **refund without receipt** (M).
5. **Vendor payout linked to vendors / POs** (S–M), **calculator**, **prompt line**, **receipts by date**, **scan ratio** (S each).
6. **Customer house accounts** (L).
7. Blocked on outside parties:
   - EBT: processor and FNS;
   - scale / by weight: hardware;
   - kitchen printing / food service: hardware;
   - top-up services: provider contract;
   - online orders: marketplace contracts;
   - panic alarm: monitoring service.
