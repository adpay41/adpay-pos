/**
 * Folding a sale's events into its state. This is the one definition of "what a sale adds up to" —
 * the register, the API and the tests all call it. Totals are never stored and edited; they are
 * recomputed from the immutable events every time (ADR 0002, ADR 0004).
 */
import type { OTHER_TENDER_KINDS, RegisterEvent, TenderType } from './events';
import type { Lang } from './i18n';
import { add, cents, includedTaxHalfUp, sub, sum, ZERO, type Cents } from './money';
import { computeTotals, lineNet, type PriceMode, type TaxableLine, type Totals } from './pricing';
import type { LineCharge } from './compliance';
import { coverForCard, splitTotals } from './split';
import { isEmptyBasket, spreadBasket, type BasketDiscount } from './basket';

/** How a completed sale was paid: at the cash price, the card price, or split between them (P9). */
export type CompletionMode = PriceMode | 'split';

/** `returned`: a return ticket (refund without a receipt, ADR 0051) once its money went back. */
export type SaleStatus = 'open' | 'suspended' | 'completed' | 'voided' | 'returned';

export interface FoldedLine {
  line_id: string;
  /** Null for a department ring (ADR 0046): an amount with no item behind it. */
  item_id: string | null;
  name: string;
  /** The item's category when rung (loyalty's qualifying category, P19a). */
  category_id: string | null;
  qty: number;
  unit_cash_price_cents: Cents;
  unit_card_price_cents: Cents;
  cash_discount_cents: Cents;
  card_discount_cents: Cents;
  /** Why the line is discounted ("Promo: 2 for $5", "Loyalty reward") and which promotion, if one (P20a). */
  discount_reason: string | null;
  discount_promo_id: string | null;
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
  /** The unit prices already contain the tax (ADR 0044). */
  tax_included: boolean;
  /** Rung as an amount to its department, with no item (ADR 0046). */
  is_department: boolean;
  /** This line's share of the ticket's basket discount (ADR 0048), on top of its own discount. */
  basket_cash_cents: Cents;
  basket_card_cents: Cents;
}

export interface FoldedTender {
  tender_id: string;
  tender_type: TenderType;
  /** Check number or other tender's reference, and which other tender (ADR 0050). */
  reference: string | null;
  other_kind: (typeof OTHER_TENDER_KINDS)[number] | null;
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
  /** A sale, or a return rung without a receipt (ADR 0051), with why. */
  kind: 'sale' | 'return';
  return_reason: string | null;
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
  /** Customer language at payment and the digital receipt token (P18), from sale.completed. */
  language: Lang | null;
  receipt_token: string | null;
  /** Who the sale was for, when the customer typed their number (P19a): a keyed hash, never the number. */
  customer: { ref: string; last4: string; marketing_opt_in: boolean } | null;
  /** A loyalty reward used on this ticket. */
  loyalty: { cost: number; discount_cents: number } | null;
  /** The ticket is tax-free (ADR 0049): why, and the buyer's certificate. */
  tax_exempt: { reason: string | null; certificate: string | null } | null;
  /** The whole-ticket discount (ADR 0048) and what it takes off in each price mode. */
  basket: (BasketDiscount & { cash_cents: Cents; card_cents: Cents }) | null;
}

export function toTaxable(lines: FoldedLine[], mode: PriceMode): TaxableLine[] {
  return lines.map((l) => ({
    qty: l.qty,
    unit_price_cents: mode === 'cash' ? l.unit_cash_price_cents : l.unit_card_price_cents,
    discount_cents: lineDiscount(l, mode),
    taxable: l.taxable,
    tax_rate_ppm: l.tax_rate_ppm,
    charges: l.charges.map((c) => ({ unit_cents: mode === 'cash' ? c.unit_cash_cents : c.unit_card_cents, taxable: c.taxable })),
    tax_included: l.tax_included,
  }));
}

/** Everything off a line in a price mode: its own discount (promotion, reward) plus its basket share. */
export function lineDiscount(l: FoldedLine, mode: PriceMode): Cents {
  return mode === 'cash' ? add(l.cash_discount_cents, l.basket_cash_cents) : add(l.card_discount_cents, l.basket_card_cents);
}

/**
 * One line before tax in a price mode: price × qty − discount + per-unit charges × qty, with the tax
 * taken out of a tax-inclusive price (ADR 0044). What category sales add up.
 */
export function lineTotal(line: FoldedLine, mode: PriceMode): Cents {
  return computeTotals(toTaxable([line], mode)).subtotal_cents;
}

/**
 * One line as the ticket shows it: at its marked price (a tax-inclusive price keeps its tax), less
 * its own discount. A basket discount (ADR 0048) is shown once, as its own row, so it is not taken
 * off here.
 */
