# AD Pay POS — CLAUDE.md

American Dream Pay POS is a multi-vertical retail POS: a dual-screen Android register, a merchant
mobile app, and a back-office admin, sharing one Node/TypeScript API. v1 ships the convenience-store
pack for delis, bodegas and c-stores in NJ/NYC; liquor, restaurant and grocery are later config packs
on the same core.

**The spec is [`docs/spec-v1-cstore.md`](docs/spec-v1-cstore.md). Read it before writing code.**
Anything marked **Decision** there is fixed — ask before deviating. Anything marked **Open** is
yours to decide and document in `docs/decisions/`.

## Rules (non-negotiable)

1. **Money in integer cents.** No floats anywhere — not in the DB, not on the wire, not in the UI
   layer. Totals are derived from events, never edited.
2. **Every sale is an immutable event.** Device-generated UUID, append-only log. Nothing rewrites
   or deletes a sale event; corrections are new events.
3. **Card data never touches our stack.** The PAX A35 terminal talks to the processor's cloud API;
   the register never sees a PAN, track data, or CVV. We are out of CDE scope and stay there.
4. **Nothing outside `packages/api/payments/finix/` imports Finix.** Everything else depends on the
   `PaymentProvider` interface only. Swapping stub → Finix is one config value, no other file changes.

Corollaries that follow from the spec and are equally binding:

- Every row and every log line carries `org / merchant / location / register` ids plus `trace_id`.
- The register must fully work cash-only, 72h offline, with no server and no processor.
- Never design as if convenience store is the only vertical.
- Brand: red / black / white; green only for approved/success/money states. **Never red near a
  dollar amount.**

## Decisions (fixed — verbatim from the spec)

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

## Build sequencing (build in this order)

1. Monorepo, shared money/pricing/event schemas, Postgres schema, tenancy, auth.
2. Register core on the T2s: catalog → cart → cash tender → receipt → drawer → SQLite events → sync.
   Customer display.
3. Ops layer: heartbeat, logs ring buffer, remote actions, admin device page. (Before features —
   this is what makes the rest supportable.)
4. `cstore` pack, EOD/Z-report, setup QR flow, kiosk/Device Owner.
5. Merchant app.
6. Terminal adapter (Finix) — last, when the A35 arrives. Keep the stub until then.

Do not start a step before the one above it is working end to end. Step 3 comes before features on
purpose: support is one person for the first 200 stores.

## Architecture decision records

| ADR | Decision |
| --- | --- |
| [0001](docs/decisions/0001-postgres.md) | Postgres, not Mongo |
| [0002](docs/decisions/0002-offline-first-events.md) | Offline-first immutable event log |
| [0003](docs/decisions/0003-payments-interface.md) | PaymentProvider interface, Finix behind it |
| [0004](docs/decisions/0004-money-integer-cents.md) | Money as integer cents |
| [0005](docs/decisions/0005-iac-aws-cdk.md) | AWS CDK (TypeScript) for infrastructure |
| [0006](docs/decisions/0006-finix-sandbox-entity-migration.md) | **Finix sandbox is AD11's — migration debt before production** |
| [0007](docs/decisions/0007-local-first-development.md) | Whole stack runs locally — Docker Postgres/Redis, `pnpm dev`, no AWS, no cost |
| [0008](docs/decisions/0008-expo-for-react-native-apps.md) | Expo (SDK 57) for the RN apps; web target for development |
| [0009](docs/decisions/0009-register-core.md) | Register core: expo-sqlite event log, cart = fold of events, sync, text receipts, display channel |
| [0010](docs/decisions/0010-catalog-media-and-quick-keys.md) | Product photos in Postgres behind `MediaStore`; favorites + order + fixed-palette tile colors |

Design docs per build step live in `docs/design/` (step 1: [`step-1-foundation.md`](docs/design/step-1-foundation.md)).

## Repo layout

```
apps/register/   RN Android — register (kiosk, dual-screen)
apps/merchant/   RN iOS+Android — merchant app
apps/admin/      Next.js — back-office
packages/api/    Node + TS — API
packages/shared/ types, money, pricing, event schemas, receipt templates
infra/           AWS CDK (TypeScript) — dev stack, NOT deployed yet
docs/            spec-v1-cstore.md, finix-links.md, decisions/
```

## Secrets

Never commit a secret. `.env.example` lists every variable the spec implies, with empty values.
Real values live in AWS Secrets Manager (`adpay/dev/*`) and GitHub Actions secrets. If you need a
value you do not have, stop and ask — do not invent one and do not paste one into a file.

## Environment

Node 20 LTS (`.nvmrc`), pnpm workspaces. `pnpm dev` brings up the whole stack locally (ADR 0007).
CI runs install → lint → test on every PR to `main`; `main` is protected and takes changes by PR only.
`lint` is ESLint (including the Finix import boundary and the no-`parseFloat` rule for domain code);
run `pnpm typecheck` too before pushing.
