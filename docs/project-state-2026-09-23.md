# AD Pay POS — project state as of 2026-09-23

A self-contained briefing for someone planning the next round of work. It assumes you've never seen
the repo and can't run it. It describes what exists **today**, including where it is thin.

**One-line summary:** the foundation and the first half of the register are built and tested. All
three apps run locally and are clickable. The UIs are **working first drafts**: functional, on-brand,
but plain, with large gaps in features and polish. Nothing is deployed; no real payments, no real
hardware.

Code status: two open pull requests on `github.com/adpay41/adpay-pos`, neither merged into `main`:
- **PR #2** `step1/foundation` → `main`: foundation (API, database, auth, the three app shells).
- **PR #3** `step2/register-core`, stacked on #2: the register's sale flow and offline sync.

Both pass CI (lint, typecheck, tests with database tests on real Postgres 16, and a secret scan).

---

## 1. The product and who it's for

**American Dream Pay LLC** (New Jersey) is building a point-of-sale system for **delis, bodegas and
convenience stores in NJ and NYC**. It's a sibling brand to AmericanDream11 (AD11) but a
**separate company**: separate accounts, repos, cloud resources and payment processor account.

**The merchants.** Small owner-operated stores. The average ticket is $13–18 and each store does
1,000–5,000 transactions a month, mostly debit. Owners often work the register themselves, and staff
turnover is high, so the register must be learnable in minutes.

**Three apps:**

| App | Who uses it | Device |
| --- | --- | --- |
| **Register** | cashier / owner at the counter | Dual-screen Android POS (iMin Swan 2 / SUNMI T2s class): 15.6" cashier screen + 10.1" customer-facing screen, built-in 80mm receipt printer, cash drawer on an RJ12 port, USB barcode scanner |
| **Merchant app** | the store owner, anywhere | iPhone / Android phone |
| **Admin back-office** | AD Pay staff (onboarding + support) | web browser |

**Card payments** go through a **separate PAX A35 card terminal** on the store's network. The
payment processor (**Finix**, not yet signed) drives it through its cloud API. The register never
touches card data. **EBT/SNAP is out of scope.**

**Dual pricing** is central. Every item has a **cash price** and a **card price** (card is typically
~3.5–4% higher). NJ/NY posted-pricing rules require the customer to **see both before paying**,
which is one reason the customer-facing screen exists.

**Support model.** At first, one person supports the first 200 stores. So the office must be able
to see, diagnose and fix any register remotely. That's build step 3, and it's not started.

**Multi-vertical.** v1 ships the **convenience-store ("cstore") pack**. Liquor, restaurant and
grocery are planned as later configuration "packs" on the same core, so nothing may be designed as
if c-stores are the only vertical.

**Brand.** Red / black / white. Green is used only for approved / success / money-received states.
**Never put red near a dollar amount.**

### What "done" means for v1 (spec acceptance criteria)
- Fresh device → setup QR → first cash sale with receipt and drawer kick in under 10 minutes, with no laptop.
- Pull the network cable, make 50 sales offline, plug back in: all 50 appear in admin exactly once, totals match to the cent.
- The customer screen shows cash and card price before tender on every sale.
- From admin, without touching the device: restart the app, push a price change, reprint a receipt, read the last 200 log lines.
- Swap the payment adapter from stub to Finix by changing one config value.
- The Z-report cash count matches the sum of cash events for the day.
- The `liquor` pack can be enabled and the app still boots.

**Status against these:** the offline/exactly-once criterion is proven in automated tests and by hand
in the browser (not yet on a device). The dual-price customer screen exists in the browser. The rest
depend on unbuilt steps.

---

## 2. Architecture as built

### Monorepo layout (pnpm workspaces, TypeScript everywhere, Node 20)

