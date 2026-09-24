# Build plan — Feature Bible tiers L and N

- Source of truth: [`docs/feature-bible.md`](feature-bible.md) (committed verbatim).
- Binding alongside it: [`docs/spec-v1-cstore.md`](spec-v1-cstore.md), [`CLAUDE.md`](../CLAUDE.md), ADRs in `docs/decisions/`.
- Written 2026-09-23 against `main` at `d5ced55` (steps 1 and 2-part-1 merged).
- Scope: **build L and N; defer M.** M items were read so that nothing built now blocks them (section 6).

## 0. Honest summary

- **Counts:** the Bible has about **59 L items** and **about 95 N items**, and some items carry both tiers ("L / N").
- **Built so far:** of the L items, **6 are done** (in the browser, not yet on hardware; two of them are the same feature seen from two sides), **21 are partly done**, and **22 are not started**. Of the N items, essentially **none are started**.
- **Blocked outside the code:** **9 L items are fully blocked**, and about 6 more are partly blocked. They need the PAX A35 terminal, the Finix account under AD Pay LLC, POS hardware, an MDM vendor, or real processor statements. Many N items need a third-party contract, account or data licence.
- **Size:** this is a very large scope. L alone is roughly **22 PR-sized phases**; N is roughly **35–40 more**. At the pace so far (one substantial phase, with tests and a clickable result, per working session), L is **several weeks of sessions**, and L+N is **a few months**. That assumes no rework and excludes device testing. The hardware and processor items will stretch that further, because they run on other people's timelines.
- **Order:** eight **foundations** come first (section 3), because two-thirds of the features sit on them and building features before they exist means rework.

