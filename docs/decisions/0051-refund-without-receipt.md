# 0051: Refund without a receipt

- Status: Accepted
- Date: 2026-09-27
- Source: NRS gap analysis, item 4 (their free "Refund" key)
- Extends: ADR 0015 (refunds against a ticket), ADR 0014 (drawer)

## Decisions

### 1. A return ticket, closed by a cash refund
- `sale.opened` gains `kind: 'return'` and a `reason`. Both are additive; older events are sales.
- The cashier rings what's coming back exactly as they would sell it (scan, keys, department ring,
  @, PLU), so each item comes back at **today's price with its tax by department**.
- It closes with the existing `sale.refunded` event (cash, every line), and the fold marks it
  **`returned`**, at the cash price.
- There is **no `sale.completed`**: a return is never a sale.
- **Why not negative lines:** every report, the drawer and the Z already treat `sale.refunded` as
  money going back, including its tax (`refundTax` on the ticket's own lines). A return ticket
  lands in all of them unchanged, and nothing that counts sales can mistake it for one.

### 2. What it touches
| Area | Behaviour |
| --- | --- |
| Drawer | Pays it out (`drawer.opened` for a refund; cash refunds lower the expected cash) |
| Z-report | A refund in count and cash; no sale, no gross |
| Sales-tax report | Refunds and refund tax (price mode cash) |
| Sales summary, journal | Refunds |
| Admin sales list | `returned`, with the amount as money out (−) |
| `saleNetCents` | Negative for a returned ticket |
| Age check | None asked or logged: the customer is bringing it back |
| Promotions | Don't reprice a return: it comes back at the plain price |
| Tenders | None allowed on a return; it can't start over a ticket with items on it |

### 3. Permission and register
- New permission `refund.no_receipt`: owners and managers have it, and a cashier gets a manager's
  override.
- The shortcut bar has **Return (no receipt)**. The flow:
  1. pick a reason (defective, wrong item, changed mind, expired, other);
  2. the ticket shows "RETURN — no receipt · reason", and the pad's tenders are off;
  3. **Refund $x in cash** pays it out, opens the drawer and prints a receipt marked RETURN.
- Voiding the open return ticket cancels it.

### 4. Fixed on the way
A refund or void of a sale paid by **check** or another non-card tender comes back in cash (ADR
0050), and now opens the drawer. Before, the drawer opened only when the sale had a cash tender.

## Tests
- **Register:**
  - the return rings at today's price with tax, and refunds in cash;
  - no age check is logged, and no `sale.completed` is written;
  - net is negative, and refund tax is right;
  - tenders are refused, and it can't start over an open sale;
  - the Z shows a refund and no sale, and the drawer pays it out.
- **API:** a return ticket in the sales-tax report (refunds $3.19, refund tax $0.20), the sales
  summary, and the sales list as `returned` at −$3.19.
- **Browser, local stack:** Return (no receipt) → Defective → manager approval → a buttered roll →
  "Refund $2.12 in cash" → "Refunded $2.12 in cash."