```
apps/admin/       Next.js 16 back-office (web)
apps/merchant/    Expo SDK 57 / React Native 0.86 — merchant app (runs in a browser today)
apps/register/    Expo SDK 57 / React Native 0.86 — register (runs in a browser today)
packages/api/     Node + Fastify 5 API, Postgres (node-postgres), Redis/BullMQ
packages/shared/  money, pricing, tax, event schemas, sale fold, receipts, types — used by all
infra/            AWS CDK stack (committed, NOT deployed; cost gated)
docs/             spec, ADRs (docs/decisions), design docs (docs/design), this file
scripts/          dev.mjs (one-command local stack), test-pg.mjs
docker-compose.yml  Postgres 16 + Redis 7 for local dev
```

`packages/shared` is consumed as TypeScript source by the API, Next.js and Metro alike. The money
rules and the sale "fold" are one implementation used by the register, the server and the reports.

### Tenancy
The hierarchy is **org → merchant → location → register**.
- **org**: an owning company. **merchant**: a business, which owns the catalog. **location**: a
  physical store, which owns the tax rate and dual-price %. **register**: one device.
- Every table below `orgs` carries all the tenancy ids above it, so any row can be scoped without a
  join. Every log line carries `org_id, merchant_id, location_id, register_id` (null until known)
  plus a `trace_id`.
- A caller's scope comes **only from its credential**, never from the URL or request body.
  Merchant-user routes contain no merchant id at all. When someone asks for another tenant's data,
  the API answers **404**, not 403, so it doesn't confirm the record exists.
- **Not built:** restricting a merchant user to specific locations. A merchant user sees all of
  their merchant's locations.

### Data model (Postgres 16)
Money columns are `BIGINT` cents. Rates are `INTEGER` parts per million (6.625% = `66250`).

