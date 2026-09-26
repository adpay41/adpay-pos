# 0029: Loyalty by phone number, customer list, texts

- Status: Accepted
- Date: 2026-09-26
- Build plan: P19a. Bible 1.5 (loyalty by phone on the customer screen; digital receipt by text),
  2.7 (loyalty program setup; customer list; promo text with TCPA opt-in), Part 4
- Extends: ADR 0028 (`MessageSender`), ADR 0027 (digital receipt)

## Decisions

### 1. The phone number stays out of the ledger
The customer types their number on the customer screen. The register turns it into
`customer_ref` = HMAC-SHA256(merchant salt, `+1XXXXXXXXXX`).

`sale.customer_identified` carries only the ref, the last four digits and whether they opted in to
texts; `sale.loyalty_redeemed` carries the ref and the cost. The salt is per merchant, generated in
the migration, and travels only in the register's snapshot, never to the apps.

This is pseudonymization, not secrecy: 10-digit numbers can be brute-forced by anyone holding the
salt. What it buys is that the append-only event log, which can never be edited, never holds a
number, so deleting a customer's number is always possible.

### 2. Numbers are stored only with an opt-in, and only if they match
The customer can tick "text me deals" (the store chooses whether to ask). Then the register sends
the number to `POST /device/customers/opt-in`. The server accepts it only if it hashes to the ref on
the ticket, and stores it in `customers` with:

- the time;
- the consent version and the **exact English consent sentence**;
- the register.

Offline, the opt-in waits in a small local outbox on the register (the one place a number is kept
there) and is sent on the next sync. An opt-out, recorded by the merchant, deletes the number.

**Deferred:**
- Inbound STOP/HELP handling needs an SMS provider (Twilio) with an inbound webhook.
- Counsel should review the consent wording and our TCPA posture. The consent is shown in English
  whatever the screen language, because its wording is the legal record.

### 3. Balances fold from sales
- **Program**: a punch card (every N qualifying visits) or points per dollar of the cash-price
  subtotal. The store chooses a qualifying category ("5th coffee free") and a minimum ticket.
- **Reward**: the cheapest qualifying item free up to a cap, or a fixed amount off, which spreads
  from the biggest line down.
- `loyaltyStatus` folds the customer's sales (voided sales earn nothing) minus the costs of rewards
  used. No balance is stored. Changing the program re-reads history under the new rules; that is
  simple, and the owner sees it at once.
- **Earning works offline**, because the sale carries the ref and the server folds it later.
- **A reward needs a connection**, because the register asks the server for the balance. Offline,
  the cashier and the customer are told the visit counts and rewards need a connection.
- Applying a reward emits the line discounts and then `sale.loyalty_redeemed`, behind the new
  `loyalty.redeem` permission (cashiers have it by default).

### 4. Customer list and promos (merchant app → Customers)
- The list shows regulars by spend: last four digits, visits, spend, last visit, and whether they
  get texts. It needs the new `customers.view` permission.
- A promo goes to the top 100 who opted in, at most one per customer per week. It is always
  prefixed with the store name and always ends "Reply STOP to opt out." It goes through
  `MessageSender`, needs `customers.message`, and is recorded in `outbound_messages` (masked) and
  audited.
- Program setup needs `catalog.edit`.

### 5. "Text me my receipt" on the customer screen
After paying, the customer can type a number. The register sends it with the sale's receipt token
to `POST /device/receipts/text`, and the server texts the digital-receipt link. This is a one-off
the customer asked for; no marketing consent is recorded or implied. With the `log` sender the
customer screen says texting isn't set up and points to the QR. It never pretends a text was sent.

## Not in P19a
Multi-store roll-up, accountant access, cashier performance and the new alert rules are P19b.
