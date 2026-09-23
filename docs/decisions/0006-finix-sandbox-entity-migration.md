# 0006 — Build v1 on the AmericanDream11 Finix sandbox, migrate before production

- Status: Accepted — **carries migration debt that must be paid before go-live**
- Date: 2026-09-23
- Supersedes nothing. Constrains: [ADR 0003](0003-payments-interface.md)

## Context

American Dream Pay LLC (NJ) is a separate legal entity from AmericanDream11 LLC, and the project
rule is that AD Pay's accounts, repositories and cloud resources stay separate from AD11's.

The only Finix sandbox available at bootstrap is registered to **AmericanDream11 LLC**
(`team@americandream11.us`). It is a **Software Platform** dashboard — Application resource,
Merchant Identities, Onboarding Forms, Merchant Payouts — which is the right shape for AD Pay,
which onboards its own merchants. Its Application ID is `AP8CpWQcq7CiSMyRDCVuuqE6`.

Waiting for an AD Pay LLC sandbox would block the payment layer, and the payment layer is already
last in the build order (sequencing step 6) behind hardware that has not arrived. Meanwhile the
register is cash-only and fully functional without any processor at all (ADR 0002, ADR 0003).

## Decision

**Build v1 against the AD11 sandbox. Migrate to an American Dream Pay LLC Finix account before
production.** The founder made this call knowingly on 2026-09-23.

In practice:

- Dev config points at the AD11 sandbox: Application, Merchant and Merchant Identity IDs live in
  the AWS parameter `/adpay/dev/finix`, tagged with the owning entity.
- **API keys are created by the founder, by hand, and never by automation.** The parameter ships
  with `api_key` and `api_secret` empty.
- No AD11 identifier appears anywhere in this repository. `.env.example` stays empty.

## What this costs us, and what must change before production

This is **debt, not a design**. Everything below has to happen before a single real card is run:

1. **A Finix account under American Dream Pay LLC**, underwritten against AD Pay's EIN, bank
   account and ownership. Underwriting is tied to the legal entity; AD11's approval does not
   transfer.
2. **New Application, Merchant and Identity IDs.** They are account-scoped and will all change.
   Anything that persisted an AD11 id — sale events, terminal records, merchant onboarding rows —
   must be treated as sandbox-only and never migrated into production.
3. **New API keys and new webhook endpoints**, registered separately per environment.
4. **Re-onboarding of every merchant.** Merchant Identities created under AD11 do not move.
5. **Terminals re-provisioned.** A PAX A35 activated against the AD11 account has to be
   re-registered against AD Pay's.
6. **Settlement and fee reporting re-pointed**, so money lands in AD Pay's bank account. This is
   the one that matters most and the one most likely to be forgotten.

## Consequences

- Treat **all** data produced against the AD11 sandbox as disposable. Do not build anything that
  assumes an id survives the migration.
- The `PaymentProvider` boundary (ADR 0003) is what makes this survivable: the entity switch is a
  config change plus re-onboarding, not a code change. Keep the boundary clean — this ADR is the
  reason it exists.
- The migration is a **release blocker for production**, not a backlog item. It should appear in
  the go-live checklist with an owner.
- Anyone reading `/adpay/dev/finix` will see `"entity": "AmericanDream11 LLC (TEMPORARY - migrate
  before live)"`. That string is deliberate. Do not remove it until the account actually changes.

## Rejected

- **Wait for an AD Pay LLC sandbox before building.** Cleanest, but it blocks nothing useful today
  — the adapter is step 6 — and it would leave the payment layer untested when the A35 arrives.
- **Run production on the AD11 account.** Not an option: settlement would pay the wrong entity, and
  the underwriting would be false.
