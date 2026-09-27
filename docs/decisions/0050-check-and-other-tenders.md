# 0050: Check and other tenders

- Status: Accepted
- Date: 2026-09-27
- Source: NRS gap analysis, item 4 ("check and other tenders")
- Extends: ADR 0017 (split tender, dual pricing per portion), ADR 0014 (cash drawer), ADR 0025 (Z)

## Decisions

### 1. Two new tender types
`TenderTypeSchema` is now `cash | card | check | other`. A tender can carry:
- a `reference`: a check number, or the reference for a gift card, EBT or account (never card
  data);
- an `other_kind` for `other`: EBT, gift card, house account, or other.

Both are additive and default to null. The real EBT processor, gift-card program and house accounts
are separate rows in the gap analysis. This records the tender.

### 2. The cash price, no change, no overpaying
Everything but a card pays at the **cash price** and covers what it pays, like cash.
- A check or other tender is for at most what's left, and gives no change.
- Less than what's left pays part; the rest goes on another tender.
- **Only a card mixed with a non-card tender is a split sale.** The session's price-mode rule
  changed so that cash + check stays a cash-price sale.

### 3. Money flows
| Area | Behaviour |
| --- | --- |
| Drawer | Counts **cash only**. A check opens the drawer (it goes in) but is never counted as cash. EBT, gift cards and accounts don't open it. |
| Z-report | `by_tender` gains check and other amounts and counts; the printed Z lists them when present |
| Sales summary | Includes them in gross and by tender (API, admin, merchant app) |
| Daily journal CSV | New "Check" and "Other tenders" columns |
| Revenue ("money") queries | Count any non-card tender as taken |
| Refunds | A check or other-tender sale refunds in **cash**, the usual counter practice |

### 4. Receipt and register
- **Receipt:** "Check #1042 $21.33", "EBT #4410 $10.00", and so on. Five new keys in all 9
  languages.
- **Register:** the pad's **Check / other** key opens a panel:
  - check, EBT, gift card, house account, or other;
  - the reference;
  - the amount is what's typed on the pad, or everything left.

## Tests
- **Register:**
  - a check pays the ticket, with its number on the receipt;
  - no overpaying;
  - cash + check stays at the cash price;
  - EBT + card is split with no mismatch;
  - Z by tender, with drawer cash equal to cash only;
  - a check sale refunds in cash.
- **API:** the sales summary counts a check in gross and by tender.