| Table | Purpose / notes |
| --- | --- |
| `orgs`, `merchants`, `locations`, `registers` | Tenancy. `merchants.enabled_packs` (text[]) is pack config; `merchants.catalog_version` exists but nothing bumps it yet. `locations` has address, timezone, `tax_rate_ppm`, `dual_price_rate_ppm`. `registers.status` ∈ unpaired/active/retired, plus `last_seen_at`. |
| `users` | One table for humans. `kind=admin` is AD Pay staff: email + password (scrypt), no tenancy. `kind=merchant_user` belongs to exactly one merchant: phone login, role owner/manager/cashier. Cashier role exists but nothing uses it. |
| `otp_challenges` | Phone login codes, stored as hashes only; 5-min expiry, 5 attempts, 5 requests per 15 min per phone. |
| `register_setup_codes` | One-time pairing codes (hashed). 24h by default. Issuing a new one expires the old. |
| `device_tokens` | Long-lived register credentials (`dev_…`, stored hashed), revocable. Re-pairing revokes the old token. |
| `categories`, `items` | Catalog at merchant level. Category carries `taxable` and `min_age` (age check). An item has `cash_price_cents`, an optional explicit `card_price_cents` (null → derived from the location's %), `sell_unit` each/pack + `pack_qty` (case-break), and `attrs` jsonb for pack-specific data. |
| `sale_events` | **The ledger.** Append-only, **partitioned by month** of server receive time. Update, delete and truncate are blocked by triggers. Columns: event id, tenancy ids, `sale_id`, `device_seq`, `type`, `occurred_at` (device clock), `received_at` (server), `business_date` (server-assigned), `payload` jsonb, `trace_id`. |
| `sale_event_ids` | Global primary key on the device-generated event id: this is the idempotency guarantee. |
| `audit_log` | Append-only record of admin actions and login attempts. |

**Business date** is the store-local date of the device time. If the device clock is implausible
(ahead of the server, or more than 7 days behind), the server's receive time is used instead.

### The event-sourced sale flow (the core idea)
1. On the register, **every cashier action appends an immutable event** to a local SQLite database:
   `sale.opened`, `sale.line_added`, `sale.line_removed`, `sale.age_verified`, `sale.tender_added`,
   `sale.completed`, `sale.voided`, `drawer.opened`, `receipt.printed`. The schema also defines
   `sale.line_discounted`, `sale.refunded`, `sale.suspended` and `sale.resumed`, but no UI emits
   them yet.
2. Event ids are **UUIDs minted on the device**, and events carry a per-register sequence number.
3. **The cart on screen is not stored.** It's recomputed from the events by `foldSale()` in
   `packages/shared`. The server and reports use the same function, so the device and server can't
   disagree about a total. If a device-declared total ever differs from the server's fold, the
   ticket is flagged "mismatch" in admin and never silently corrected.
4. Cash tender records the tender and completion together, before the drawer opens, so a crash
   can't leave a paid-but-incomplete sale.
5. A **sync engine** pushes unsent events in batches of up to 500 to `POST /device/events`. The
   server stores each event id once; replays and retries come back as "duplicate". A lost network
   response is therefore harmless. Rejected events are marked and don't block the queue.
6. The **catalog** flows the other way as a versioned snapshot (`GET /device/catalog`), cached on
   the device, so the register boots and sells with no network. Server wins on catalog; device wins
   on sales.
7. **Corrections are new events.** Nothing ever edits a sale.

Event payloads are **strict schemas** (Zod): unknown fields are rejected. A card number, CVV or
track data therefore has nowhere to go. The only card facts the system can hold are brand, last
four, approval code and the processor's reference.

### Auth

| Who | How they sign in | Token |
| --- | --- | --- |
| AD Pay admin | email + password | 12-hour JWT (HS256) |
| Merchant user | phone number + 6-digit OTP | 12-hour JWT carrying org and merchant |
| Register | one-time setup code → long-lived device token | opaque token, hashed in DB, revocable |

There's no refresh token; after 12 hours the user signs in again. There are no cashier logins or
PINs on the register yet.

### Payments boundary
- All payment operations go through a `PaymentProvider` interface: `authorize`, `capture`, `refund`,
  `void`, `terminalCharge`, `terminalStatus`, all with integer-cent amounts.
- **Stub provider** (the only one in use): approves everything, deterministic, idempotent per key.
  The seed uses it to fake card sales.
- **Finix adapter**: a placeholder in `packages/api/payments/finix/` whose methods throw
  "not built until step 6".
- The switch is one env var, `PAYMENT_PROVIDER=stub|finix`.
- **No API endpoint exposes payments yet**, and the register's Card button is disabled.
- An ESLint rule plus a test forbid importing Finix, reaching the Finix adapter, or reading `FINIX_*`
  config anywhere outside that folder.

### Other API pieces
- **Background jobs:** Redis + BullMQ runs one job, which creates monthly ledger partitions ahead of time.
- **Logging:** structured JSON logs; no OpenTelemetry, Sentry or WebSockets yet.
- **Endpoints** (≈25): health; admin login; OTP request/verify; device pair; `/auth/me`; admin
  tenancy tree, create org/merchant/location/register, issue setup code, merchant catalog, sales
  summary, sales list, ticket timeline, audit log; merchant overview/catalog/sales list/summary/ticket;
  device identity/catalog/events. There are **no update or delete endpoints for anything.**

---

## 3. Binding constraints and why they exist

The four non-negotiable rules from `CLAUDE.md`, plus the ADRs.

1. **Money is integer cents; no floats anywhere** (ADR 0004).
   - **Why:** floating point can't represent $0.10, so reports drift and Z-reports stop reconciling.
   - **How:** rates are integer ppm, and rounding happens once, half-up, where a derived amount is
     computed (tax per rate group, card price).
   - **Enforced by:** a lint rule bans `parseFloat` in domain code. Display formatting happens only
     at the UI edge.
2. **Every sale is an immutable event** (ADR 0002). Totals are derived from events and never edited;
   corrections are new events.
   - **Why:** auditability, exactly-once offline sync, and reports that reconcile to the cent.
   - **Enforced by:** database triggers on both server and device.
3. **Card data never touches our stack.** The PAX terminal talks to the processor's cloud; we hold
   only a token, last four and the result.
   - **Why:** it keeps AD Pay out of PCI "cardholder data environment" scope, which would otherwise
     mean audits and costs a small company can't carry.
4. **Nothing outside `packages/api/payments/finix/` imports Finix** (ADR 0003).
   - **Why:** swapping the processor must be a config change. This matters doubly because of the
     migration debt below.

**Corollaries:**
- The register must work cash-only for **72 hours offline** with no server and no processor.
- Every row and log line carries the tenancy ids and `trace_id`.

**ADRs** (`docs/decisions/`):

| # | Decision |
| --- | --- |
| 0001 | **Postgres, not Mongo.** Ledger with monthly partitions; Redis/BullMQ is a job queue only, never the source of truth. |
| 0002 | **Offline-first immutable event log**, device-generated ids, idempotent sync. No CRDTs. |
| 0003 | **PaymentProvider interface**; Finix is the only adapter in v1; stub until step 6. |
| 0004 | **Integer cents** everywhere. |
| 0005 | **AWS CDK** for infrastructure. The dev stack is committed, **not deployed** (cost gated; founder must approve). |
| 0006 | **Finix sandbox belongs to AD11, which is migration debt.** v1 is built against a Finix sandbox registered to *AmericanDream11 LLC*, a different legal entity. **Before any real card is run**, AD Pay needs its own Finix account and underwriting. Every Finix id changes, merchants are re-onboarded, terminals re-provisioned, and **settlement re-pointed so money lands in AD Pay's bank**. It is a production release blocker. All sandbox data is disposable. |
| 0007 | **Everything runs locally, with no AWS and no cost:** Docker Postgres/Redis, one command (`npm run dev`). |
| 0008 | **Expo** as the React Native toolchain. The browser target is for development visibility only. |
| 0009 | **Register core.** expo-sqlite for the on-device log, the cart = fold of events, sync policy, receipt format (text lines + style hints, not printer bytes), customer display channel. |

**Other hard rules from the founder:**
- **Entity separation:** AD Pay commits use AD Pay's identity, never AD11's.
- **No secrets** ever committed. The repo is temporarily **public**, so its whole history is public
  forever.
- **Free tiers only.**

---

## 4. Screen by screen: what exists right now

General honesty note: the three UIs were built to make the foundation *visible and clickable*, not
as designed products.
- **Common to all three:** on-brand colors and consistent black headers; they work end to end
  against the real API.
- **Admin:** plain hand-written CSS; no design system, icons, illustrations or charts library (bar
  charts are plain boxes); no dark mode; little accessibility work.
- **Merchant app and register:** React Native, but only ever run **in a desktop browser**; never
  built for or tested on a phone or the POS device.
- **Tests:** no UI tests or end-to-end tests exist for any of them.

### 4.1 Admin back-office (Next.js, http://localhost:3001)
A black top bar with the red "AD" mark, nav links **Merchants · Sales · Audit log**, and **Sign out**.
Max width ~1280px; white panels on a light grey page. Readable, but spare and "developer-built".

| Screen | What it does | Functional vs. stub / weaknesses |
| --- | --- | --- |
| **Login** | Email + password. In dev builds it shows the demo credentials under the form. | Works. No "forgot password", no MFA, no rate limit on attempts (attempts are audited). The token lives in the browser tab's sessionStorage, so closing the tab signs you out. It must move to a secure cookie before any real deploy. |
| **Merchants** (home) | One long indented **tree**: org → merchant → location → register. Merchants show pack badges, item count, catalog version. Locations show city/state, tax %, card-price %. Registers show a status pill (active/unpaired), "last seen", and a **Setup code** button that shows the code large in a black box with its expiry. Inline "Add" forms at each level create orgs, merchants, locations and registers. | **Creating** works and is audited. **No editing, renaming, deleting or retiring** anything. No search or filtering; it will be unusable at a few dozen merchants. No QR code (the spec's setup QR is step 4). Creating a merchant auto-creates the six cstore categories, but there's **no way to add items**. Forms are crude inline inputs with minimal validation messages. |
| **Merchant detail** | Two tabs. **Sales**: Today / Last 7 days / Month-to-date; four stat tiles (net sales, tickets + average, tax, voids/refunds); a by-hour bar chart from plain boxes; by-tender and by-register tables; latest 50 tickets (clickable). **Catalog**: a read-only table of every item (category, name, UPC, cash price, card price with * for explicit card price, flags for non-taxable / age 21+ / pack size), priced at the first location. | Numbers are correct and reconcile. The page title just says "Merchant", not the merchant's name. **Catalog is read-only**: no create/edit, no price changes, no "push to devices", no version history (all spec'd for admin). No location switcher, no custom date range, no export. The chart has no axis values or tooltips beyond a hover title. |
| **Sales** | The latest 100 tickets across all merchants: time, location · register, status pill, tender, line count, total. Click a row to replay. | Works. No filters, search, paging or date range. |
| **Ticket replay** | A header (merchant, location, register, status, price mode, "mismatch" flag if device and server totals disagree). "Folded from events": lines with age-check badges, subtotal/tax/total. "Dual price at time of sale": both totals, tenders with approved badge and change. Then **the raw event log**: each event's device time, sequence, type, sync time, and its JSON payload. | Works and is genuinely useful for support. The raw JSON is developer-oriented. There are no actions: no reprint, refund or void from here. |
| **Audit log** | The latest 200 entries: time, who, action, target, trace id. | Works; read-only; no filters. |

**Admin screens in the spec that don't exist:** the **device page** (live heartbeat, event timeline,
log tail, config diff, remote-action buttons), "view as merchant", feature flags and staged rollout,
catalog editor with versioning and push, and user management (you can't create merchant users or
admins from the UI; the seed creates them).

