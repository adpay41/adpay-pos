# 0046: Department ring: an amount straight to a department, with no item

- Status: Accepted
- Date: 2026-09-27
- Source: NRS gap analysis (docs/nrs-gap-analysis.md), rated structural. Every NRS store rings loose
  amounts ("$3.50 grocery") to a department, and our `sale.line_added` required an `item_id`.
- Amends: ADR 0002 / 0009 (the event and the fold), ADR 0045 (the pad)

## Decisions

### 1. The event carries no item for it
- `sale.line_added.item_id` is now nullable. `price_source: 'department'` marks the line.
- The line keeps what makes it reportable and replayable: the department's `category_id`, its name,
  both unit prices, the tax setting and rate at ring time, and the age rule.
- Older events are unchanged: they all have an item.
- We did **not** make a hidden "open department" item per category. Hidden items would leak into
  item counts, stock, labels, the UPC library and price books everywhere. An honest null is one
  rule that every consumer applies once.

### 2. One ring path
- `departmentItem(category)` (shared) is a key-shaped stand-in: open price, the department's tax,
  tax class and age rule (`effectiveMinAge`, the state's rule applies).
- The register rings it through the ordinary session path, so the age check, compliance charges and
  promotions by category all apply. The session writes `item_id: null` for it.
- Department rings never merge: each is its own line, like any open-price ring.

### 3. Every consumer handles a line with no item
| Consumer | What it does with a department ring |
| --- | --- |
| Stock (register view and inventory fold) and the reorder forecast | Counts nothing |
| Promotions | Can qualify by category, never by item |
| Profit | Bucketed as "‹Department› (department)", uncosted |
| Z-report and tax report | By category, as before |
| Refunds | Like any line |
| Repeat last sale | Rings it again at the same amount |
| Usuals | Never include it; "Save as usual" hides on a ticket of only department lines |
| Server | Ingests and reports it (all server uses read the payload) |

### 4. On the register
The pad (ADR 0045) has a department key next to the digits: **→ ‹Department›**, the department tab
on screen.
- Type the amount, then press it.
- With nothing typed, it asks for the price.
- With Favorites on screen, it says "pick a tab".
- An age-restricted department goes through the age check and keeps the typed amount.

The age check also now keeps a price-embedded label's price (ADR 0033). It previously asked again.

## Tests
- **Register:** rings with a null item, taxed as its department; an untaxed department; the age check;
  no merging; Z by category; profit bucket; repeat, usuals and refund.
- **API:** a department line ingests with nothing rejected, and the sales-tax report counts it.
- **Browser:** clicked on the local stack (Grocery tab, 3-5-0, → Grocery rings "Grocery $3.50").
