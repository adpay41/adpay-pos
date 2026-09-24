/**
 * Refunds and voids of completed sales (build plan P7, Bible 1.3 "dual pricing correct on every
 * path"). A refund gives back what the customer **paid**: at the price mode of the sale (cash price
 * for a cash sale, card price for a card sale), with that line's tax, and never more than was paid
 * minus what was already refunded. Returning everything left refunds exactly the remainder, so
 * rounding can never leave a stray cent behind or pay one out twice.
 */
import type { FoldedSale } from './fold';
import { cents, sub, ZERO, type Cents } from './money';
import { computeTotals, type TaxableLine } from './pricing';

export interface RefundLine {
  line_id: string;
  qty: number;
}

export interface RefundQuote {
  lines: RefundLine[];
  amount_cents: Cents;
  /** True when this refunds everything still refundable on the sale. */
  full: boolean;
}

/** Units of each line still returnable. */
export function refundableQty(sale: FoldedSale): Record<string, number> {
  const out: Record<string, number> = {};
  for (const l of sale.lines) out[l.line_id] = Math.max(0, l.qty - (sale.refunded_qty[l.line_id] ?? 0));
  return out;
}

/** What handing back `selection` is worth, at the price mode the sale was paid in. */
export function refundQuote(sale: FoldedSale, selection: readonly RefundLine[]): RefundQuote {
  if (sale.status !== 'completed' || !sale.price_mode) throw new Error('Only a completed sale can be refunded');
  // A split sale's items were paid partly at each price; a partial return would need a rule for
  // which portion gets the money back. Until there is one, a split sale is voided as a whole.
  if (sale.price_mode === 'split') throw new Error('A split-payment sale is refunded by voiding it: each part goes back to how it was paid');
  const mode = sale.price_mode;
  const left = refundableQty(sale);
  const lines: RefundLine[] = [];
  const taxable: TaxableLine[] = [];
  for (const sel of selection) {
    const line = sale.lines.find((l) => l.line_id === sel.line_id);
    if (!line) throw new Error('That line is not on this sale');
    if (!Number.isInteger(sel.qty) || sel.qty < 1) continue;
    if (sel.qty > (left[sel.line_id] ?? 0)) throw new Error(`Only ${left[sel.line_id] ?? 0} of ${line.name} can still be returned`);
    lines.push({ line_id: sel.line_id, qty: sel.qty });
    const unit = mode === 'cash' ? line.unit_cash_price_cents : line.unit_card_price_cents;
    const discount = mode === 'cash' ? line.cash_discount_cents : line.card_discount_cents;
    // A line discount is spread over its units and the share rounded **up** once, so a partial
    // return never hands back more than was paid for those units (the full return takes the exact rest).
    // Per-unit charges (a deposit, P10) go back with the unit they were charged on.
    const charges = line.charges.map((c) => ({ unit_cents: mode === 'cash' ? c.unit_cash_cents : c.unit_card_cents, taxable: c.taxable }));
    taxable.push({ qty: sel.qty, unit_price_cents: unit, discount_cents: Math.ceil((discount * sel.qty) / line.qty), taxable: line.taxable, tax_rate_ppm: line.tax_rate_ppm, charges });
  }
  if (lines.length === 0) return { lines, amount_cents: ZERO, full: false };
  const remaining = sub(sale.paid_cents, sale.refunded_cents);
  const full = sale.lines.every((l) => (left[l.line_id] ?? 0) === (lines.find((x) => x.line_id === l.line_id)?.qty ?? 0));
  const quoted = cents(computeTotals(taxable).total_cents);
  const amount = full || quoted > remaining ? remaining : quoted;
  return { lines, amount_cents: amount < 0 ? ZERO : amount, full };
}
