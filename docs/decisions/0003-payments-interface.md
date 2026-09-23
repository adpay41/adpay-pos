# 0003 — PaymentProvider interface; Finix lives behind it

- Status: Accepted (fixed by the v1 spec)
- Date: 2026-09-23
- Source: `docs/spec-v1-cstore.md` → Decisions → "Payments"; Context → "Processor"

## Context

Finix is the intended PayFac-as-a-Service processor but is **not signed yet**, and the PAX A35
terminals have not arrived. The register must ship and take cash without any processor at all. If
the processor changes — or a second one is added for a later vertical — that must not ripple
through the codebase.

## Decision

All payment operations go through a **`PaymentProvider` interface**:

```ts
authorize · capture · refund · void · terminalCharge · terminalStatus
```

The **Finix implementation is the only one in v1**, and **nothing outside
`packages/api/payments/finix/` may import Finix** — not the API routes, not the register, not the
admin, not `packages/shared`. A **stub provider returns approved in dev** until the A35 arrives.
Selecting the provider is a single config value (`PAYMENT_PROVIDER=stub|finix`).

## Consequences

- Acceptance criterion: swapping the adapter from stub to Finix changes **one config value and no
  other file**. A PR that touches a second file to make Finix work has broken this ADR.
- Finix types, SDK objects and error shapes are translated at the adapter boundary into our own
  domain types. Finix vocabulary does not leak into `packages/shared` or the DB schema.
- A lint rule (import boundary) enforces the restriction in CI rather than relying on review.
- **Card data never touches our stack**: `terminalCharge` drives the A35 through the processor's
  cloud terminal API and we store only a token, last four, brand, and the approval result. We stay
  out of CDE scope.
- The terminal adapter is built **last** (sequencing step 6). Until then, the stub is the provider
  in every environment including the pilot registers, which are cash-only.
- Settlement and fee import is a job behind the same boundary, stubbed until the account is live.

## Rejected

- **Calling Finix directly from routes** — fast now, expensive at the first processor change, and
  it would put processor concerns inside code that handles tenancy.
- **Building two providers up front** — v1 has one. The interface is the insurance; a second
  implementation before there is a second processor is speculative work.
