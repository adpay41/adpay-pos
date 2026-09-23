# American Dream Pay POS — v1 (Convenience Store) — Dispatch Spec

## What this is

Foundation build for a multi-vertical retail POS. **v1 ships the convenience-store pack** on a
dual-screen Android register, with a merchant mobile app and a back-office admin. Liquor,
restaurant and grocery packs come later as configuration on the same core — do not design
anything that assumes "convenience store" is the only vertical.

Read this whole file, then produce the design doc (architecture + diagrams + data model + API
surface), then the task breakdown, then build. Ask before deviating from a **Decision**.
Anything marked **Open** is yours to decide and document.

## Context

- Company: American Dream Pay LLC (NJ). Sibling brand to AD11; red / black / white, green only
  for approved/success/money states. Never red near a dollar amount.
- Merchants: delis, bodegas, convenience stores in NJ/NYC. $13–18 average ticket, 1–5k
  transactions/store/month, debit-heavy. Owners run the register themselves; staff turnover is high.
- Hardware: dual-screen Android POS (iMin Swan 2 / SUNMI T2s class — 15.6" merchant + 10.1"
  customer screen, built-in 80mm printer, RJ12 drawer port, USB scanner). Card terminal is a
  **separate PAX A35** on the store LAN, driven by the processor's cloud terminal API. The register
  never touches card data. EBT/SNAP is out of scope.
- Processor: Finix (PayFac-as-a-Service) — **not signed yet**. Build the payment layer behind an
  interface with a Finix adapter; the register must fully work cash-only without it.
- Pricing model merchants use: **dual pricing** — every item has a cash price and a card price;
  the customer screen must show both before payment (NJ/NY posted-pricing rules).
- Ops requirement: office must be able to see, diagnose and fix any register remotely.
  Support is one person for the first 200 stores. Design for that.

## Decisions (fixed)

- **Monorepo**: `apps/register` (RN Android), `apps/merchant` (RN iOS+Android), `apps/admin`
  (Next.js), `packages/api` (Node + TypeScript), `packages/shared` (types, money, pricing rules,
  receipt templates, event schemas).
- **Register**: React Native, Android only, runs as Device Owner in lock-task (kiosk) mode and
  as the HOME launcher. A small Kotlin module wraps: printer, drawer kick, scanner (HID), and the
  **customer display via Android Presentation API** (RN has no second-screen support).
- **Offline-first**: SQLite on device is the source of truth for the register. Every sale is an
  immutable event with a device-generated UUID. Register must run 72h offline on cash and sync cleanly.
- **Sync**: append-only event log pushed device → server with idempotency keys; catalog/config
  pulled as versioned snapshots server → device. No CRDTs. Server wins on catalog; device wins on sales.
- **Backend DB**: **Postgres** (not Mongo). Ledger data is relational and transactional.
  `sale_events` partitioned by month. Redis + BullMQ for jobs. WebSockets for live pushes.
- **Money**: integer cents everywhere. No floats. Totals are derived from events, never edited.
- **Tenancy**: `org → merchant → location → register`. Every row and every log line carries these ids.
- **Payments**: `PaymentProvider` interface (`authorize`, `capture`, `refund`, `void`,
  `terminalCharge`, `terminalStatus`). Finix implementation is the only one in v1; nothing outside
  `packages/api/payments/finix/` may import Finix.
- **Vertical packs**: features are modules enabled per merchant by config, all in one APK.
  v1 enables the `cstore` pack; `liquor`, `restaurant`, `grocery` are empty stubs with the interface defined.