export function lineAmount(line: FoldedLine, mode: PriceMode): Cents {
  const t = toTaxable([line], mode)[0]!;
  return lineNet({ ...t, discount_cents: mode === 'cash' ? line.cash_discount_cents : line.card_discount_cents });
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
  let language: Lang | null = null;
  let receiptToken: string | null = null;
  let customer = null as FoldedSale['customer'];
  let loyalty = null as FoldedSale['loyalty'];
  let basket: BasketDiscount | null = null;
  let exempt: FoldedSale['tax_exempt'] = null;
  let kind: FoldedSale['kind'] = 'sale';
  let returnReason: string | null = null;
  let refunded: Cents = ZERO;
  const refundedQty: Record<string, number> = {};

  for (const e of ordered) {
    if (seen.has(e.event_id)) continue;
    seen.add(e.event_id);
    switch (e.type) {
      case 'sale.opened':
        kind = e.payload.kind ?? 'sale';
        returnReason = e.payload.reason ?? null;
        break;
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
          tax_included: p.tax_included ?? false,
          is_department: p.price_source === 'department',
          basket_cash_cents: ZERO,
          basket_card_cents: ZERO,
          category_id: p.category_id ?? null,
          discount_reason: null,
          discount_promo_id: null,
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
          line.discount_reason = e.payload.cash_discount_cents || e.payload.card_discount_cents ? e.payload.reason : null;
          line.discount_promo_id = e.payload.cash_discount_cents || e.payload.card_discount_cents ? (e.payload.promo_id ?? null) : null;
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
          // Only a card can be declined; cash, a check or another tender is taken as handed over.
          approved: p.tender_type !== 'card' || p.card?.status === 'approved',
          reference: p.reference ?? null,
          other_kind: p.other_kind ?? null,
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
          ...(e.payload.included_tax_cents !== undefined ? { included_tax_cents: cents(e.payload.included_tax_cents) } : {}),
        };
        language = e.payload.language ?? null;
        receiptToken = e.payload.receipt_token ?? null;
        break;
      case 'sale.voided':
        status = 'voided';
        break;
      case 'sale.refunded':
        refunded = add(refunded, cents(e.payload.amount_cents));
        // A return ticket's money going back is what closes it, at the cash price.
        if (kind === 'return') {
          status = 'returned';
          priceMode = 'cash';
        }
        for (const l of e.payload.lines) refundedQty[l.line_id] = (refundedQty[l.line_id] ?? 0) + l.qty;
        break;
      case 'sale.suspended':
        if (status === 'open') status = 'suspended';
        break;
      case 'sale.resumed':
        if (status === 'suspended') status = 'open';
        break;
      case 'sale.customer_identified':
        customer = { ref: e.payload.customer_ref, last4: e.payload.last4, marketing_opt_in: e.payload.marketing_opt_in };
        break;
      case 'sale.tax_exempted':
        exempt = e.payload.exempt ? { reason: e.payload.reason, certificate: e.payload.certificate } : null;
        break;
      case 'sale.basket_discounted':
        basket = isEmptyBasket(e.payload) ? null : { kind: e.payload.kind, percent_ppm: e.payload.percent_ppm, amount_cents: e.payload.amount_cents, reason: e.payload.reason };
        break;
      case 'sale.loyalty_redeemed':
        loyalty = { cost: (loyalty?.cost ?? 0) + e.payload.cost, discount_cents: (loyalty?.discount_cents ?? 0) + e.payload.discount_cents };
        break;
      default:
        break;
    }
  }

  const active = [...lines.values()];
  // A tax-free ticket (ADR 0049): every line folds untaxed, and a tax-inclusive price drops to its price
  // before tax, so the buyer pays neither added nor hidden tax. The events keep what was rung.
  if (exempt) {
    for (const l of active) {
      if (l.taxable && l.tax_included && l.tax_rate_ppm > 0) {
        l.unit_cash_price_cents = sub(l.unit_cash_price_cents, includedTaxHalfUp(l.unit_cash_price_cents, l.tax_rate_ppm));
        l.unit_card_price_cents = sub(l.unit_card_price_cents, includedTaxHalfUp(l.unit_card_price_cents, l.tax_rate_ppm));
      }
      l.taxable = false;
      l.tax_included = false;
      l.charges = l.charges.map((c) => ({ ...c, taxable: false }));
    }
  }
  // The basket discount over the goods (never a fee line or a deposit), after each line's own discount.
  const goods = active.filter((l) => !l.is_fee && l.qty > 0);
  const shares = spreadBasket(
    basket,
    goods.map((l) => ({
      line_id: l.line_id,
      cash_cents: Math.max(0, l.unit_cash_price_cents * l.qty - l.cash_discount_cents),
      card_cents: Math.max(0, l.unit_card_price_cents * l.qty - l.card_discount_cents),
    })),
  );
  for (const l of active) {
    const share = shares.get(l.line_id);
    l.basket_cash_cents = cents(share?.cash ?? 0);
    l.basket_card_cents = cents(share?.card ?? 0);
  }
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
        : t.tender_type !== 'card'
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
    kind,
    return_reason: returnReason,
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
    language,
    receipt_token: receiptToken,
    customer,
    loyalty,
    tax_exempt: exempt,
    basket: basket
      ? { ...basket, cash_cents: sum(active.map((l) => l.basket_cash_cents)), card_cents: sum(active.map((l) => l.basket_card_cents)) }
      : null,
  };
}

/** Net money a completed sale brought in (after refunds); what a return paid out, negative; zero otherwise. */
export function saleNetCents(sale: FoldedSale): Cents {
  if (sale.status === 'returned') return cents(-sale.refunded_cents);
  if (sale.status !== 'completed') return ZERO;
  return sub(sale.paid_cents, sale.refunded_cents);
}
