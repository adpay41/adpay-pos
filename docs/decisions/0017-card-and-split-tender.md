# 0017: Card tender on the stub, split tender with dual pricing per portion, payment idempotency

- Status: Accepted
- Date: 2026-09-24
- Build plan: P9 (foundation F5). Bible: L8, L14 (stub part), L15, L19, L23, L47, L57, L58
- Extends: ADR 0003 (PaymentProvider), ADR 0004 (integer cents), ADR 0009 (sale = fold of events)

## Context

Before P9, a sale had one `price_mode` (cash or card), the Card button was a placeholder, and
nothing ever called `PaymentProvider`. The Bible wants cash + card and two-card splits, with the
dual price applied **per portion**. A customer who hands over $3 cash must not pay the card price
on that $3.

## Decisions

### 1. Coverage is measured in cash-price cents
A sale has a cash total C and a card total K (K ≥ C). Every tender records `covers_cash_cents`,
the share of the sale it paid for, in cash-price cents:

- cash `a` covers `a` (capped at what is left);
- a card charge `a` covers `a × C / K`, rounded half-up once (`coverForCard`).

What is left, R, is always a cash-price amount. Paying R in cash costs R; paying it by card costs
`R × K / C`, half-up (`cardAmountFor`). Paying exactly that card amount covers all of R whatever
the rounding, so **finishing on either tender closes the sale to the cent**. The fold settles
coverage after the loop, once both totals are known. All arithmetic is integer (`packages/shared/src/split.ts`).

### 2. Three completion modes
`sale.completed.price_mode` is `cash | card | split`. For `split`, the declared totals are
`splitTotals`:

- the total is the money actually taken;
- the tax is cash-price tax weighted by the cash-covered share plus card-price tax weighted by the
  card-covered share;
- the subtotal is the total minus the tax.

A split receipt lists items at the cash price, prints the blended tax per rate (drift goes on the
largest rate, so the lines add up), and names each tender. Card tenders show only brand, last
four and auth code.

### 3. Card goes through one idempotent endpoint
`POST /device/payments/terminal-charge {sale_id, tender_id, amount_cents}` calls
`PaymentProvider.terminalCharge` through `services/payments.ts`:

- the **tender id is the idempotency key** (`payment_attempts` primary key);
- a retry after a timeout replays the stored result and never charges twice;
- only the provider ref, brand, last four and approval code are stored (rule 3: no PAN, ever).

`POST /device/payments/card-refund` refunds against the original charge, capped at what is left
on it. Nothing outside `payments/finix/` knows which provider is behind the interface.

The stub approves everything except amounts ending in **.13**, which it declines. That is a test
hook for clicking through the decline path.

### 4. Every attempt is an event
The register appends `sale.card_attempt` on `requested`, and again on the answer
(`approved | declined | error | timeout`), with the provider ref. Only an approved answer appends a
`sale.tender_added`. The attempts sit in the sale's timeline, so ticket replay shows the terminal
conversation (L47). Declines and errors leave the ticket open: try again, another card, or cash.

### 5. Offline: cash-only, and retry is safe
The Card button needs the server. While sync is offline, a **cash-only banner** shows and the
Card button is off; cash sales are untouched (72h offline rule). A card request that got no answer
shows "Try again" with the **same** tender id, so the retry is safe by construction.

### 6. Refunds and voids
- A card sale refunds by line, at the card price, back to the card.
- A **split sale is not refundable by line** in v1 (which tender a returned item came from is
  ambiguous). It is voided instead: each tender is refunded its own way, cash from the drawer and
  card back to the card.

Per-line split refunds can come later as a new event kind; no existing event would need to change.

### 7. Customer screen and copy
`DisplayPhase` is `idle | cart | card | approved | declined | paid`. Every customer-facing string
lives in `apps/register/src/ui/copy.ts`:

- no processor name and no spinner;
- decline copy is ink, never red, because it sits under an amount;
- a money-bearing button is black.

## Consequences

- Swapping the stub for Finix is still one config value; the register and API don't change.
- The PAX A35 flow (L14 for real) plugs into the same endpoint when the hardware arrives (P-HW).
- `refundQuote` throws for split sales on purpose, so a later per-line split refund has to be designed
  rather than falling into a wrong answer.
