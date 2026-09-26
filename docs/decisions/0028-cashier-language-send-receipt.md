# 0028: Cashier language on the register; send a receipt later

- Status: Accepted
- Date: 2026-09-26
- Build plan: P18b. Bible 1.5 (language toggle: cashier and customer independently), 1.6
  (email/text a receipt later from the merchant app)
- Extends: ADR 0027

## Decisions

### 1. Cashier strings are keyed by their English text
The register screens have about 350 strings. Naming each one would double the work of every text
change, so the English text is the key:

- `t('Void ticket')` for plain strings;
- `t('Paid {amount} by card', { amount })` for strings with values;
- `tk('Owner')` for table entries that are translated where they're shown.

`pnpm --filter @adpay/register i18n:extract` collects every literal, plus the shared permission
labels, into `packages/shared/src/i18n-cashier.ts`. That turns `CashierKey` into a union, so a
typo in `t('…')` is a type error. A register test fails when the committed list and the source
disagree.

Strings stay English where they are data rather than UI:

- void, refund and paid-out reasons written into events;
- receipt footers;
- log lines;
- errors thrown by the core.

The one-time pairing screen, used by the installer, also stays English.

### 2. Same catalog, same admin page
Cashier keys join the customer and receipt keys in `MessageKey`, so they get the same
`translate()`, overrides, placeholder check and admin → Translations page. The page has a
"Register (cashier)" filter, an "only untranslated" filter and its own coverage column. Because a
cashier key is an English sentence, the admin route takes the key in the body.

### 3. Spanish is complete; the other seven are the translators' job, in admin
The cashier side ships **English and Spanish, complete**. For the other seven languages, every
untranslated string shows in English.

We didn't generate 2,400 unreviewed operational strings (drawer, paid-out, void, refund, manager
override), because a wrong word there causes cashier mistakes, not just awkward reading. A
fluent person fills them in admin → Translations, with no code change or deploy; coverage shows
progress.

A cashier may choose any language that isn't in draft platform-wide (`i18n.cashier` in the
snapshot), independent of what the store offers customers.

### 4. The choice is per cashier, per register, local
The picker is on "Who's working?" and in the sale-screen header. The choice is stored in the
register's local store, per signed-in cashier (and for the register before anyone signs in). It
works offline and never touches the sale log.

Syncing it to the cashier's membership, so it follows them to every register, would be a small
later step. It isn't needed for one-register stores.

### 5. `MessageSender`: SMS and email behind one interface, `log` in v1
`packages/api/messaging/sender.ts` mirrors `PaymentProvider`. Everything that sends a text or
email depends on the interface; `MESSAGE_PROVIDER` picks the implementation. The only one built
is `log`: it records the message and writes the API log with the recipient masked, and **delivers
nothing** (`delivers: false`, which the merchant app says in plain words).

**Deferred:** Twilio (SMS) and SES (email). They need accounts, a sending number or domain, and
TCPA review for texting. Each is one new class plus the config value.

### 6. Send a receipt later, from the merchant app
In the merchant app, Tickets → tap a ticket → **Send receipt** by text or email. The message
carries the digital-receipt link (ADR 0027). A sale rung without a token (digital receipts off, or
rung before P18) gets a link minted beside it in `receipt_links`; the events are never touched.

Every message is recorded in `outbound_messages` with:

- tenancy, sale and trace id;
- the recipient masked (`•••0199`) plus a merchant-salted hash, never in full;
- provider and status.

It's rate-limited to 5 per sale per hour and audited.

## Also decided here
The Bible's accessibility item (1.5) is about the customer screen, which P18a covers. The register
itself gets roles and labels on the new controls. There is no separate large-type mode, because
Android's system font size already scales the register's text.