- **Fleet**: Device Owner provisioning via ADB (`dpm set-device-owner`) in v1; Esper integration
  is **Open** (evaluate vs. building OTA ourselves — recommend, don't build both).

## Scope — v1

### Register (`apps/register`)
- Kiosk shell: boots to our app, no Android UI, hidden admin PIN screen (Wi-Fi/Ethernet, printer
  test, terminal pairing, resync, exit kiosk, device info).
- Setup: first boot shows a QR; owner scans with phone → device gets `merchant/location/register`
  identity, catalog snapshot, config. Under 10 minutes, no laptop.
- Sale: scan / quick keys / search → cart with qty, modifiers (light), line discount, tax by
  category. Cash tender with change; card tender via terminal adapter (stub returns approved in dev).
  Void/refund behind PIN. Suspend/resume a ticket.
- **Customer screen** (second display): idle state (brand, later promos), live cart, **cash price
  and card price side by side**, "tap on the card machine" prompt, approved/declined, thank-you.
- Receipts: print (80mm), no-receipt option, reprint last. Drawer kicks on cash and on open-drawer with PIN.
- `cstore` pack: quick-key grid (categories: sandwiches, drinks, snacks, tobacco, lottery, grocery),
  age-verification prompt on restricted categories (manual confirm in v1; ID scan later),
  lottery/tobacco as non-taxable flag, case-break pricing (item sold as unit or pack).
- End of day: cash count, Z-report (by tender, by category, voids/refunds), print + push to server.
- Ops on device: heartbeat every 30s (app version, power, network, printer, terminal reachability,
  last sync, queued events, free disk); ring buffer of last 10k log lines uploadable on request;
  remote actions listener (restart app, force sync, reprint, re-pair terminal, printer test,
  push config, roll back build). Sentry with UI breadcrumbs.

### Merchant app (`apps/merchant`)
- Login (phone + OTP). Today / week / month sales by hour, by register, by tender.
- Live sales feed. Deposits & fees (from processor when available; placeholder section in v1).
- Item and price edits → pushed to registers. Dual-price % per location.
- Alerts: register offline > 5 min, drawer opened outside a sale, void/refund above threshold, EOD not closed.

### Admin (`apps/admin`)
- Merchant onboarding (create org/merchant/location/register, generate setup QR).
- Catalog + config editor with versioning and "push to devices."
- **Device page**: live heartbeat, event timeline, log tail, config diff, remote action buttons
  (each audited), "view as merchant."
- Sale timeline viewer: replay any ticket (item added → tender → terminal request/response → print → sync).
- Feature flags + staged rollout by merchant group; kill switch per flag.
- Audit log of every admin action.

### API (`packages/api`)
- Auth (device tokens, merchant users, admin users). Multi-tenant guards on every route.
- Catalog/config snapshots with versions. Event ingest (idempotent, batch). Reporting queries.
- Heartbeat ingest + alert rules. Remote action queue (WebSocket push, ack, result).
- `PaymentProvider` + Finix adapter (cloud terminal API + tokenization). Settlement/fee import job (stub until live).
- Structured JSON logs with tenancy + `trace_id` on every line; OpenTelemetry traces. Sentry.

## Non-goals (v1)
Inventory counts/reordering, vendor invoices, loyalty, customer-screen ads, scale/PLU,
kitchen tickets, tables/tips, multi-location roll-ups beyond basic filters, EBT, gift cards,
online ordering, Apple/Google Pay on the register (that's the terminal's job).

## Acceptance (what "done" means)
- Fresh device → setup QR → first cash sale with receipt and drawer kick in under 10 minutes, no laptop.
- Pull the Ethernet cable: 50 sales offline, receipts print, plug back in, all 50 appear in admin once, totals match to the cent.
- Customer screen shows cash and card price before tender on every sale.
- From admin: restart the app, push a price change, reprint a receipt, and read the last 200 log lines of a register — without touching the device.
- Swap the payment adapter from stub to Finix by changing one config value; no other file changes.
- Z-report cash count matches the sum of cash events for the day.
- `liquor` pack can be enabled in config and the app still boots (stub, no features).

## Sequencing (build in this order)
1. Monorepo, shared money/pricing/event schemas, Postgres schema, tenancy, auth.
2. Register core on the T2s: catalog → cart → cash tender → receipt → drawer → SQLite events → sync. Customer display.
3. Ops layer: heartbeat, logs ring buffer, remote actions, admin device page. (Before features — this is what makes the rest supportable.)
4. `cstore` pack, EOD/Z-report, setup QR flow, kiosk/Device Owner.
5. Merchant app.
6. Terminal adapter (Finix) — last, when the A35 arrives. Keep the stub until then.

## Open (decide and document in the design doc)
- SQLite lib (op-sqlite vs WatermelonDB). WebSocket lib. Feature-flag store (own table vs. a service).
- Esper vs. own OTA. Log/trace backend (Grafana stack vs. Datadog).
- Receipt template format. Quick-key layout editor scope.
- How catalog snapshots are diffed for low-bandwidth stores.
