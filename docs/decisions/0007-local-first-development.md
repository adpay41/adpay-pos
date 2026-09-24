# 0007 — The whole stack runs locally, with no AWS and no cost

- Status: Accepted
- Date: 2026-09-23
- Constrains: [ADR 0005](0005-iac-aws-cdk.md) (the CDK stack stays committed, not deployed)

## Context

The founder needs to open and check the admin back-office, the merchant app and the register
himself as each is built, and has set a hard rule: **everything runs on a laptop, with no AWS and no
cost.** The CDK dev stack (RDS, ElastiCache, Fargate, ALB) bills from the moment it exists and stays
undeployed (ADR 0005).

## Decision

- **`docker compose`** runs Postgres 16 and Redis 7, bound to `127.0.0.1` on ports **5433** and
  **6380** (off the defaults so they never clash with another local database). Postgres uses `trust`
  auth, which means no password anywhere in the repo.
- **`pnpm dev`** (a dependency-free Node script, `scripts/dev.mjs`) goes from a clean clone to the
  running stack in one command: it creates `.env` with local values and a freshly generated JWT
  secret, installs, starts the containers and waits for them to be healthy, migrates, seeds, and
  starts the API (:3000), admin (:3001), merchant app (:8081) and register (:8082).
- **Payments use the stub provider** (`PAYMENT_PROVIDER=stub`). Nothing calls Finix.
- **OTP codes are shown on screen and in the API log** (`OTP_DELIVERY=log`) instead of being sent by SMS.
  The API refuses to start with that setting in production.
- **The React Native apps run in the browser** through Expo's web target, so they can be clicked
  through with no emulator and no device. The native Android build (Kotlin printer, drawer and
  customer display module) needs Android Studio from step 2 onwards.
- **Tests need no services**: the API suite runs the real migrations on PGlite (Postgres compiled to
  WASM, in process), so CI exercises partitions, triggers and constraints without a database container.

## Consequences

- The only machine requirements are Node 20 and Docker Desktop.
- `.env` is gitignored and generated; `.env.example` stays empty of values, as it always has.
- The seed creates a local admin with a published demo password. That is safe only because the
  database is local and throwaway; the seed refuses to run with `NODE_ENV=production`.
- Web builds of the RN apps are a development convenience, not a shipping target. Anything
  that behaves differently on Android (storage, fonts, the second display) is verified on the device.

## Rejected

- **Deploying the CDK dev stack for demos**: costs money and needs the founder's go (ADR 0005).
- **Postgres installed natively on Windows**: harder to reset and to reproduce. Compose gives everyone
  the same version with one command. (`pnpm dev --no-docker` still works if someone has their own.)
