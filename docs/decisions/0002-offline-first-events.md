# 0002 — Offline-first register with an immutable event log

- Status: Accepted (fixed by the v1 spec)
- Date: 2026-09-23
- Source: `docs/spec-v1-cstore.md` → Decisions → "Offline-first", "Sync"

## Context

Bodegas and delis have unreliable connectivity, and the register is the store's only way to take
money. It cannot stop selling because the internet is down, and the owner cannot be asked to
reconcile anything by hand afterwards. Acceptance is explicit: pull the Ethernet cable, take 50
sales offline, plug back in, and all 50 appear in admin **once**, with totals matching to the cent.

## Decision

**SQLite on the device is the source of truth for the register.** Every sale is an **immutable
event** with a **device-generated UUID**. The register must run **72 hours offline** on cash and
then sync cleanly.

Sync is asymmetric and deliberately simple:

- **Device → server**: append-only event log, pushed in batches with **idempotency keys**.
- **Server → device**: catalog and config pulled as **versioned snapshots**.
- **No CRDTs.** Conflict resolution is by direction: **server wins on catalog, device wins on sales.**

## Consequences

- Sale ids are minted on the device, before any network call. The server never assigns a sale id.
- Ingest is idempotent by construction: replaying a batch is a no-op. Retry aggressively.
- Nothing mutates a sale event. A void or a refund is a **new event** referencing the original.
  Totals are always derived by folding events — never stored and edited (see ADR 0004).
- A price change pushed while a device is offline applies from the snapshot version the device had
  at the time of sale. The sale's own prices are captured in the event, so reprints and replays are
  historically accurate.
- The device keeps a queue depth and last-sync timestamp in its 30s heartbeat, so the office can see
  a register falling behind before the merchant notices.
- Clock skew is a known hazard: events carry both device time and server receive time, and reports
  key on server-assigned business date where the two disagree.

## Rejected

- **Server-authoritative sales with offline caching** — a dropped connection would block tender.
- **CRDTs** — unnecessary complexity for an append-only log with one writer per register.
