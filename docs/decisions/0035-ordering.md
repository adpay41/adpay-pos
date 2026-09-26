# 0035: Vendors, reorder suggestions, purchase orders

- Status: Accepted
- Date: 2026-09-26
- Build plan: P23a. Bible 2.4 (reorder suggestions from sales velocity and day-of-week pattern;
  vendor list with delivery days and contact; one-tap order text/email; receive by scan with a
  discrepancy report)
- Extends: ADR 0034 (inventory), ADR 0028 (`MessageSender`)

## Decisions

### 1. Vendors supply items
A vendor has a rep's phone and/or email, how orders go (text or email), delivery weekdays and a note.
An item's `vendor_id` is its primary vendor, which is what suggestions and orders group by.

### 2. A suggestion is "enough until the delivery after next"
`suggestReorder` (shared, pure, tested):
- forecasts each day from today until the vendor's delivery after next (a week, when no delivery days
  are set), as the **same weekday's average over the last four weeks**, which catches the weekend
  spike;
- adds the item's low-stock point as a buffer;
- subtracts what's on the shelf (the P22 fold) and what's **already on order** (units on sent orders
  not yet received);
- rounds up to whole cases, where a case barcode's pack quantity is the case size.

The arithmetic uses integer tenths of a unit, rounded up at the end. Sales are store-local days,
folded, net of refunds, and case-break aware.

### 3. Purchase orders
The flow is draft → **sent** → received or cancelled.
- "Send to the rep" writes the order as a text or email through `MessageSender`, recorded in
  `outbound_messages` (purpose `order`, masked) and audited. With the `log` sender it is **recorded,
  not delivered**, and the app tells the owner to call or text the rep.
- The register's receive panel lists the store's sent orders (`GET /device/purchase-orders`).
  Receiving against one stamps `po_id` on each `inventory.received` event, an additive field that is
  copied onto the movement row.
- **What came against what was ordered** is read from those movements for every order line, plus
  anything received that wasn't on the order. Short and over lines show in amber. Nothing is stored
  as "received quantity".

## Deferred
- Delivering orders by text or email needs the Twilio/SES accounts (ADR 0028).
- Vendor EDI or catalogs, and invoice parsing (the M-tier invoice AI), are not built.
