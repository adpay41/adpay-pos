# 0001 — Postgres, not Mongo, for the backend database

- Status: Accepted (fixed by the v1 spec)
- Date: 2026-09-23
- Source: `docs/spec-v1-cstore.md` → Decisions → "Backend DB"

## Context

The backend stores a payments ledger for many merchants: sale events, tenders, voids, refunds,
settlements and fees. Reports have to reconcile to the cent — a Z-report cash count must equal the
sum of cash events for the day, and 50 sales taken offline must appear in admin exactly once with
totals that match. Data is highly relational (`org → merchant → location → register → sale_event →
line → tender`) and the write path needs real transactions and unique constraints to make
idempotent ingest safe.

## Decision

**Postgres.** Ledger data is relational and transactional.

- `sale_events` is **partitioned by month**.
- **Redis + BullMQ** for background jobs (settlement import, alert evaluation, snapshot builds).
- **WebSockets** for live pushes (live sales feed, remote action delivery and acks).

## Consequences

- Idempotent event ingest is a unique index on the device-generated UUID plus a transaction —
  not application-level dedupe.
- Monthly partitions keep the hot ledger small and make retention/archival a partition detach.
  A partition-creation job must run ahead of the month boundary.
- Every table carries the tenancy ids (`org_id`, `merchant_id`, `location_id`, `register_id`) and
  multi-tenant guards are enforced at the query layer on every route.
- Money columns are `BIGINT` cents — never `float`, never `numeric` with implicit rounding
  (see ADR 0004).
- Redis is an additional operational component; it is a job queue and cache only. It is never the
  source of truth for a sale.

## Rejected

- **MongoDB** — no cross-document transactions in the shape we need, weaker constraints for
  idempotency, and reconciliation queries become application code. A payments ledger is the
  canonical relational workload.
- **SQLite on the server** — fine on the device (ADR 0002), not for multi-tenant concurrent writes.
