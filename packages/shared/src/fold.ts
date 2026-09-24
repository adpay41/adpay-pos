/**
 * Folding a sale's events into its state. This is the one definition of "what a sale adds up to" —
 * the register, the API and the tests all call it. Totals are never stored and edited; they are
 * recomputed from the immutable events every time (ADR 0002, ADR 0004).
 */
import type { RegisterEvent } from './events';
import { add, cents, sub, sum, ZERO, type Cents } from './money';
import { computeTotals, type PriceMode, type TaxableLine, type Totals } from './pricing';

export type SaleStatus = 'open' | 'suspended' | 'completed' | 'voided';

export interface FoldedLine {
  line_id: string;
  item_id: string;
  name: string;
  qty: number;
  unit_cash_price_cents: Cents;
  unit_card_price_cents: Cents;
  cash_discount_cents: Cents;
  card_discount_cents: Cents;
  taxable: boolean;
  tax_rate_ppm: number;
  min_age: number | null;
  age_verified: boolean;
}

export interface FoldedTender {
  tender_id: string;
  tender_type: 'cash' | 'card';
  amount_cents: Cents;
  change_cents: Cents;
  approved: boolean;
}

export interface FoldedSale {
  sale_id: string;
  status: SaleStatus;
  lines: FoldedLine[];
  /** Both price modes, so the customer screen can show cash and card side by side. */
  cash: Totals;
  card: Totals;
  price_mode: PriceMode | null;
  tenders: FoldedTender[];
  paid_cents: Cents;
  refunded_cents: Cents;
  /** Units already refunded, per line (P7). */
  refunded_qty: Record<string, number>;
  /** Totals the device declared on sale.completed, when present. */
  declared: Totals | null;
  /** True when the declared totals disagree with the fold — surfaced in admin, never auto-fixed. */
  mismatch: boolean;
}

function toTaxable(lines: FoldedLine[], mode: PriceMode): TaxableLine[] {
  return lines.map((l) => ({
    qty: l.qty,
    unit_price_cents: mode === 'cash' ? l.unit_cash_price_cents : l.unit_card_price_cents,
    discount_cents: mode === 'cash' ? l.cash_discount_cents : l.card_discount_cents,
    taxable: l.taxable,
    tax_rate_ppm: l.tax_rate_ppm,
  }));
}

/** Fold one sale's events. Events are ordered by device_seq; duplicates by event_id are ignored. */
export function foldSale(saleId: string, events: readonly RegisterEvent[]): FoldedSale {
  const ordered = [...events].filter((e) => e.sale_id === saleId).sort((a, b) => a.device_seq - b.device_seq);
  const seen = new Set<string>();
  const lines = new Map<string, FoldedLine>();
  const tenders: FoldedTender[] = [];
  let status: SaleStatus = 'open';
  let priceMode: PriceMode | null = null;
  let declared: Totals | null = null;
  let refunded: Cents = ZERO;
  const refundedQty: Record<string, number> = {};

  for (const e of ordered) {
    if (seen.has(e.event_id)) continue;
    seen.add(e.event_id);
    switch (e.type) {
      case 'sale.line_added': {
        const p = e.payload;
        lines.set(p.line_id, {
          line_id: p.line_id,
          item_id: p.item_id,
          name: p.name,
          qty: p.qty,
          unit_cash_price_cents: cents(p.unit_cash_price_cents),
          unit_card_price_cents: cents(p.unit_card_price_cents),
          cash_discount_cents: ZERO,
          card_discount_cents: ZERO,
          taxable: p.taxable,
          tax_rate_ppm: p.tax_rate_ppm,
          min_age: p.min_age,
          age_verified: false,
        });
        break;
      }
      case 'sale.line_removed':
        lines.delete(e.payload.line_id);
        break;
      case 'sale.line_qty_changed': {
        const line = lines.get(e.payload.line_id);
        if (line) line.qty = e.payload.qty;
        break;
      }
      case 'sale.line_discounted': {
        const line = lines.get(e.payload.line_id);
        if (line) {
          line.cash_discount_cents = cents(e.payload.cash_discount_cents);
          line.card_discount_cents = cents(e.payload.card_discount_cents);
        }
        break;
      }
      case 'sale.age_verified': {
        const line = lines.get(e.payload.line_id);
        if (line) line.age_verified = true;
        break;
      }
      case 'sale.tender_added': {
        const p = e.payload;
        tenders.push({
          tender_id: p.tender_id,
          tender_type: p.tender_type,
          amount_cents: cents(p.amount_cents),
          change_cents: cents(p.change_cents ?? 0),
          approved: p.tender_type === 'cash' || p.card?.status === 'approved',
        });
        break;
      }
      case 'sale.completed':
        status = 'completed';
        priceMode = e.payload.price_mode;
        declared = {
          subtotal_cents: cents(e.payload.subtotal_cents),
          tax_cents: cents(e.payload.tax_cents),
          total_cents: cents(e.payload.total_cents),
        };
        break;
      case 'sale.voided':
        status = 'voided';
        break;
      case 'sale.refunded':
        refunded = add(refunded, cents(e.payload.amount_cents));
        for (const l of e.payload.lines) refundedQty[l.line_id] = (refundedQty[l.line_id] ?? 0) + l.qty;
        break;
      case 'sale.suspended':
        if (status === 'open') status = 'suspended';
        break;
      case 'sale.resumed':
        if (status === 'suspended') status = 'open';
        break;
      default:
        break;
    }
  }

  const active = [...lines.values()];
  const cash = computeTotals(toTaxable(active, 'cash'));
  const card = computeTotals(toTaxable(active, 'card'));
  const paid = sum(tenders.filter((t) => t.approved).map((t) => t.amount_cents));
  const expected = priceMode === 'card' ? card : priceMode === 'cash' ? cash : null;
  const mismatch =
    declared !== null &&
    expected !== null &&
    (declared.total_cents !== expected.total_cents || declared.tax_cents !== expected.tax_cents);

  return {
    sale_id: saleId,
    status,
    lines: active,
    cash,
    card,
    price_mode: priceMode,
    tenders,
    paid_cents: paid,
    refunded_cents: refunded,
    refunded_qty: refundedQty,
    declared,
    mismatch,
  };
}

/** Net money a completed sale brought in (after refunds); zero for voided or unfinished sales. */
export function saleNetCents(sale: FoldedSale): Cents {
  if (sale.status !== 'completed') return ZERO;
  return sub(sale.paid_cents, sale.refunded_cents);
}
