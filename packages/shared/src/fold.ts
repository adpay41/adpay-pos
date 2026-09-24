/**
 * Folding a sale's events into its state. This is the one definition of "what a sale adds up to" —
 * the register, the API and the tests all call it. Totals are never stored and edited; they are
 * recomputed from the immutable events every time (ADR 0002, ADR 0004).
 */
import type { RegisterEvent } from './events';
import { add, cents, sub, sum, ZERO, type Cents } from './money';
import { computeTotals, type PriceMode, type TaxableLine, type Totals } from './pricing';
import type { LineCharge } from './compliance';
import { coverForCard, splitTotals } from './split';

/** How a completed sale was paid: at the cash price, the card price, or split between them (P9). */
export type CompletionMode = PriceMode | 'split';

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
  /** Restriction kind behind the age check, when the line has one (P10). */
  restriction: 'tobacco' | 'vape' | 'alcohol' | 'lottery' | null;
  /** Per-unit charges captured at sale (deposit, excise, fee), P10. */
  charges: LineCharge[];
  /** A bag fee or other fee rung as its own line (not an item). */
  is_fee: boolean;
}

export interface FoldedTender {
  tender_id: string;
  tender_type: 'cash' | 'card';
  amount_cents: Cents;
  change_cents: Cents;
  approved: boolean;
  /** Cash-price cents of the sale this tender paid for (ADR 0017). */
  covers_cash_cents: Cents;
  /** Card facts for a card tender: brand, last four, processor ref. Never card data. */
  card: { brand: string | null; last4: string | null; provider: string; provider_ref: string; approval_code: string | null } | null;
}

export interface FoldedSale {
  sale_id: string;
  status: SaleStatus;
  lines: FoldedLine[];
  /** Both price modes, so the customer screen can show cash and card side by side. */
  cash: Totals;
  card: Totals;
  price_mode: CompletionMode | null;
  tenders: FoldedTender[];
  /** Cash-price cents not yet paid for; the card equivalent is `cardAmountFor(remaining, cash, card)`. */
  remaining_cash_cents: Cents;
  paid_cents: Cents;
  refunded_cents: Cents;
  /** Units already refunded, per line (P7). */
  refunded_qty: Record<string, number>;
  /** Totals the device declared on sale.completed, when present. */
  declared: Totals | null;
  /** True when the declared totals disagree with the fold — surfaced in admin, never auto-fixed. */
  mismatch: boolean;
}

export function toTaxable(lines: FoldedLine[], mode: PriceMode): TaxableLine[] {
  return lines.map((l) => ({
    qty: l.qty,
    unit_price_cents: mode === 'cash' ? l.unit_cash_price_cents : l.unit_card_price_cents,
    discount_cents: mode === 'cash' ? l.cash_discount_cents : l.card_discount_cents,
    taxable: l.taxable,
    tax_rate_ppm: l.tax_rate_ppm,
    charges: l.charges.map((c) => ({ unit_cents: mode === 'cash' ? c.unit_cash_cents : c.unit_card_cents, taxable: c.taxable })),
  }));
}

/** What one line costs in a price mode: price × qty − discount + per-unit charges × qty. */
export function lineTotal(line: FoldedLine, mode: PriceMode): Cents {
  return computeTotals(toTaxable([line], mode)).subtotal_cents;
}

/** Fold one sale's events. Events are ordered by device_seq; duplicates by event_id are ignored. */
export function foldSale(saleId: string, events: readonly RegisterEvent[]): FoldedSale {
  const ordered = [...events].filter((e) => e.sale_id === saleId).sort((a, b) => a.device_seq - b.device_seq);
  const seen = new Set<string>();
  const lines = new Map<string, FoldedLine>();
  const tenders: FoldedTender[] = [];
  let status: SaleStatus = 'open';
  let priceMode: CompletionMode | null = null;
  const covers: (number | null)[] = [];
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
          restriction: p.restriction ?? null,
          charges: p.charges ?? [],
          is_fee: p.price_source === 'fee',
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
          covers_cash_cents: ZERO, // settled after the loop, once the totals are known
          card: p.card ? { brand: p.card.brand, last4: p.card.last4, provider: p.card.provider, provider_ref: p.card.provider_ref, approval_code: p.card.approval_code } : null,
        });
        covers.push(p.covers_cash_cents);
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
  // What each approved tender paid for, in cash-price cents (explicit on new events, derived on old).
  let remaining: number = cash.total_cents;
  tenders.forEach((t, i) => {
    if (!t.approved) return;
    const explicit = covers[i];
    const cover =
      explicit !== null && explicit !== undefined
        ? Math.min(explicit, remaining)
        : t.tender_type === 'cash'
          ? Math.min(t.amount_cents, remaining)
          : coverForCard(t.amount_cents, remaining, cash.total_cents, card.total_cents);
    t.covers_cash_cents = cents(cover);
    remaining -= cover;
  });
  const paid = sum(tenders.filter((t) => t.approved).map((t) => t.amount_cents));
  const expected =
    priceMode === 'card'
      ? card
      : priceMode === 'cash'
        ? cash
        : priceMode === 'split'
          ? splitTotals(cash, card, tenders.filter((t) => t.approved).map((t) => ({ tender_type: t.tender_type, amount_cents: t.amount_cents, covers_cash_cents: t.covers_cash_cents })))
          : null;
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
    remaining_cash_cents: cents(Math.max(0, remaining)),
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
