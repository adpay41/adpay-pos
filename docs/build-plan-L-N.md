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
| L1 | Scan-first, zero-tap sale (1.1) | ✅ | P5 scan-first + P8 zero-tap: with "no receipt unless asked", scan → Exact → the register clears itself for the next customer (change still shown). | P5, P8 |
| L2 | Quick-key grid with per-store layout, colors, images, favorites (1.1, L part) | ✅ | P2: per-location favorites page, category + item order, fixed-palette tile colors, product photos (ADR 0010). Drag-to-arrange is N (P14). | P2 |
| L3 | Quantity intelligence: tap twice = qty 2; long-press keypad; case barcode = pack qty (1.1) | ✅ | P5: ring the same item again = qty +1 (`sale.line_qty_changed`); long-press tile or line for a typed qty; case barcode = pack qty. | P5 |
| L4 | Item search by name/UPC/PLU/first letters, fuzzy (1.1) | ✅ | P5: name prefix / first letters / one-typo fuzzy ("coke zro"), UPC (any spelling), PLU, last digits of a barcode. | P5 |
| L5 | Unknown barcode flow, manual (1.1) | ✅ | P5: unknown barcode → one screen (name, price, category) → rung at once, offline; synced via idempotent `POST /device/items`, duplicates aliased (ADR 0013). | P5 |
| L6 | Open-price items with keypad (1.1) | ✅ | P5: open-price items ask for the price on a cents keypad; card price follows the dual %; `price_source: open` on the line. | P5 |
| L7 | Hold / recall tickets (1.1) | ✅ | P7: Hold parks the ticket (`sale.suspended`), several at once, survive restart; Recall brings one back and holds whatever was open instead of losing it. | P7 |
| L8 | Split tender, correct dual pricing per portion (1.1) | ✅ | Cash + card, two cards, any order. Each tender covers cash-price cents (card `a` covers `a × C/K`); finishing on either tender closes the sale exactly; the customer never pays the card price on the cash part. `splitTotals` declares what was taken, tax blended the same way. ADR 0017. | P9 |
| L9 | Cash tender keypad with quick-cash buttons (1.2) | ✅ | Exact / next $ / bills, and a cents keypad. | — |
| L10 | Change on the customer screen in big green (1.2) | ✅ | "Paid" state shows change in green (browser window). | — |
| L11 | Drawer discipline: opens only on tender or PIN; every open an event with cashier id (1.2) | ✅ | P3 + P6: the drawer opens only on a cash tender, a recorded movement, a count, or "no sale" behind `drawer.no_sale` (or a manager PIN); every open is an event with the cashier and a reason. | P3, P6 |
| L12 | Cash drops / safe drops / paid-outs / paid-ins (1.2) | ✅ | P6: safe drops, paid-outs (with payee) and paid-ins, each with a reason, as events; permission-gated; in the merchant app and admin Cash views. | P6 |
| L13 | Blind cash count at shift end; over/short by cashier; trend (1.2) | ✅ | P6: blind count at close (expected hidden until after); over/short by cashier and by day; drawer-short alert over $5. | P6 |
| L14 | Terminal tender, amount pushed to PAX (1.3) | ⛔ | Built end to end against the stub (P9): `POST /device/payments/terminal-charge` → `PaymentProvider.terminalCharge`, idempotent on the tender id, retry-safe. **Real terminal still needs PAX A35 + Finix (AD Pay LLC account).** | P9 (stub ✅), later P-HW |
| L15 | Dual pricing correct on every path: cash, card, split, refund, void; both totals on receipt (1.3) | ✅ | Cash, card and split sales; refunds by line at the price paid (card refunds back to the card, capped at what's left on the charge); void of a split sale refunds each tender its own way; both totals on every receipt. Split sales refund by void, not by line (ADR 0017). | P7, P9 |
| L16 | Age verification by category, logged with cashier id, time, item (1.4) | ✅ | Manual prompt + `sale.age_verified` with time, line and cashier (P3). Categories carry a restriction kind (tobacco/vape/alcohol/lottery); the state's age rule applies (NJ/NY tables, per-location overrides), captured on the line (P10, ADR 0018). State values need counsel sign-off. | P10 |
| L17 | State tax tables, basic: cigarette, vape, sugar, bottle deposit, bag fee, per location, effective dates (1.4) | ✅ | Per location: sales-tax schedule by class with effective dates (switches at store midnight, offline too); per-unit charges (excise, deposit, fee; fixed or %) by category/item with dates; bag-fee key; NJ/NY/NYC draft templates; captured in the line event, itemized on the receipt (P10, ADR 0018). **Values need accountant sign-off.** | P10 |
| L18 | Customer screen: live cart with both prices, tax, totals, large type (1.5) | ✅ | Browser second window. (Android Presentation display ⛔ hardware.) | — |
| L19 | Customer screen states idle → cart → "tap card" → approved/declined → thanks + change (1.5) | ✅ | `DisplayPhase` idle/cart/card/approved/declined/paid, driven by the register; paid-so-far shown on split. | P9 |
| L20 | 80mm receipt with logo, both prices, disclosure, itemized tax, return policy, QR (1.6) | 🟡 | P8: logo, both prices + disclosure, tax itemized by rate, return policy, QR (store link), per-location settings with live preview. Physical 80mm printing ⛔ hardware module; digital-receipt QR ⛔ hosting (N). | P8, P-HW |
| L21 | Reprint any ticket from the register (1.6, L part) | ✅ | P7: register Tickets list (last 40) → reprint any ticket; refunds print the ticket with a refund footer. | P7 |
| L22 | 72h offline on cash, full catalog, receipts, drawer (1.7) | 🟡 | Design + tests prove offline sale and exactly-once sync (browser). Not soak-tested; not on device; new features must keep it true. | every phase |
| L23 | Store-and-forward status / "cash only" banner + retry (1.7) | ✅ | Cash-only banner whenever the register can't reach the server (card button off, cash untouched); a card request that got no answer offers "Try again" with the same idempotency key, so a retry can't double-charge. | P9 |
| L24 | Power-loss safe: tender + completion together before drawer (1.7) | ✅ | Implemented and tested. | — |
| L25 | Self-healing: crash → auto-restart into same ticket (1.7) | 🟡 | Open ticket restores after reload ✅. OS-level auto-restart ⛔ Android build/kiosk. | P-HW |
| L26 | Printer/scanner/terminal health on the sync pill; one-tap tests (1.7) | ⛔ | P4 built the health model (per-slot state in every heartbeat, device panel, alerts) and the remote printer test. Real readings need the hardware module. | P-HW |
| L27 | Cashier PIN sign-in, roles, permissions per action (1.8) | ✅ | P3: tap name → PIN, checked on-device (offline); lockout; 12-action permission matrix; manager override by PIN (ADR 0011). | P3 |
| L28 | Case-break pricing (1.9, L part) | ✅ | P5: extra barcodes carry a pack qty — scanning a carton rings 10 packs. | P5 |
| L29 | Price check: scan without ringing; cash/card/margin (margin with PIN) (1.9) | ✅ | P5: Price check mode (scan or tap, nothing rung); cost/margin behind `item.view_cost` or a manager PIN. | P5 |

### Merchant app

| # | Item | Status | Notes | Phase |
| --- | --- | --- | --- | --- |
| L30 | Live sales ticker, per register, per cashier (2.1) | ✅ | Merchant app Today: live ticker over `/ws` (register + cashier names on the feed), figures refresh on each sale; per-cashier totals; cashier on every ticket row (P11, ADR 0019). | P4, P11 |
| L31 | Today vs yesterday vs same day last week, by hour; "up 12%" (2.1) | ✅ | `/merchant/sales/compare`: three days by hour, "so far" cut at the same store-local time, % in integer tenths; merchant app chart + "up 12.5% vs yesterday" (P11). | P11 |
| L32 | Multi-store switcher (2.1, L part) | ✅ | P3: memberships (one person, a role per store) + store switcher in the merchant app. Roll-up is N (P19). | P3 |
| L33 | Deposits, matched to batches (2.2) | ⛔ | Needs a live processor (Finix under AD Pay LLC). Placeholder text exists. | P-PAY |
| L34 | Item add/edit with photo, pushed to all registers in seconds (2.3) | ✅ | P1 admin editor + P2 merchant app with camera/library photo; registers pick it up on the next sync tick (≤15s; instant with the P4 WebSocket nudge). | P1, P2 |
| L35 | Dual-price % per location; preview card prices before pushing (2.3) | ✅ | Admin (P1) and merchant app (P2), both with a preview of every card price that changes. | P1, P2 |
| L36 | Staff list, PINs, roles, permissions from the phone (2.5) | ✅ | P3: merchant app Staff tab (people, roles, PINs, remove, permission matrix) + admin Staff tab. | P3 |
| L37 | Alerts: register offline > 5 min; terminal offline; printer out of paper (2.6) | 🟡 | P4: register offline > 5 min and hardware-error alerts fire and show in the merchant app's Alerts tab. Alert settings in the merchant app: mute any merchant rule (P11). Terminal/paper readings ⛔ hardware; push/SMS delivery ⛔ accounts. | P4, P11 |
| L38 | Alerts: drawer opened outside a sale; void/refund over $X; no-sale spike (2.6) | ✅ | P6: no-sale spike (5+/register/day). P7: refund or void ≥ $25 alert naming who did it. Per-merchant thresholds (refund/void $, drawer short $, no-sale count) set in the merchant app (P11). | P6, P7, P11 |
| L39 | Delivery channel for alerts (push/SMS/WhatsApp) (2.6) | ⛔ | In-app inbox is buildable. **Push** needs Expo/FCM/APNs accounts; **SMS** a Twilio account; **WhatsApp** a Meta Business account. Those are signups the founder must do. | P4, P11 |
| L40 | Support chat with "share my screen from the register" (2.8) | ⛔ | Chat ✅ (P12b): merchant app Help tab ↔ admin Support inbox, live over `/ws`, unread counts, per-merchant flag. Screen share needs the MDM vendor (open decision: Esper vs own). | P12 (chat) |

### Admin

| # | Item | Status | Notes | Phase |
| --- | --- | --- | --- | --- |
| L41 | Statement analyzer: upload Sola/NRS/Clover PDF → effective rate, markup, savings, one-page PDF (3.1) | ⛔ | Not started. Parsing needs **real sample statements** from each processor; our pricing math needs the **signed Finix rate card**. Manual-entry analyzer ✅ (P13): effective rate, markup, savings per offered plan, printable one-page PDF, saved analyses. PDF upload/parsing still ⛔ samples. | P13 |
| L42 | Merchant onboarding wizard: business info, KYB via processor, pricing plan, dual pricing, catalog template, hardware order, install date (3.1) | 🟡 | Admin → Onboarding: six-step wizard in one transaction (org, merchant + pack categories, owner, location + draft tax template, registers, pricing plan, install date, hardware note) and a pipeline (setting up → ready → live on first pairing) (P12a, ADR 0020). KYB ⛔ Finix; hardware ordering is external (noted). | P12 |
| L43 | Setup QR generation and printed install kit (3.1) | ✅ | Printable kit: one card per unpaired register with a setup QR (the code; the register's scanner pairs it), Wi-Fi (printed only) and support number; fresh 14-day codes (P12a). | P12 |
| L44 | Device page: heartbeat, version, network, printer/terminal/scanner, queue, last 200 log lines, config diff (3.2) | ✅ | P4: admin `/devices/:id`, live. Real hardware readings ⛔ until the device module (P-HW); browser reports `preview`. | P4 |
| L45 | Remote actions: restart, force sync, reprint, printer test, re-pair terminal, push config, roll back build, reboot; audited (3.2) | 🟡 | P4: restart app, force sync, push config, reprint any ticket, printer test (preview), fetch logs, sign out — queued, pushed over `/ws` or the heartbeat, audited, results reported. Re-pair terminal / roll back build / reboot ⛔ device module + MDM. | P4, P-HW |
| L46 | Remote screen view/control via MDM with consent banner (3.2) | ⛔ | Needs the MDM vendor decision and contract. | — |
| L47 | Ticket replay incl. terminal request/response (3.2) | 🟡 | Replay ✅; every terminal request and answer is a `sale.card_attempt` event in the sale's timeline (stub) ✅. Real terminal responses with P-HW. | P9, P-HW |
| L48 | Alert console: offline registers, stuck queues, unreachable terminals, high void rates (3.2) | ✅ | P4: `/alerts`, live, with rules for offline registers, stuck queues, rejected events, hardware errors (terminal once it reports), PIN lockouts, void rate. | P4 |
| L49 | Settlement & fee reconciliation (3.3) | ⛔ | Needs live processor settlement files. | P-PAY |
| L50 | Residual/margin report per merchant per month (3.3) | ⛔ | Our revenue side is computable from pricing plans. **Processor cost needs the Finix rate card and real interchange data.** Report ✅ (P13): card volume from the ledger, revenue from the plan in force, cost typed per merchant-month (audited), margin. Automated cost ⛔ Finix. | P13 |
| L51 | Pricing plans: dual %, IC+, flat, POS subscription, with history (3.3) | ✅ | Append-only plans with effective dates (dual / IC+ / flat + monthly + per register); current = latest started; dual plan can set location markups (P12a). | P12 |
| L52 | Feature flags & vertical packs per merchant; pack editor (3.4) | ✅ | Code-defined flags with per-merchant overrides in the snapshot (card payments, item create, price check, hold, support chat), honoured by the register and app; pack editor seeds starter categories (P12b, ADR 0021). | P12 |
| L53 | KPIs: active stores, volume, effective rate, margin, churn, support load, installs/week (3.5) | ✅ | Admin → Money → KPIs: live/active stores, quiet-14-days churn list, volume, revenue, margin (where cost entered), effective rate, support load, installs per week (P13, ADR 0022). | P13 |

### End customer (Part 4)

| # | Item | Status | Notes | Phase |
| --- | --- | --- | --- | --- |
| L54 | Both prices before paying, every time | ✅ | Customer screen cart state. Must stay true on every new path (split, card). | every phase |
| L55 | Under 20 seconds in and out | 🟡 | P5: measured — median seconds per sale and % under 20 s in admin and merchant summaries. Hitting the target needs real stores and hardware. | P5 |
| L56 | Change in big green numbers | ✅ | Same as L10. | — |
| L57 | Never sees a processor's name, a spinner, or "system down" | ✅ | All customer copy in `ui/copy.ts`; card states are still text, no spinner, no processor name; decline copy is ink, not red. Wording review still listed under Legal/compliance. | P9 |
| L58 | Customer screen "tap on the card machine" (same as L19) | ✅ | | P9 |
| L59 | Receipt by text (L / N — N part) | — | Counted under N. | — |

**L tally:** 33 ✅ · 12 🟡 · 4 ⬜ · 9 ⛔, plus L59 counted under N (59 rows). About 6 of the 🟡/⬜ items also have a hardware- or processor-blocked part (L18, L20, L25, L37, L45, L47).

---

## 2. Tier N — every item, mapped

Almost nothing in N exists yet. The table groups items by area and says which foundation each
needs and what blocks it outside the code. **Phase numbers from P14 onward** are the N roadmap in
section 5.

### Register (N)

| Item (Bible §) | Status | Depends on / blocked by | Phase |
| --- | --- | --- | --- |
| Quick-key drag-to-arrange from the merchant app (1.1) | ✅ | Merchant app favorites → Arrange keys: the register grid, tap a key then where it goes (P14). | P14 |
| Unknown barcode UPC database lookup (1.1) | ⛔ | **UPC database licence/API** (e.g. a commercial GS1-sourced feed) | P14 (behind interface) |
| Repeat-last-sale (1.1) | ✅ | Register ↻ Repeat last: today's prices, one ID check, skips returned/discontinued (P14). | P14 |
| Cashier presets / "the usual" (1.1) | ✅ | Save the ticket as a usual at the register; one-tap chips per signed-in cashier on every register (P14, ADR 0023). | P14 |
| Cash-in-drawer alert on the cashier idle screen (1.2) | ✅ | Cashier-side banner over the merchant's drop threshold with a suggested drop; drawer_over alert (P15, ADR 0024). | P15 |
| Counterfeit note flag (1.2) | ✅ | "Reject a bill" from the cash tender or drawer: logged event, counted in the cash report (P15). | P15 |
| Coin/bill denominations in the count, photo of count sheet (1.2) | ✅ | Blind close by bill & coin (must add up) + camera photo uploaded via /device/media (P15). | P15 |
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
| Time clock (1.8) | ✅ | Clock in/out by the cashier's name, separate from sign-in; punches are events; hours in the merchant app, weekly overtime (P15). | P15 |
| Shift handover with photo (1.8) | ✅ | Close with count (+photo) → next session starts with that float, outgoing cashier clocked and signed out (P15). | P15 |
| Training mode (1.8) | ✅ | Separate in-memory session: cash only, no drawer, receipts say TRAINING, never synced (P16a, ADR 0025). | P16 |
| Receive delivery by scan (1.9) | ⬜ | Inventory model (P22), P5 | P22 |
| Low-stock badge (1.9) | ⬜ | P22 | P22 |
| Case-break inventory conversion (1.9) | ⬜ | P22 | P22 |
| Expiry dates, sell-by alerts on idle (1.9) | ⬜ | P22 | P22 |
| Waste/spoilage/theft write-offs with reason, PIN (1.9) | ⬜ | P3, P22 | P22 |
| Hourly target ribbon (1.10) | ✅ | Register top bar: today so far vs yesterday by now, from /device/pulse (P15). | P15 |
| Mobile register on the owner's phone with Tap to Pay (1.11) | ⛔ | Tap-to-Pay entitlement + processor SDK. Cash-only mobile register is buildable (same RN code). | P-HW |

### Merchant app (N)

| Item | Status | Depends on / blocked by | Phase |
| --- | --- | --- | --- |
| Cash in drawer now, per register; "drop needed" (2.1) | ✅ | Merchant app Cash → In the drawers now (P15). | P15 |
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
| Hours and payroll export (2.5) | ✅ | Merchant app Hours tab: per person per day, overtime, CSV export (P15). | P15 |
| Cashier performance (2.5) | ⬜ | P3, P6, P7 | P19 |
| Alerts: EOD not closed; cash short > $Y (2.6) | ✅ | eod_missing after 1 a.m. store time (P16a); drawer short > $Y (P6, threshold P11). | P16 |
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
| Catalog templates: c-store 2,000 UPCs (3.1) | ⛔ | Mechanism ✅ (P14): c-store starter template (~80 items, shared with the demo seed), preview + apply. **The 2,000-UPC dataset needs a licence.** | P14 |
| Catalog import from NRS/Clover/Square exports (3.1) | ⛔ | Generic CSV ✅ (P14): column names recognised, preview, match by barcode then name, price history. Per-system parsers need **sample export files**. | P14 (CSV generic first) |
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
| P16a End of day & training | #21 | PR open — end of day / Z-report (spec v1): everything since the previous Z, drawer counted first, printed, eod.closed synced; server rebuilds each Z with the same function and flags mismatches; EOD-not-closed alert; merchant app Z list; training mode (in-memory, never synced, cash only, receipts say TRAINING). ADR 0025. |
| P15 Cash & time N | #20 | merged — drop-needed threshold (cashier banner, merchant "in the drawers now", drawer_over alert), counterfeit refusals, denomination counts + count-sheet photo, shift handover, time clock with weekly overtime and payroll CSV, hourly target ribbon. ADR 0024. |
| P14 Catalog N | #19 | merged — catalog templates (c-store starter shared with the seed) and generic CSV import through one bulk write (dry-run preview, match by barcode then name, price history); register repeat-last-sale and cashier usuals; merchant-app arrange-keys grid. ADR 0023. |
| P13 Admin money & portfolio | #18 | merged — statement analyzer (manual entry + offer, savings per plan, printable one-page PDF), residual/margin report per merchant-month (ledger volume, plan revenue, typed processor cost), KPI dashboard (stores live/active/quiet, volume, revenue, margin, effective rate, support load, installs/week). ADR 0022. **Last buildable tier-L phase**: remaining L items are hardware/processor/account-blocked. |
| P12b Flags, packs, support chat | #17 | merged — feature flags per merchant (code defaults + overrides, in the snapshot, honoured by the register: card, item create, price check, hold; and the app: support chat), pack editor seeding starter categories, support chat (merchant Help tab ↔ admin Support inbox, append-only, unread, live). ADR 0021. |
| P12a Onboarding, install kit, pricing | #16 | merged — admin onboarding wizard (one transaction: org, merchant + catalog template, owner, location + draft tax template, registers, plan, install date) and pipeline (live on first pairing; KYB ⛔); printable install kit with setup QR per register (14-day codes, scanner-pairable); append-only pricing plans with history. ADR 0020. P12b (feature flags, pack editor, support chat) follows. |
| P11 Merchant app, L | #15 | merged — live ticker over `/ws` with register and cashier names, today vs yesterday vs same day last week by hour cut at the same time ("up 12.5%"), per-cashier totals and cashier on tickets, per-merchant alert settings (mute rules, refund/short/no-sale thresholds) honoured by the rules, inbox and push. ADR 0019. |
| P10 Tax & compliance tables | #14 | merged — per-location dated sales-tax schedule by class, per-unit charges (deposit, excise, fee; fixed or %) with dates, bag-fee key on the register, age rules by state and restriction kind, NJ/NY/NYC draft templates; resolved at ring time by store-local date and captured in the line event; charges itemized on the receipt and refunded with the unit. Admin editor + merchant-app restriction toggle. ADR 0018. |
| P9 Card & split tender | #13 | merged — card on the stub through an idempotent `terminal-charge` endpoint, split tender (cash + card, two cards) with dual pricing per portion, card refunds and split voids, customer-screen card states, cash-only banner and safe retry, card attempts in the sale timeline. ADR 0017. |
| P8 Receipt v2 | #12 | merged — per-location receipt settings (logo, header lines, return policy, footer, QR link, after-sale ask/print/none) edited in admin and the merchant app with a live preview; tax itemized by rate; zero-tap cash sale. ADR 0016. |
| P7 Ticket lifecycle | #11 | merged — hold/recall (several parked tickets), register Tickets list with reprint, refunds by line at the price paid, void of a completed sale (refund rest + void), PIN-gated; large refund/void alert. ADR 0015. |
| P6 Cash management | #10 | merged — drawer sessions (counted float), safe drops / paid-outs / paid-ins with reasons, no-sale behind a PIN, blind count, over/short by cashier and day (merchant app Cash tab, admin Cash tab), drawer-short and no-sale-spike alerts. ADR 0014. |
| P5 Register speed | #9 | merged — keyboard-wedge scanning, forgiving search, qty merge + long-press qty, case barcodes, open price, unknown barcode → item minted on the register (offline outbox, idempotent, aliases), price check with cost behind a PIN, sale-speed metric. ADR 0013. |
| P4 Ops layer | #8 | merged — heartbeat every 30 s, device log ring + upload, remote-action queue (WS push + heartbeat fallback, audited), admin Fleet / Device page / Alert console, alert rules every minute, merchant Alerts tab, realtime `/ws` over LISTEN/NOTIFY (instant catalog nudge, live sales feed). ADR 0012. |
| P3 Staff, PINs, roles, permissions | #7 | merged — memberships (store switcher), register sign-in by name + PIN checked on-device, lockout, permission matrix + manager override, `actor_user_id` on every event; Staff tab in the merchant app and admin. ADR 0011. |
| P2 Catalog from the phone | #6 | merged — merchant app: add/edit items with photo (camera or library, shrunk on the phone), tile color, favorite toggle; favorites page, category order/add/hide, dual-price % with preview. Admin: photo, color, favorites panel. Register: ★ Favorites page first, colored tiles with photos. ADR 0010. |
| P1 Catalog management | #5 | merged — admin catalog editor (items, categories, barcodes, open price, cost, PLU), dual-price % with card-price preview, price history, `catalog_version` bump; the register picks up changes on its next sync tick (≤15s). 72 tests on real Postgres. |
