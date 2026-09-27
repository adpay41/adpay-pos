/**
 * The daily journal (P19b, ADR 0030): one row per store-local day, in the columns a bookkeeper posts to
 * QuickBooks or Xero by CSV import. Built on the server from the events; shared so every app exports the
 * same file.
 */
export interface JournalDay {
  date: string;
  location: string;
  /** Items and charges before tax, after discounts. */
  net_sales_cents: number;
  tax_cents: number;
  gross_cents: number;
  refunds_cents: number;
  cash_cents: number;
  card_cents: number;
  /** Checks and other tenders (EBT, gift cards, house accounts: ADR 0050). */
  check_cents: number;
  other_cents: number;
  paid_out_cents: number;
  paid_in_cents: number;
  drops_cents: number;
  over_short_cents: number;
}


const dollars = (c: number) => `${c < 0 ? '-' : ''}${Math.trunc(Math.abs(c) / 100)}.${String(Math.abs(c) % 100).padStart(2, '0')}`;

/** The journal as CSV: plain dollars with two decimals (integer cents printed, never float math). */
export function journalCsv(days: readonly JournalDay[]): string {
  const head = ['Date', 'Store', 'Net sales', 'Sales tax', 'Gross receipts', 'Refunds', 'Cash', 'Card', 'Check', 'Other tenders', 'Paid out', 'Paid in', 'Safe drops', 'Over/short'];
  const q = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const lines = days.map((d) =>
    [d.date, q(d.location), ...[d.net_sales_cents, d.tax_cents, d.gross_cents, d.refunds_cents, d.cash_cents, d.card_cents, d.check_cents, d.other_cents, d.paid_out_cents, d.paid_in_cents, d.drops_cents, d.over_short_cents].map(dollars)].join(','),
  );
  return [head.join(','), ...lines].join('\n') + '\n';
}
