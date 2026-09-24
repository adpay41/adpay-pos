# 0016: Receipt v2: per-location settings, image lines, tax by rate, after-sale choice

- Status: Accepted
- Date: 2026-09-24
- Build plan: P8 (foundation F6). Bible: L20 (logo, itemized tax, return policy, QR), L1 (zero-tap part)
- Extends: ADR 0009 §4 (receipts are structured text lines rendered from events)

## Decisions

### 1. Settings per location, in the snapshot
`locations.receipt_settings` (validated by the shared `ReceiptSettingsInput`, `{}` = defaults) holds:
- extra header lines (up to 4);
- a logo (a media upload);
- a return policy, and a footer;
- an optional **QR link**;
- **after-sale behavior**.

The settings travel in the register's config snapshot with the logo resolved, so receipts print
the same offline. Older cached snapshots lack them and print the defaults. They are edited in
admin (with logo upload) and in the merchant app, and both show a **live preview printed by the
same shared renderer** from a sample sale.

### 2. Receipt lines gain two image kinds
`ReceiptLine` is now `{text, style}` | `{text, style:'logo', url}` | `{text, style:'qr', data}`.
- The Kotlin printer module will render the logo as a bitmap and the QR with ESC/POS's native QR
  command.
- The browser preview shows the logo image and a QR placeholder with the link.
- Every line keeps `text`, so text previews, logs and receipt tests keep working.

### 3. Tax itemized by rate
`taxByRate` returns the same per-rate-group tax that `computeTax` has always rounded once per
group. The receipt prints one line per rate ("Tax 6.625% on $10.98 … $0.73"), and the lines add up
to the total tax exactly.

### 4. QR: a store link now, a digital receipt later
The QR carries a URL the store chooses: a review page, Instagram, a website. A QR to a hosted copy
of the receipt needs public hosting (Bible N, build plan P18 ⛔ deploy). The slot and the printer
path are the same, so that becomes a settings option, not a redesign.

### 5. After a cash sale: ask, always print, or no receipt
- **ask**: the existing two buttons.
- **print**: prints quietly and shows the change.
- **none**: records "no receipt" and shows the change with a **4-second "Next customer"
  countdown** that any touch pauses, plus a "Print receipt" button.

"none" is the Bible's zero-tap cash sale: scan, **Exact**, and the register is ready. Every
choice is recorded as `receipt.printed` (`original` / `none` / `reprint`), so replay shows what
happened.

## Consequences

- The template editor (Bible N, P21) edits these same settings plus layout options. The render
  path doesn't change.
- Receipt language (N) is a parameter to `renderReceipt`. Strings are centralized there.