Status legend:
- ✅ done (works end to end in the browser build)
- 🟡 partial (named pieces exist)
- ⬜ not started
- ⛔ blocked outside the code (can be prepared, can't be finished)

The **Phase** column refers to section 5.

---

## 1. Tier L — every item, mapped against the code

### Register

| # | Item (Bible §) | Status | What exists / what's missing | Phase |
| --- | --- | --- | --- | --- |
| L1 | Scan-first, zero-tap sale (1.1) | ⬜ | No scanning. Cash takes 3 taps (Cash → amount → receipt choice). Needs keyboard-wedge scan input and a "default receipt choice" setting. | P5, P8 |
| L2 | Quick-key grid with per-store layout, colors, images, favorites (1.1, L part) | 🟡 | Category grid of uniform white tiles, fixed order. No per-store layout, colors, images or favorites. | P2, P5 |
| L3 | Quantity intelligence: tap twice = qty 2; long-press keypad; case barcode = pack qty (1.1) | ⬜ | Tapping twice adds a second line. No `line_qty_changed` event. | P5 |
| L4 | Item search by name/UPC/PLU/first letters, fuzzy (1.1) | ⬜ | None. | P5 |
| L5 | Unknown barcode flow, manual (1.1) | ⬜ | No scan; no item-create API; no device→server catalog write path. | P2, P5 |
| L6 | Open-price items with keypad (1.1) | ⬜ | No open-price flag on items; line events assume a catalog price. | P2, P5 |
| L7 | Hold / recall tickets (1.1) | 🟡 | `sale.suspended`/`sale.resumed` event types exist, and fold handles them. No UI; only one open ticket at a time. | P7 |
| L8 | Split tender, correct dual pricing per portion (1.1) | 🟡 | Fold sums multiple tenders, but a sale has one `price_mode`. Needs a per-portion pricing rule (design in P9) and a card leg. | P9 |
| L9 | Cash tender keypad with quick-cash buttons (1.2) | ✅ | Exact / next $ / bills, and a cents keypad. | — |
| L10 | Change on the customer screen in big green (1.2) | ✅ | "Paid" state shows change in green (browser window). | — |
| L11 | Drawer discipline: opens only on tender or PIN; every open an event with cashier id (1.2) | 🟡 | `drawer.opened` on cash sale. No PIN, no cashier id, no manual/no-sale open. | P3, P6 |
| L12 | Cash drops / safe drops / paid-outs / paid-ins (1.2) | ⬜ | None. | P6 |
| L13 | Blind cash count at shift end; over/short by cashier; trend (1.2) | ⬜ | No shifts or drawer sessions. | P6 |
| L14 | Terminal tender, amount pushed to PAX (1.3) | ⛔ | PaymentProvider + stub exist; no API endpoint, no terminal pairing. **Needs PAX A35 + Finix (AD Pay LLC account).** The flow can be built end to end against the stub. | P9 (stub), later P-HW |
| L15 | Dual pricing correct on every path: cash, card, split, refund, void; both totals on receipt (1.3) | 🟡 | Cash path + receipt both totals ✅. Card (stub), split, refund, void paths missing. | P7, P9 |
| L16 | Age verification by category, logged with cashier id, time, item (1.4) | 🟡 | Manual prompt + `sale.age_verified` event with time and line. No cashier id; categories for vape/alcohol aren't configurable per state. | P3, P10 |
| L17 | State tax tables, basic: cigarette, vape, sugar, bottle deposit, bag fee, per location, effective dates (1.4) | 🟡 | One sales-tax rate per location + taxable flag per category. No excise, deposits, fees or effective dates. | P10 |
| L18 | Customer screen: live cart with both prices, tax, totals, large type (1.5) | ✅ | Browser second window. (Android Presentation display ⛔ hardware.) | — |
| L19 | Customer screen states idle → cart → "tap card" → approved/declined → thanks + change (1.5) | 🟡 | idle/cart/paid exist. No formal state machine; no tap/approved/declined states. | P9 |
| L20 | 80mm receipt with logo, both prices, disclosure, itemized tax, return policy, QR (1.6) | 🟡 | 48-col text receipt with both totals and disclosure ✅. No logo, itemized tax by rate, return policy or QR. Physical printing ⛔ hardware. | P8 |
| L21 | Reprint any ticket from the register (1.6, L part) | 🟡 | "Reprint last" only. | P7 |
| L22 | 72h offline on cash, full catalog, receipts, drawer (1.7) | 🟡 | Design + tests prove offline sale and exactly-once sync (browser). Not soak-tested; not on device; new features must keep it true. | every phase |
| L23 | Store-and-forward status / "cash only" banner + retry (1.7) | 🟡 | Offline sync pill. No terminal status, no cash-only banner. | P9 |
| L24 | Power-loss safe: tender + completion together before drawer (1.7) | ✅ | Implemented and tested. | — |
| L25 | Self-healing: crash → auto-restart into same ticket (1.7) | 🟡 | Open ticket restores after reload ✅. OS-level auto-restart ⛔ Android build/kiosk. | P-HW |
| L26 | Printer/scanner/terminal health on the sync pill; one-tap tests (1.7) | ⛔ | Needs the hardware module. The health model and UI can be built in P4. | P4, P-HW |
| L27 | Cashier PIN sign-in, roles, permissions per action (1.8) | ⬜ | `users.role` exists (owner/manager/cashier). No PINs, no register sign-in, no permission checks. | P3 |
| L28 | Case-break pricing (1.9, L part) | 🟡 | `sell_unit`/`pack_qty` on items and events; separate carton item in seed. No "scan case barcode → pack". | P5 |
| L29 | Price check: scan without ringing; cash/card/margin (margin with PIN) (1.9) | 🟡 | Step-1 shell had tap-to-price-check; replaced by the sale screen. No scan, no cost/margin. | P5 |

### Merchant app

| # | Item | Status | Notes | Phase |
| --- | --- | --- | --- | --- |
| L30 | Live sales ticker, per register, per cashier (2.1) | ⬜ | Tickets tab is a static list; no push channel; no cashier on sales. | P4, P11 |
| L31 | Today vs yesterday vs same day last week, by hour; "up 12%" (2.1) | ⬜ | Only today/7d/month totals. | P11 |
| L32 | Multi-store switcher (2.1, L part) | ⬜ | A merchant user belongs to exactly one merchant. Needs a membership model. | P3, P11 |
| L33 | Deposits, matched to batches (2.2) | ⛔ | Needs a live processor (Finix under AD Pay LLC). Placeholder text exists. | P-PAY |
| L34 | Item add/edit with photo, pushed to all registers in seconds (2.3) | ⬜ | Items are read-only everywhere. | P2 |
| L35 | Dual-price % per location; preview card prices before pushing (2.3) | ⬜ | % is stored per location; no edit UI. | P2 |
| L36 | Staff list, PINs, roles, permissions from the phone (2.5) | ⬜ | | P3 |
| L37 | Alerts: register offline > 5 min; terminal offline; printer out of paper (2.6) | ⬜ | No heartbeat. Terminal/printer parts ⛔ hardware. | P4, P11 |
| L38 | Alerts: drawer opened outside a sale; void/refund over $X; no-sale spike (2.6) | ⬜ | Needs P6/P7 events + alert rules. | P4, P11 |
| L39 | Delivery channel for alerts (push/SMS/WhatsApp) (2.6) | ⛔ | In-app inbox is buildable. **Push** needs Expo/FCM/APNs accounts; **SMS** a Twilio account; **WhatsApp** a Meta Business account. Those are signups the founder must do. | P4, P11 |
| L40 | Support chat with "share my screen from the register" (2.8) | ⛔ | Chat is buildable. Screen share needs the MDM vendor (open decision: Esper vs own). | P12 (chat) |

### Admin

| # | Item | Status | Notes | Phase |
| --- | --- | --- | --- | --- |
| L41 | Statement analyzer: upload Sola/NRS/Clover PDF → effective rate, markup, savings, one-page PDF (3.1) | ⛔ | Not started. Parsing needs **real sample statements** from each processor; our pricing math needs the **signed Finix rate card**. The upload + manual-entry analyzer + PDF can be built first. | P13 |
| L42 | Merchant onboarding wizard: business info, KYB via processor, pricing plan, dual pricing, catalog template, hardware order, install date (3.1) | 🟡 | Tree-based create forms exist. KYB ⛔ Finix. Hardware order is an external process. The wizard shell + pricing + dual pricing + install date is buildable. | P12 |
| L43 | Setup QR generation and printed install kit (3.1) | 🟡 | One-time setup codes exist; no QR, no printable kit. | P12 |
| L44 | Device page: heartbeat, version, network, printer/terminal/scanner, queue, last 200 log lines, config diff (3.2) | ⬜ | Spec step 3. Hardware status fields ⛔ until the module exists. | P4 |
| L45 | Remote actions: restart, force sync, reprint, printer test, re-pair terminal, push config, roll back build, reboot; audited (3.2) | ⬜ | Force sync / reprint / push config / restart-in-app are buildable in the browser. Reboot, roll back build, printer test ⛔ device/MDM. | P4 |
| L46 | Remote screen view/control via MDM with consent banner (3.2) | ⛔ | Needs the MDM vendor decision and contract. | — |
| L47 | Ticket replay incl. terminal request/response (3.2) | 🟡 | Replay ✅. Terminal request/response comes with P9 (stub) and for real with P-HW. | P9 |
| L48 | Alert console: offline registers, stuck queues, unreachable terminals, high void rates (3.2) | ⬜ | | P4 |
| L49 | Settlement & fee reconciliation (3.3) | ⛔ | Needs live processor settlement files. | P-PAY |
| L50 | Residual/margin report per merchant per month (3.3) | ⛔ | Our revenue side is computable from pricing plans. **Processor cost needs the Finix rate card and real interchange data.** Report shell + manual cost inputs are buildable. | P13 |
| L51 | Pricing plans: dual %, IC+, flat, POS subscription, with history (3.3) | ⬜ | | P12 |
| L52 | Feature flags & vertical packs per merchant; pack editor (3.4) | 🟡 | `merchants.enabled_packs` exists; no flags table, no UI. | P12 |
| L53 | KPIs: active stores, volume, effective rate, margin, churn, support load, installs/week (3.5) | ⬜ | Volume/active stores computable now; margin/effective rate depend on L50. | P13 |

### End customer (Part 4)

| # | Item | Status | Notes | Phase |
| --- | --- | --- | --- | --- |
| L54 | Both prices before paying, every time | ✅ | Customer screen cart state. Must stay true on every new path (split, card). | every phase |
| L55 | Under 20 seconds in and out | ⬜ | A target, not a feature. Measured once scan/quantity/zero-tap land. P5 adds a sale-duration metric to the event log. | P5 |
| L56 | Change in big green numbers | ✅ | Same as L10. | — |
| L57 | Never sees a processor's name, a spinner, or "system down" | 🟡 | Offline sale works silently. Card states and error copy come in P9. | P9 |
| L58 | Customer screen "tap on the card machine" (same as L19) | 🟡 | | P9 |
| L59 | Receipt by text (L / N — N part) | — | Counted under N. | — |

**L tally:** 6 ✅ · 21 🟡 · 22 ⬜ · 9 ⛔, plus L59 counted under N (59 rows). About 6 of the 🟡/⬜ items also have a hardware- or processor-blocked part (L18, L20, L25, L37, L45, L47).

---

## 2. Tier N — every item, mapped

Almost nothing in N exists yet. The table groups items by area and says which foundation each
needs and what blocks it outside the code. **Phase numbers from P14 onward** are the N roadmap in
section 5.

### Register (N)

| Item (Bible §) | Status | Depends on / blocked by | Phase |
| --- | --- | --- | --- |
| Quick-key drag-to-arrange from the merchant app (1.1) | ⬜ | P2 layout model | P14 |
| Unknown barcode UPC database lookup (1.1) | ⛔ | **UPC database licence/API** (e.g. a commercial GS1-sourced feed) | P14 (behind interface) |
| Repeat-last-sale (1.1) | ⬜ | P5 | P14 |
| Cashier presets / "the usual" (1.1) | ⬜ | P3, P5 | P14 |
| Cash-in-drawer alert on the cashier idle screen (1.2) | ⬜ | P6 | P15 |
| Counterfeit note flag (1.2) | ⬜ | P6 | P15 |
| Coin/bill denominations in the count, photo of count sheet (1.2) | ⬜ | P6; photo storage from P2 | P15 |
| Debit preference prompt on terminal (1.3) | ⛔ | PAX + Finix | P-HW |
| Gift cards, physical + digital (1.3) | ⛔ | A gift-card program partner, or an internal stored-value design with legal review (escheat/money-transmission) | P-PAY |
| Manual card entry for phone orders, PIN-gated (1.3) | ⛔ | Must be keyed **on the terminal or the processor's hosted fields**, never our UI (card-data rule). Needs PAX/Finix. | P-HW |
| Tips (1.3) | ⛔ | Card tender (PAX/Finix). The UI and pooling logic are buildable against the stub. | P9+, P-HW |
| ID scan: DL 2D barcode → age, flags, logs (not the ID number) (1.4) | 🟡-able | AAMVA PDF417 parsing is buildable and testable with sample strings. A real 2D scanner is needed to prove it. | P16 |
| Tobacco scan-data reporting (Altria, RJR, ITG) (1.4) | ⛔ | **Program enrollment and contracts** with each manufacturer, plus their file specs | P-3P |
| Manufacturer promo sync (1.4) | ⛔ | Same programs' promo feeds | P-3P |
| Lottery module: pack activation, per-game tracking, inventory, reconciliation vs state terminal, payouts vs drawer (1.4) | ⬜ | P6. Reconciliation is manual entry of terminal totals (no state lottery API integration). | P17 |
| State tax tables, full (1.4) | ⬜ | P10 | P16 |
| Compliance log export (1.4) | ⬜ | P3, P10, P17 | P17 |
| Digital receipt: QR or text-to-phone (1.5) | 🟡-able | QR to a hosted receipt page is buildable (needs a public URL, which means deploying). Text needs SMS (Twilio signup). | P18 |
| Loyalty by phone number on the customer screen (1.5) | ⬜ | P9 customer-screen state machine; a customers table | P19 |
| Language toggle, 8 languages, cashier and customer independently (1.5) | ⬜ | i18n framework (P9 lays the hook). **Human translation/review** of 8 languages. | P18 |
| Deals of the day / promotions in idle (1.5) | ⬜ | P9, promotions (P20) | P20 |
| Lottery results and jackpot in idle (1.5) | ⛔ | A lottery results data feed (NJ/NY), licence terms | P-3P |
| Accessibility: high contrast, large type, screen reader labels (1.5) | ⬜ | | P18 |
| Receipt language follows customer screen (1.6) | ⬜ | P18 | P18 |
| Email/text a receipt later from the merchant app (1.6) | ⛔ | SMS/email provider account | P18 |
| Kitchen/deli ticket to a second printer (1.6) | ⛔ | Second printer hardware | P-HW |
| Label printing, shelf tags with both prices (1.6) | ⛔ | Label printer hardware. Template + PDF output is buildable. | P21 |
| UPS aware (1.7) | ⛔ | Device power APIs, hardware | P-HW |
| Time clock (1.8) | ⬜ | P3 | P15 |
| Shift handover with photo (1.8) | ⬜ | P6 | P15 |
| Training mode (1.8) | ⬜ | Sale path flag that posts nothing | P16 |
| Receive delivery by scan (1.9) | ⬜ | Inventory model (P22), P5 | P22 |
| Low-stock badge (1.9) | ⬜ | P22 | P22 |
| Case-break inventory conversion (1.9) | ⬜ | P22 | P22 |
| Expiry dates, sell-by alerts on idle (1.9) | ⬜ | P22 | P22 |
| Waste/spoilage/theft write-offs with reason, PIN (1.9) | ⬜ | P3, P22 | P22 |
| Hourly target ribbon (1.10) | ⬜ | Reports, P4 push | P15 |
| Mobile register on the owner's phone with Tap to Pay (1.11) | ⛔ | Tap-to-Pay entitlement + processor SDK. Cash-only mobile register is buildable (same RN code). | P-HW |

### Merchant app (N)

| Item | Status | Depends on / blocked by | Phase |
| --- | --- | --- | --- |
| Cash in drawer now, per register; "drop needed" (2.1) | ⬜ | P6 | P15 |
| Multi-store roll-up (2.1) | ⬜ | P11 | P19 |
| Fees, explained (2.2) | ⛔ | Processor fee data | P-PAY |
| Dispute center (2.2) | ⛔ | Processor dispute API | P-PAY |
| Sales tax report, exportable, quarterly pack (2.2) | ⬜ | P10 | P16 |
| Accountant access (read-only) (2.2) | ⬜ | P3 roles | P19 |
| QuickBooks/Xero sync (2.2) | ⛔ | Intuit/Xero developer app accounts | P-3P |
| Profit: margin by item/category once costs are in (2.2) | ⬜ | Cost field (P2), reports | P20 |
| Bulk price change (2.3) | ⬜ | P2 | P20 |
| Price history and who changed what (2.3) | ⬜ | P2 records it from day one; this adds the UI | P20 |
| Promotions builder: 2 for $5, mix & match, BOGO, happy hour (2.3) | ⬜ | Pricing engine extension in shared + events | P20 |
| Shelf label print queue (2.3) | ⛔ | Label printer; see label printing | P21 |
| Stock levels, low stock, dead stock (2.4) | ⬜ | P22 | P22 |
| Reorder suggestions (2.4) | ⬜ | P22 + history | P23 |
| Vendor list; one-tap order text/email (2.4) | 🟡-able | Vendor records buildable; sending needs SMS/email provider ⛔ | P23 |
| Receive by scan, discrepancy report (2.4) | ⬜ | P22 | P22 |
| Shrink dashboard (2.4) | ⬜ | P6, P7, P22 | P23 |
| Hours and payroll export (2.5) | ⬜ | Time clock | P15 |
| Cashier performance (2.5) | ⬜ | P3, P6, P7 | P19 |
| Alerts: EOD not closed; cash short > $Y (2.6) | ⬜ | P6, EOD (P16) | P16 |
| Alerts: big ticket; slow hour; late first sale (2.6) | ⬜ | P4 rules engine | P19 |
| Alerts: chargeback; deposit low (2.6) | ⛔ | Processor | P-PAY |
| Daily WhatsApp summary (2.6) | ⛔ | Meta WhatsApp Business account + approved template | P-3P (content built in P19) |
| Loyalty program setup (2.7) | ⬜ | P19 | P19 |
| Customer list; text a promo to top 100 with TCPA opt-in (2.7) | ⛔ | Opt-in capture buildable; sending needs SMS account + TCPA review | P19 / P-3P |
| Open/close checklists with photos (2.8) | ⬜ | Photo storage (P2) | P24 |
| Equipment and hardware tickets (2.8) | ⬜ | Support tickets (P24) | P24 |
| Documents vault with expiry reminders (2.8) | ⬜ | File storage | P24 |
| Marketplace: order hardware, paper; enroll in programs (2.8) | ⛔ | Fulfilment/payment for orders (a payment account for AD Pay's own billing) | P-3P |

### Admin (N)

| Item | Status | Depends on / blocked by | Phase |
| --- | --- | --- | --- |
| Catalog templates: c-store 2,000 UPCs (3.1) | ⛔ | **A licensed UPC dataset.** The template mechanism is buildable with our 78 demo items. | P14 |
| Catalog import from NRS/Clover/Square exports (3.1) | ⛔ | **Sample export files** from each system to build parsers against | P14 (CSV generic first) |
| E-sign merchant agreement (3.1) | ⛔ | E-sign vendor account, or a legal review of a click-accept flow; the **agreement text** from counsel | P-3P |
| Referral / agent tracking, residual split (3.1) | ⬜ | P12 pricing plans; L50 | P25 |
| Support tickets with SLA timers, canned fixes (3.2) | ⬜ | P4 | P24 |
| Staged rollouts: canary → 10% → all; kill switch (3.2) | ⬜ | P12 flags; OTA build delivery ⛔ (MDM/OTA decision) | P24 |
| Hardware inventory & RMA (3.2) | ⬜ | | P24 |
| Runbooks with fix buttons (3.2) | ⬜ | P4 | P24 |
| Billing: subscriptions, invoices, dunning (3.3) | ⛔ | A billing/payment account for AD Pay itself (Stripe-class) | P-3P |
| Disputes desk (3.3) | ⛔ | Processor | P-PAY |
| Risk monitoring (3.3) | ⛔ | Processor transaction data (keyed-card, MCC) | P-PAY |
| Scan-data program admin (3.3) | ⛔ | Scan-data contracts | P-3P |
| Tax tables by jurisdiction with effective dates; age rules by state (3.4) | ⬜ | P10 | P16 |
| Global UPC library, deduped (3.4) | ⬜ | P2, P5 unknown-barcode items | P25 |
| Receipt/label template editor (3.4) | ⬜ | P8 template model | P21 |
| Translations management (3.4) | ⬜ | P18 | P18 |
| API keys & webhooks for partners (3.4) | ⬜ | | P25 |
| Cohort views (3.5) | ⬜ | P13 KPIs | P25 |
| Investor/bank pack (3.5) | ⬜ | P13 | P25 |

### End customer (N)
Receipt by text, their language, loyalty by phone: covered above (P18, P19).

---

## 3. Foundations — build these first

Two-thirds of L depends on eight pieces of infrastructure. Each foundation is sized so that it ships
with at least one visible feature, never as invisible plumbing.

| # | Foundation | Unblocks | Key design points |
| --- | --- | --- | --- |
| **F1** | **Catalog & item management** | L2, L5, L6, L34, L35; promotions, labels, inventory, UPC library, bulk price, price history | CRUD with **catalog_version bump** on every change; a **price history** table from day one; audited; item flags `open_price`, `cost_cents`, `plu`, extra barcodes (`item_barcodes`, so a case UPC maps to a pack); images stored per item; register pulls the new snapshot on its sync cycle ("pushed in seconds" = next pull, later a WebSocket nudge). Device-created items (unknown barcode) go through an idempotent **catalog command** with a device-generated id, so they work offline and never duplicate. |
| **F2** | **Staff, PINs, roles, permissions** | L11, L13, L16, L27, L36, time clock, overrides, compliance log, cashier performance | Staff are `users` with a per-merchant **register PIN** (hashed, rate-limited, per-device lockout). Roles are owner/manager/cashier, plus a **permission matrix per action** (void, refund, discount, open drawer, price override, paid-out, margin view) editable per merchant. **Every sale/drawer event carries `cashier_user_id`.** Manager override = second PIN on the device, recorded as an event. Replaces the one-merchant-per-user limit with **memberships** (user ↔ merchant ↔ role), needed for L32. |
| **F3** | **Realtime channel, heartbeat, alert rules, notification inbox** (spec step 3) | L30, L37, L38, L44, L45, L48; every N alert | WebSocket server on the API (tenancy-scoped channels). Device heartbeat every 30s with queue depth, version and hardware health slots. A **log ring buffer** on the device, uploadable on request. **Remote action queue** (command → ack → result, audited). An **alert rule engine** (BullMQ) → in-app inbox for merchant and admin. Delivery adapters for push/SMS/WhatsApp behind one interface, stubbed until accounts exist. |
| **F4** | **Hardware abstraction** | L1, L3, L5, L26, L28, L29, ID scan, labels, UPS | Extend the existing `Hardware` interface: **scanner input** (keyboard-wedge HID works in the browser today: a USB scanner "types" the barcode + Enter), printer (receipt lines → device), drawer, health reporting. Web implementations now; the Kotlin/Expo module later implements the same interface (P-HW). |
| **F5** | **Tender & customer-screen state machine** | L8, L14, L15, L19, L23, L57, tips, loyalty, language | One explicit state machine shared by the register and the customer screen: idle → cart → tender(select) → awaiting-terminal → approved/declined → complete(change) → idle, with timeouts and cash-only fallback. A card leg goes through a new **`POST /device/payments/terminal-charge`** that calls `PaymentProvider` (stub today). A request/response event pair goes into the sale timeline. |
| **F6** | **Printing & receipt template v2** | L20, L21, digital receipt, labels, template editor | Structured receipt model: sections, itemized tax by rate, logo slot, return policy, QR payload. Per-location settings. A print-job abstraction with a reprint audit trail. |
| **F7** | **Tax & compliance tables** | L17, L16 (age by category by state), sales tax report, compliance export | Per-jurisdiction rule sets with **effective dates**: sales-tax classes by category, per-unit excise (cigarette, vape), deposits (NY 5¢), bag fees (NJ), sugar tax (Philly). Rules are **captured in the sale events at the time of sale** (like prices today), so historical receipts stay exact. |
| **F8** | **Offline guarantees for new writes** | L22 across all new features | Every new register write (items, cash drops, shifts, PIN events, holds) is an **event or idempotent command** in the same outbox, with device-generated ids. No feature may add a synchronous server dependency to the sale path. A **soak test** (72h simulated clock, thousands of events) is added in the test suite. |

---

## 4. Blocked outside the code (can prepare, can't finish)

| Blocker | L items affected | N items affected | What unblocks it |
| --- | --- | --- | --- |
| **PAX A35 terminal** (hardware on hand) | L14, L26 (terminal part), L37 (terminal offline), L47 (real request/response) | debit prompt, tips, manual card entry | Terminal delivered + Finix terminal provisioning |
| **Finix account under American Dream Pay LLC** (ADR 0006) | L14, L33 deposits, L42 KYB, L49 settlement, L50 processor cost | fees explained, disputes, risk, chargeback alerts | Founder completes underwriting; API keys created **by the founder by hand** |
| **POS hardware** (T2s / Swan 2: printer, drawer, 2nd screen) + **USB and 2D scanners** + Android Studio on this machine | L20 physical print, L25 auto-restart, L26 health, L18 on the real 2nd screen | kitchen printer, label printer, UPS awareness, ID scan (proof) | Devices on the desk; Android Studio; long-path support enabled (see the project-state doc) |
| **MDM vendor** (spec Open: Esper vs own OTA) | L46 remote screen, part of L45 (reboot, roll back build), L40 screen share | staged rollout of builds | A decision + contract (Esper) or an own-OTA design |
| **Real processor statements** (Sola, NRS, Clover PDFs) + **signed Finix rate card** | L41 statement analyzer (parsers), L50 margin | fees explained | The 4 stores' statements (already in hand per the Bible), the pricing agreement |
| **Tobacco scan-data programs** (Altria, RJR, ITG) | — | scan-data reporting, promo sync, scan-data admin | Program enrollment + file specs |
| **UPC database** licence | — | unknown-barcode lookup, 2,000-UPC catalog template, global UPC library seeding | A data licence |
| **Messaging accounts**: Twilio (SMS), Meta WhatsApp Business, Expo/FCM/APNs (push), email | L39 delivery (in-app works without) | receipt by text/email, WhatsApp summary, promos, vendor order texts | Founder signs up (a signup = a stop point for me) |
| **Accounting/e-sign/billing vendors**: Intuit, Xero, e-sign, a billing processor for AD Pay's own invoices | — | QuickBooks/Xero sync, e-sign, billing & dunning, marketplace | Accounts + (for e-sign) the agreement text from counsel |
| **Legal/compliance review** | L17 (tax values), L57 | gift cards (money transmission/escheat), TCPA texting, NJ/NY dual-pricing wording, lottery handling | Counsel / accountant |
| **Public hosting** | — | QR digital receipt page, webhooks | AWS deploy (**needs the founder's explicit go**, cost) |

Rule for these: I build the **interface, data model and UI against a stub or manual entry** where that
has standalone value (e.g. the statement analyzer with manual entry, the terminal flow on the stub).
I mark the item ⛔ and **don't claim it done**. I don't build parsers or integrations speculatively
without real specs or sample files.

---

## 5. Build phases (each one PR, with tests and something clickable)

Rules for every phase:
- lands as **one PR into `main`**, green on lint/typecheck/tests-on-real-Postgres/gitleaks;
- adds tests for the new behaviour (API on real Postgres; register logic; UI smoke where reasonable);
- keeps the binding rules: integer cents, immutable events, no card data, Finix isolated;
- keeps the register fully offline-capable (F8);
- ends with a short "what to click" note in the PR.

Size: **S** ≈ 1 session, **M** ≈ 2–3, **L** ≈ 4+. These are estimates for a phase landing cleanly
with tests.

### Tier L

| Phase | Name | Contents | Bible items | Size |
| --- | --- | --- | --- | --- |
| **P1** | **Catalog management (F1, part 1)** | Catalog API: create/edit/deactivate items and categories; `catalog_version` bump; price history; audit. New item fields: open-price, cost, PLU, extra barcodes. Dual-price % per location with card-price preview. **Admin catalog editor.** Register picks up the new version on its next sync. | L35, foundation for L2/L5/L6/L34 | M |
| **P2** | **Catalog from the phone (F1, part 2)** | Merchant app item add/edit with **photo** (camera/file → stored → served), category management, dual-price % + preview. Quick-key layout model: per-location tile order, colors, favorites, image tiles. Register renders it. | L34, L2 (L part), L35 | M |
| **P3** | **Staff, PINs, roles, permissions (F2)** | Memberships, register PIN sign-in/out, permission matrix, manager override prompt. `cashier_user_id` on all events. Staff management in the merchant app and admin. | L27, L36, L11/L16 (cashier id), L32 (model) | L |
| **P4** | **Ops layer (F3, spec step 3)** | WebSocket channel; device heartbeat; log ring buffer + upload; remote action queue (force sync, reprint, push config, restart app, log tail); **admin device page**; alert rules engine + **alert console** + in-app inbox; hardware-health slots. | L44, L45 (in-app part), L48, L26 (model), L37/L38 (engine) | L |
| **P5** | **Register speed (F4 scanner)** | Keyboard-wedge scan; item search (name/UPC/PLU/prefix/fuzzy); tap-again = qty+1; long-press qty keypad; case barcode → pack; open-price keypad; **unknown-barcode create** (offline-safe command); price check mode (margin with PIN); sale-duration metric. | L1 (scan part), L3, L4, L5, L6, L28, L29, L55 | L |
| **P6** | **Cash management** | Shifts / drawer sessions; drawer only on tender or PIN; no-sale; **cash drop / safe drop / paid-out / paid-in**; **blind count** at close; over/short by cashier; admin + merchant reports. | L11, L12, L13 | M |
| **P7** | **Ticket lifecycle** | Hold/recall (multiple parked tickets); void completed sale (PIN); **refunds** (cash, stub card) with dual pricing; reprint any ticket (register ticket list). | L7, L15 (void/refund paths), L21 | M |
| **P8** | **Receipt v2 & printing (F6)** | Logo, itemized tax by rate, return policy, QR slot, per-location receipt settings; print-job model; default "no receipt / print" setting (supports zero-tap). | L20, L1 (zero-tap part) | S–M |
| **P9** | **Tender state machine, card on the stub, split tender (F5)** | Shared state machine; customer screen tap/approved/declined/cash-only states; `terminal-charge` endpoint → PaymentProvider (stub); split tender with per-portion dual pricing (design recorded in an ADR); terminal request/response in ticket replay; customer-facing error copy with no processor names or spinners. | L8, L14 (stub), L15, L19, L23, L47, L57 | L |
| **P10** | **Tax & compliance tables, basic (F7)** | Per-location rule sets with effective dates: sales-tax classes, cigarette/vape excise, NY bottle deposit, NJ bag fee; age rules by category (vape/alcohol/tobacco/lottery); captured in events; itemized on receipt. **Values need accountant sign-off.** | L16, L17 | M |
| **P11** | **Merchant app, L** | Live ticker (WebSocket); today vs yesterday vs same day last week by hour; multi-store switcher; alert inbox + settings (thresholds); per-cashier views. | L30, L31, L32, L37, L38 | M |
| **P12** | **Admin onboarding & config, L** | Onboarding wizard (business info, pricing plan, dual pricing, catalog template, install date; KYB step stubbed ⛔); **setup QR + printable install kit**; pricing plans with history; feature flags + pack editor; support chat (text). | L42 (minus KYB), L43, L51, L52, L40 (chat) | L |
| **P13** | **Admin money & portfolio, L (partial)** | Statement analyzer with **manual entry** + one-page PDF (parsers wait for sample statements ⛔); residual/margin report with manual processor-cost inputs ⛔; KPIs dashboard. | L41 (partial), L50 (partial), L53 | M |
| P-HW | Hardware module (step 2 remainder) | Kotlin/Expo module: printer, drawer, scanner, Presentation 2nd screen, health; Android build; kiosk basics; auto-restart. | L18/L20/L25/L26 on device | L — ⛔ hardware |
| P-PAY | Finix live | Real terminal charge, deposits, settlement reconciliation. | L14, L33, L49 | L — ⛔ Finix/PAX |

**L total:** 13 buildable phases (≈ 4 S–M, 5 M, 4 L), roughly **25–30 sessions**, plus two blocked phases.

### Tier N (after L; order can shift with the founder's priorities)

| Phase | Name | Main items | Size |
| --- | --- | --- | --- |
| P14 | Catalog N | drag-to-arrange keys; repeat-last-sale; cashier presets; generic CSV import; catalog templates mechanism (UPC lookup ⛔) | M |
| P15 | Cash & time N | drawer-over alert; counterfeit flag; denominations + count photo; time clock; shift handover; hours/payroll export; hourly target ribbon; cash in drawer now | M |
| P16 | Compliance & EOD N | full tax tables + admin editor; sales tax report/export; ID scan (AAMVA parse); training mode; end-of-day / Z-report + EOD alerts | L |
| P17 | Lottery module | packs, activation, inventory, manual reconciliation, payouts vs drawer, compliance export | M |
| P18 | Language, accessibility, receipts N | i18n (8 languages, translation review ⛔), receipt language, high-contrast/large type, digital receipt QR (hosting ⛔), receipt by text (SMS ⛔) | L |
| P19 | Customers & roll-ups | loyalty by phone (customer screen), customer list + opt-in, multi-store roll-up, accountant role, cashier performance, more alert rules | L |
| P20 | Pricing N | bulk price change, price history UI, promotions builder (engine + register + receipt), profit/margin reports, idle-screen deals | L |
| P21 | Labels & templates | shelf-tag/barcode label templates → PDF (label printer ⛔), receipt/label template editor | M |
| P22 | Inventory | stock levels, receive by scan, low-stock badges, case-break conversion, expiry, write-offs, dead stock | L |
| P23 | Ordering & shrink | reorder suggestions, vendors, shrink dashboard | M |
| P24 | Ops N | support tickets + SLA + canned fixes + runbooks, hardware inventory/RMA, staged rollouts/kill switches (build OTA ⛔ MDM), checklists, documents vault | L |
| P25 | Platform N | referral/agent tracking, API keys & webhooks, global UPC library, cohort views, investor pack | M |
| P-3P | Third-party integrations as accounts land | scan-data, promo sync, WhatsApp, SMS/email, QuickBooks/Xero, e-sign, billing, lottery feed | each M, ⛔ |

**N total:** ~12 buildable phases, roughly **35–40 sessions**, plus the third-party integrations,
each gated on an account or contract.

**Overall:** about **60–70 working sessions** of buildable work for L+N, excluding hardware testing,
third-party integration and the rework that real merchants' feedback will cause. It's a large program.
The sequence front-loads what makes the register faster and supportable, which is what the
statements and the spec both say matters most.

---

## 6. M items — read, deferred, and not blocked

Nothing in L/N forecloses an M item. The seams M needs are built as part of the foundations:

| M item | Seam we keep open |
| --- | --- |
| Predictive next item | Sale events keep full line data per basket, so the co-occurrence data is there |
| Pay-by-bank QR | `PaymentProvider` + tender state machine allow a new tender type; customer screen has a QR-capable state |
| Khata / store tab | Tender types are an enum in shared; a `tab` tender + customer ledger fits beside loyalty's customers table |
| Bill pay / top-up | Non-sale service lines fit as a line kind in events (P10 adds line kinds for deposits/fees) |
| Charity round-up, ad network | Customer screen state machine has an extensible idle/promo slot |
| Manager override by phone, approvals | F2 overrides are events; F3 has a command channel to the merchant app |
| Camera panel, panic alert | Register UI has a slot model; F3 alert delivery interface |
| Delivery / WhatsApp orders | Tickets can be opened by a non-register source (hold/recall model in P7) |
| Voice ring-up, camera recognition | Scanner abstraction accepts any "item resolved" source |
| Self-checkout, line-buster | Tender state machine is independent of who drives it; permissions model has a "customer" role slot |
| Vendor invoice AI, price intelligence, savings coach, cash advance, health score, benchmarks | Cost field + price history (P1) + clean event data; no design choices here depend on them |

Per the Bible's Part 6, each M item gets its own design doc before work starts, and no M item starts
until three stores have run 30 days on L without a truck roll.

---

## 7. Relationship to the spec's sequencing

The spec says to build step 3 (ops layer) before features, and not to start a step until the one
above works end to end.
- **Step 2's remainder is hardware-blocked** (P-HW), so it can't be finished now.
- **The ops layer is P4:** after the catalog and staff foundations it depends on (device page needs
  cashiers; remote "push config" needs a catalog that changes), and **before** the register feature
  work of P5–P9.
- **P1–P3 are foundations, not features.** Admin catalog editing and staff/permissions are listed in
  the spec itself (admin "catalog + config editor"; API "auth, multi-tenant guards").

This is a deliberate, recorded deviation: hardware blocks strict order, and the Feature Bible makes L
part of v1.

## 8. Progress log

| Phase | PR | Status |
| --- | --- | --- |
| Plan + Feature Bible | #4 | merged |
| P1 Catalog management | #5 | PR open — admin catalog editor (items, categories, barcodes, open price, cost, PLU), dual-price % with card-price preview, price history, `catalog_version` bump; the register picks up changes on its next sync tick (≤15s). 72 tests on real Postgres. |
