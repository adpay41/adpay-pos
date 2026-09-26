# 0037: Staged feature rollouts with a kill switch; documents vault

- Status: Accepted
- Date: 2026-09-26
- Build plan: P24b. Bible 3.2 (staged rollouts: canary → 10% → all; kill switch) and 2.8 (documents
  vault with expiry reminders)
- Extends: ADR 0021 (feature flags), ADR 0012 (alerts), ADR 0010 (media in Postgres)

## Decisions

### 1. A flag has a platform-wide stage over the per-store switches
`flag_rollouts` is append-only; a flag's current stage is its latest row. The stages are:
`default` (the code default, no rollout), `canary` (the listed stores), `ten_percent` (canary + 10%),
`all`, and `killed`.

`resolveFlags(overrides, rollouts, merchantId)` (shared, pure, tested) applies them in this order:
1. the **kill switch** beats everything, including a store's own switch;
2. then a store's own switch (support set it for that store, ADR 0021);
3. then the stage;
4. then the code default.

The 10% is a **fixed bucket per store and flag** (FNV-1a of `flag:merchant_id`, 0–99). Because the
bucket is fixed, the stages only ever add stores: moving canary → 10% → all never turns a store off
along the way. Because it is per flag, the same stores are not always first.

Every change needs a reason, is audited (`flag.killed` / `flag.rollout_set`), and bumps every
merchant's catalog version. The existing trigger then nudges every register over `/ws`, so a kill
switch reaches the field in seconds, and the apps pick it up on their next load.

**Not here:** rolling out register *builds* (OTA). That waits on the MDM decision (Esper vs own OTA).
When it lands, it reuses these stages and the same bucket.

### 2. Documents are immutable files with an expiry date
- `documents` holds the file (PDF, JPEG or PNG, recognised by its bytes; 5 MB), its kind, title,
  optional store, expiry date and uploader. It is immutable (`forbid_mutation`).
- A **renewal** is a new upload with `replaces`. In the same transaction it archives the old document
  (`document_archives`, append-only, reason `replaced`). "Remove" archives with reason `removed`.
  Nothing is deleted.
- Bytes live in Postgres like product photos, behind `DocumentStore`, so S3 replaces it with the AWS
  deploy without touching routes.
- Access:
  - the merchant app uses the new `documents.manage` permission (owner and manager by default);
  - support reads the documents read-only on the merchant page, and opening a file is audited
    (`document.viewed`).

### 3. The reminder is an alert
The rule `document_expiring` opens 30 days before a current document expires, and again on expiry
(the dedupe key carries `soon` / `expired`). It resolves when the document is renewed or removed. It
reaches the merchant's Alerts tab and the admin console, and has a runbook entry like every rule.

## Deferred
- Delivering the reminder by push/SMS/email is the `Notifier` boundary (P-3P), as for every alert.
- OTA build rollout (above).
