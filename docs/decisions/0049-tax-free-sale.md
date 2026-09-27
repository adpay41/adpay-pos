# 0049: Tax-free sale (whole ticket)

- Status: Accepted
- Date: 2026-09-27
- Source: NRS gap analysis, item 4 ("tax-free sale toggle")
- Extends: ADR 0018 (tax by rate), ADR 0026 (sales-tax report), ADR 0044 (tax-inclusive prices)

## Decisions

### 1. One ticket event
`sale.tax_exempted` records:
- `exempt`;
- `reason`: resale certificate, non-profit, government, diplomat, or other;
- the buyer's `certificate` number, when there is one.

The latest event wins. `exempt: false` charges tax again.

### 2. The fold does the rest
On a tax-free ticket every line folds as **untaxed**, and per-unit charges lose their taxable flag.
- A **tax-inclusive** price (ADR 0044) drops to its price before tax, so the buyer pays neither
  added nor hidden tax: $10.00 → $9.38 cash, $10.40 → $9.75 card at 6.625%.
- The events keep what was rung, so the sale can be rebuilt either way.
- Totals, refunds (no tax given back), the Z-report and profit need no change of their own.

### 3. Reporting
The sales-tax report counts the sale in non-taxable, as before, and **also** lists it: new
`exempt_sales_cents` and `exempt_count`, an "Exempt sales" CSV column, and a line in the merchant
app's tax report. A filing that must show exempt sales separately can.

### 4. On the register
- A **Tax-free** key on the shortcut bar opens a panel: a reason, which is required, and the
  certificate number.
- It needs the new permission `ticket.tax_exempt`: owners and managers have it, and cashiers get a
  manager's override.
- The ticket's tax row says "Tax (tax-free: Resale certificate)".
- The receipt prints "Tax exempt #‹certificate›", in all 9 receipt languages.

## Tests
- **Register:** no tax on a mixed ticket, then taxed again after turning it off; the tax-inclusive
  pre-tax price in both modes; the receipt line; a refund without tax; permission defaults.
- **API:** an exempt sale in the sales-tax report, with no tax and counted as exempt.