### 4.2 Register (Expo / React Native, http://localhost:8082)
Designed for a landscape 15.6" screen; **not responsive**. The layout assumes roughly 1280px+ wide,
and narrow windows get cramped. It has only ever run in a desktop browser. The real target is
Android on the POS device, and **it has never been built as an Android app.**

| Screen | What it does | Functional vs. stub / weaknesses |
| --- | --- | --- |
| **Pairing** | A centered card: "Set up this register", an explanation, a large text box for the setup code (e.g. `JSQ3-DEMO`), and a red "Pair register" button. In dev it shows the demo code. | Works: exchanges the code for a device token and stores it. The spec's **QR scan by the owner's phone** isn't built (step 4); you type the code. |
| **Sale screen** (main) | **Black top bar**: merchant · location · register, a **sync pill** (green "Synced", amber "Syncing · N queued" or "Offline · N queued"), and a "Customer screen ↗" link. **Left column**: category list (Sandwiches, Drinks, Snacks, Tobacco 21+, Lottery 18+, Grocery, Household). **Middle**: a grid of fixed-size white tiles, each with the item name, the cash price in bold and "card $x.xx" underneath. **Right (340px)**: the ticket — lines with cash amount, card amount in grey, "21+ checked / no tax" notes and an × to remove; then subtotal, tax, two boxes (Cash total / Card total), a black **Cash** button, a greyed **Card** button ("terminal: step 6"), **Void ticket**, **Reprint last**. | **Works:** add items, remove lines, age check (a modal: "Check ID — 21+", buttons "Not verified" / "ID checked — 21+"), void an open ticket, cash tender, reprint last, and fully offline selling with queued sync. **Missing:** barcode scanning (the spec says scan / quick keys / search; only quick keys exist), **item search**, **quantity** (tapping an item twice adds two separate lines instead of "2 ×"), **line discounts** (the event type exists, no UI), **modifiers**, **suspend/resume**, **void of a completed sale**, **refunds**, **manager PIN**, **cashier sign-in**, open-drawer / no-sale, **end of day / Z-report**, **card tender**. Tiles are uniform; no colors, images or favorites, and the quick-key layout isn't configurable. Subtotal/tax lines show cash-mode values only. |
| **Cash tender modal** | Title "Cash — $20.39", a row of big black **quick-cash buttons** (Exact, next dollar, $25, $30, $40, $50, $100), then an "Other amount" keypad that fills from the cents column, then Back / "Take $x". | Works; change computed in integer cents. The keypad is basic. |
| **Sale complete modal** | "Sale complete", **Change due** in large green, total, "drawer opened", then **No receipt** / **Print receipt**. | Works. The drawer "kick" is a brief on-screen toast in the browser; no hardware. |
| **Receipt preview** | A paper-like panel showing the 80mm receipt in monospace: store header and address, time, register, ticket number, lines (N = not taxable, age-verified notes), subtotal/tax/total, cash + change, **both cash and card totals** (dual-pricing disclosure), footer. | The receipt *content* is real and correct (48 columns). **Printing is simulated**: this modal is the "printer". No logo, barcode or QR. |
| **Device panel** (tap the sync pill) | Register/location ids, sync online/offline, queued and rejected event counts, last sync time, last error, catalog version, packs. Buttons: **Sync now**, **Resync catalog**, **Forget pairing** (refused while events are still queued, so unsynced sales can't be stranded). | Works; plain list. This is a stand-in for the spec's hidden **admin PIN screen** (Wi-Fi, printer test, terminal pairing, exit kiosk, …), which isn't built. |
| **Customer screen** | In the browser, a **separate window** at `?display=customer`, fed live from the register. **Idle**: big "AD Pay" mark, store name, "Cash and card prices are both shown before you pay." **Cart**: a table of items with **Cash** and **Card** columns, and two big total boxes "Pay with cash" / "Pay with card" including tax. **Paid**: "Thank you!" in green, amount paid, change. | Works in the browser. On the real device this must become the second physical screen via the Android Presentation API, which needs a native module (not built). No promos or idle branding beyond the logo. No "tap on the card machine" state yet (needs card tender). |
| **Error / loading** | "Can't do that" modal with the message; "Opening the local register database…" spinner. | Functional, plain. |

### 4.3 Merchant app (Expo / React Native, http://localhost:8081)
A phone-style single column (max ~640px wide) in a browser. **Never run on an actual phone**, never
built for iOS or Android. Black header with the "AD Pay" mark and Sign out; the merchant name and
user name below; three text tabs with a red underline.

| Screen | What it does | Functional vs. stub / weaknesses |
| --- | --- | --- |
| **Sign in** | "Mobile number" field → "Text me a code" → a 6-digit code field → Sign in. In dev, **no SMS is sent**: the code is fixed (`123456`) and shown on screen. | Works against the real API. No SMS provider is wired (Twilio placeholders exist but are unused). No "resend code" countdown or error polish. |
| **Sales tab** | Segmented control Today / 7 days / Month. A big "Net sales" card (tickets, average ticket, tax), Card and Cash tiles, "By hour" bar chart (plain boxes, sparse x-labels), "By register" list, a voids/refunds card, and the note "Deposits & fees appear here once the processor account is live." | Numbers are real and correct. Bare visual design: no comparison to last week, no trends, no location filter (the API supports one; the UI doesn't expose it), no pull-to-refresh, no auto-refresh. |
| **Tickets tab** | The latest 50 tickets: time · location · register, item count, cash/card, total (voided shown in grey italics). | **Rows aren't tappable**: no ticket detail, even though the API has it. No live updates (the spec's "live sales feed" isn't built), no search or paging. |
| **Items tab** | Catalog grouped by category (with 21+/18+ and non-taxable notes); each item shows cash price and, smaller, card price. | **Read-only.** The spec's item and price editing, dual-price % per location, and "push to registers" aren't built. |

**Merchant features in the spec that don't exist:** alerts (register offline > 5 min, drawer opened
outside a sale, void/refund above threshold, end of day not closed), deposits & fees, item/price
edits, live feed, push notifications. The merchant app is **build step 5**; what exists is an early
shell.

---

## 5. Deliberately not built / stubbed / faked for local dev

| Area | State |
| --- | --- |
| **Card payments** | Stub provider approves everything. The Finix adapter throws. The register's Card button is disabled. No terminal pairing. The seed's card sales are simulated through the stub. **Build step 6**, after the PAX A35 arrives; also blocked on ADR 0006's entity migration before production. |
| **Hardware** | No native Android module yet. **Printer**: an on-screen receipt preview. **Cash drawer**: a toast. **Barcode scanner**: none. **Customer display**: a second browser window instead of the Presentation API. Kiosk / Device Owner / HOME launcher: not started (step 4). |
| **SMS / OTP** | No SMS provider. Dev mode uses a fixed code `123456` shown on screen; the API refuses that mode in production. There is no production SMS path yet. |
| **Demo data** | A seed creates two tenants: *Journal Square Deli & Grocery* (Jersey City NJ 6.625% tax + Astoria NY 8.875%, 4 registers + 1 unpaired) and *Bayonne Corner Mart* (separate org). It adds 78 c-store items at 2026-ish prices with synthetic barcodes, and 21 days of simulated sales (~6,000 tickets, ~$15.50 average, ~55% card). Fixed demo logins (section 7). |
| **Taxes** | Only one flag per category (taxable or not) and one rate per location. The spec says to mark tobacco non-taxable, but **NJ does charge sales tax on cigarettes**; needs an accountant's review. No per-item tax overrides, no multiple rates per location. |
| **Cloud** | Nothing deployed. The AWS CDK stack is committed but not deployed. The AWS account has CI's access pieces half set up (blocked by an org policy). A Sentry org exists but isn't wired. No Google Play or Apple developer accounts exist for AD Pay yet. |
| **Step 3 ops layer** | None of it: heartbeat, log ring buffer, remote actions, admin device page, WebSockets, OpenTelemetry, Sentry. |
| **Step 4** | None of it: cstore pack features beyond the basics already listed, end-of-day / Z-report, setup-QR flow, kiosk mode. |

---

## 6. Known gaps, weaknesses and technical debt

**Testing**
- **Register SQLite isn't tested on real SQLite.** The register's logic tests (11) use an in-memory
  stand-in. The real SQLite store, with its append-only triggers and sync bookkeeping, has only been
  exercised by hand in a browser (wa-sqlite), never under automated tests, and **never on Android**.
  This is the same kind of gap the API had before its tests moved to real Postgres.
- **No UI tests** of any kind: admin, merchant and register have zero component or end-to-end tests.
- Counts on the latest branch: shared 22, register 11, API 18 (database tests run on real
  Postgres 16 in CI).
- The React hooks lint plugin isn't installed, so hook-dependency mistakes aren't caught.

**Security (fine for local dev, must change before any deploy)**
- Admin token in sessionStorage → move to a secure httpOnly cookie.
- No rate limiting on admin login.
- No MFA for admins.
- The register device token lives in browser storage / AsyncStorage → move to Android keystore
  (step 4).
- Demo credentials are fixed and published; the database is throwaway.

**Functional debt**
- No update/delete endpoints anywhere; no catalog editing, so `catalog_version` never changes and
  snapshot versioning is untested in practice. Snapshot diffing for low-bandwidth stores (a spec
  "Open" item) isn't designed.
- Reports: only today / last 7 days / month-to-date, computed on the fly from events. Fast on demo
  volume (~90 ms for a month at one merchant); not tested at 200-store scale.
- One price mode per sale; split tender (part cash, part card) isn't supported and interacts badly
  with dual pricing.
- A register's event sequence number continues across re-pairing rather than restarting per register.
- Tapping an item twice creates two lines, not a quantity change.
- Voids only for an open ticket; no post-sale void or refund flow.
- No cashier identity on sales (`cashier_user_id` is always null).

**Platform risk**
- The RN apps have never been built for Android or iOS. The browser target differs from Android in
  storage, fonts, layout and the second screen, so expect surprises when they first run on a device.
- The register UI isn't responsive and assumes a large landscape screen.

**Process**
- Nothing is merged to `main` yet (PR #2 foundation, PR #3 register core stacked on it).
- The repo is public (for free branch protection); flip to private at ship.

---

## 7. How to run it locally, and demo credentials

**Requirements:** Windows/macOS/Linux with **Node 20** and **Docker Desktop** running. No cloud
accounts, no cost.

```bash
git clone https://github.com/adpay41/adpay-pos
cd adpay-pos
npm run dev
```

This creates a local `.env`, installs dependencies, starts Postgres 16 + Redis in Docker, migrates,
seeds the demo data, and runs:

| App | URL | Sign in with |
| --- | --- | --- |
| Admin back-office | http://localhost:3001 | `admin@adpay.local` / `adpay-demo` (AD Pay platform admin, sees all tenants) |
| Merchant app | http://localhost:8081 | phone `2015550100`, code `123456` |
| Register | http://localhost:8082 | setup code `JSQ3-DEMO` |
| API health | http://localhost:3000/health | — |

- **Other merchant phones:** `2015550101` (manager, same store), `2015550142` (owner of the separate
  Bayonne tenant).
- **Other register codes:** `JSQ1-DEMO`, `JSQ2-DEMO` (Jersey City registers 1–2), `AST1-DEMO`
  (Astoria), `BAY1-DEMO` (Bayonne).
- Each code works once. Every `npm run dev`, or `npm run logins`, re-arms them. For the customer
  screen, click "Customer screen ↗" on the register.

**Other commands:**
- `npm run dev:reset`: wipe the database and reseed.
- `npm run test:pg`: the full test suite with database tests on the Docker Postgres, as CI runs it.

These values are local-only; the API won't start in production with dev-mode login codes.

---

## 8. Build sequencing (from the spec) and where we are

The spec requires building in this order and not starting a step before the previous one works end
to end.

| Step | Scope | Status |
| --- | --- | --- |
| **1** | Monorepo; shared money/pricing/event schemas; Postgres schema; tenancy; auth | **Done**, in PR #2. Plus early UI shells of all three apps, so progress can be seen. |
| **2** | Register core on the T2s: catalog → cart → cash tender → receipt → drawer → SQLite events → sync; customer display | **About half done**, in PR #3. The whole software flow works in a browser: cart from events, cash tender, receipt content, offline queue and exactly-once sync, customer display in a second window. **Remaining:** the native Android build and a Kotlin/Expo module for the 80mm printer, drawer kick, HID scanner and Presentation-API customer display, plus testing on the real device. That needs Android Studio and the POS hardware. |
| **3** | Ops layer: 30-second heartbeat, 10k-line log ring buffer, remote actions (restart, force sync, reprint, re-pair terminal, printer test, push config, roll back build), admin device page, Sentry | Not started. Deliberately **before** features, because support is one person. |
| **4** | cstore pack (quick-key grid categories, age prompt, lottery/tobacco flags, case-break pricing), end of day / Z-report, setup-QR flow, kiosk / Device Owner | Not started. Small pieces already exist: categories, manual age check, case-break fields. |
| **5** | Merchant app: phone login, sales dashboards, live feed, deposits & fees, item/price edits pushed to registers, alerts | An early shell exists (login, dashboards, read-only tickets and items); most is unbuilt. |
| **6** | Terminal adapter (Finix + PAX A35) | Not started by design; stub until the terminal arrives. Production needs ADR 0006's account migration first. |

**Open decisions the spec leaves to the builders:**
- **Decided:** SQLite library (expo-sqlite, ADR 0009); receipt format (ADR 0009).
- **Still open:** Esper vs. building our own over-the-air updates; log/trace backend (Grafana vs.
  Datadog); feature-flag store; WebSocket library; quick-key layout editor scope; catalog snapshot
  diffing.

**Implication for UI/UX planning.** The spec's order puts the ops layer (step 3) before more features.
A UI/UX improvement plan that jumps ahead, for example a merchant-app redesign before the register
runs on hardware, is a legitimate choice, but it's a choice to deviate from the spec's sequencing,
and it should be made explicitly.
