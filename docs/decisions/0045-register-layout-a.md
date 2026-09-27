# 0045: Register layout A: department tabs, the pad on the main screen, a shortcut bar

- Status: Accepted
- Date: 2026-09-27
- Source: tester feedback items 5–6. The tester wanted the register to feel like NRS, and
  specifically objected to cash tender opening a modal. The founder didn't pick between the
  proposed layouts, so we built the default, A.
- Amends: ADR 0009 (register core UI), ADR 0013 (register speed), ADR 0017 (tender flow)

## Decisions

### 1. The screen, top to bottom
| Area | Where | What it holds |
| --- | --- | --- |
| Top bar | Across the top (unchanged) | Store, clock out, cashier, drawer, sync, language, customer screen |
| Department tabs | Across the top | Favorites first; the age rule shown on a tab (21+). They replace the left column. |
| Item grid | Center, with search above | The keys |
| Register pad | Under the grid | Typed amount, digits, quick cash, tenders |
| Ticket | Right | Lines, totals (cash and card), rewards, usuals, bag fees |
| Shortcut bar | Full width at the bottom | Void, Reprint, Hold, Held, Tickets, Price check, Training, Receive, Write off, Checklist, End of day |

At 1280×720 the grid keeps about 290 px of height. On the T2s at 1920×1080 it gets roughly
650 px.

### 2. The pad replaces the cash modal
- Digits fill from the cents column like a till (2-0-0-0 = $20.00), with `00`, ⌫ and Clear.
- **Quick cash:** the next bills that cover what's due (Exact, the next dollar, $5, $10, $20…). One
  tap takes that bill and shows the change.
- **Cash key:** with nothing typed it takes the exact amount; with an amount it takes that amount.
  Less than what's due pays part, and the rest goes by card, when card is available (split, ADR
  0017).
- **Card key:** charges the card price of what's left straight to the terminal (one tap, no
  confirm screen). With an amount typed, it charges that much to this card (two cards, or split).
  Declines and errors still show the card panel.
- **Reject a bill** (counterfeit refusal, ADR 0024) lives on the pad.
- **No drawer started:** the float count comes first, then the tender the cashier already pressed
  completes by itself. There's no second tap.
- **A slot next to the digits** holds the keys that use the typed number: `@` quantity, PLU and
  department ring (next).

Buttons carrying amounts are black, never red.

### 3. What didn't change
- The card panel for waiting, declined and retry.
- Every tender path in the session: the pad calls the same `tenderCash` and `startCard` as before.
- Scanning, search, and the ticket's own actions.

## Verified
Clicked in the browser on the local stack at 1280×720:
- a $5 quick cash on a $2.12 roll with no drawer started: float count, then change $2.88;
- a typed $10.00 on a $2.93 coffee: change $7.07.

Pad digit entry is unit-tested. The register suite (97) passes.
