# 0027: Languages, digital receipt, customer-screen accessibility

- Status: Accepted
- Date: 2026-09-26
- Build plan: P18a. Bible 1.5 (language toggle, digital receipt, accessibility), 1.6 (receipt
  language), 3.4 (translations management), Part 4 ("their language")
- Extends: ADR 0009 (display channel, receipts), ADR 0016 (receipt v2)

## Decisions

### 1. One message catalog in `packages/shared`, English as the source
`i18n-messages.ts` holds every customer-screen and receipt string. English is the source, plus
the Bible's eight languages: Spanish, Chinese (Simplified), Korean, Arabic, Hindi, Bengali, Gujarati
and Haitian Creole.

- `translate(lang, key, vars, overrides)` resolves a string in this order: override, built-in
  translation, English.
- Placeholders such as `{amount}` must survive translation. `placeholdersMatch` checks this in
  tests and on every admin edit.
- Item names, header lines, the return policy and a custom footer print exactly as the store wrote
  them. The default footer ("Thank you!") is translated.

### 2. Nobody has reviewed the translations, and the platform tracks that per language
Each language has a status: **draft** (stores can't offer it), **available** (stores can offer it,
unreviewed) or **reviewed** (a named admin records who checked it).

- The code defaults are: Spanish, Chinese, Korean, Arabic and Hindi available; Bengali, Gujarati and
  Haitian Creole draft, because we are less sure of those catalogs.
- Admin → **Translations** changes a status, corrects any string (`translation_overrides`), and
  shows coverage and how many stores are asking for each language.
- Changes bump every merchant's catalog version, so registers pick them up at their next sync.
- **Deferred:** a professional translation review. It is outside the code; when it happens, an
  admin marks the language reviewed.

### 3. The customer chooses; the sale records it; the receipt follows
- Receipt settings gain three fields:
  - `languages`: offered on the customer screen; default `en`, `es`.
  - `default_language`: each sale starts in it.
  - `digital_receipt`: default on.
- The register snapshot carries `i18n`: the offered list, with draft languages removed, plus the
  default and the overrides.
- The customer screen has a language button. Choices appear in their own script, and the pick
  travels back to the register over the display channel (`customer_language`). The cashier sees
  "Customer: Korean" on the ticket.
- `sale.completed` gains `language`, only when it isn't English, so older payloads are unchanged.
  The receipt prints in the captured language, and a reprint weeks later matches the original.
- Each new customer starts in the store default.
- Arabic lays out right to left on the customer screen and the receipt page.
- Receipts are laid out in printer columns: CJK takes 2, combining marks take 0 (`cellWidth`), so
  48 columns still fit on 80 mm paper.

**Boundary:** printing non-Latin scripts on the thermal printer depends on the printer module
(Kotlin, P-HW). On the Sunmi, text goes through the printer service's Unicode fonts, with a bitmap
fallback for Arabic shaping. This is unverified until the hardware is in hand. The on-screen
preview and the digital receipt already show the correct text.

### 4. Digital receipt: a random token, a public page, no hosting decision baked in
- When the store has digital receipts on, `sale.completed` carries `receipt_token`: a v4 UUID from
  the device, unrelated to the sale id.
- The QR (on the receipt and on the customer screen after paying) points to
  `<API URL>/r/<token>`.
- The API serves that page without authentication. It is the receipt as printed, from the same
  renderer, in the sale's language. It sends `noindex` and `no-store` headers and a strict CSP
  (no scripts, no external requests).
- A token that hasn't synced yet gets an "on its way" page that refreshes itself.
- Locally the link is `localhost`, so a phone can't open it. Through `npm run share` it is the
  public tunnel URL and works end to end.
- **Deferred:** always-on public hosting of the API/receipt page. This is the deploy the founder is
  holding (AWS, ADR 0005). Nothing in the code changes when it lands; the register's API URL
  becomes public.

### 5. Customer-screen accessibility
- A **Larger text** toggle on the customer screen: 1.35× type, pure-black text and rules, and a
  darker green that still reads as money. It resets for the next customer.
- Every line and total has a spoken label with both prices.
- Card prompts and results announce themselves (`accessibilityLiveRegion`).
- Controls have roles and states.
- The QR is drawn with plain Views, so it renders identically in the browser and on the Android
  Presentation display.

## Not in P18a (P18b)
- Cashier-side language on the register (the Bible's "independently").
- Large type and high contrast on the register itself.
- "Send receipt later" from the merchant app, built behind a message-sender interface with a local
  outbox. Real SMS/email delivery needs a Twilio/SES account and TCPA review: deferred.
