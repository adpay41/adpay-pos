/**
 * Split tender with dual pricing per portion (build plan P9, Bible 1.1 L8: "cash + card, two cards,
 * with correct dual pricing per portion"). ADR 0017.
 *
 * A sale has a cash total C and a card total K (K ≥ C: the card price). Every tender covers part
 * of the sale, measured in **cash-price cents**:
 *   - cash paid `a` covers `a` (capped at what's left);
 *   - a card charge `a` covers `a × C / K`, rounded half-up once.
 * What is left, R, is always a cash-price amount. Paying R in cash costs R; paying R by card costs
 * `R × K / C`, rounded half-up. Finishing on either tender therefore closes the sale exactly, and a
 * customer never pays the card surcharge on the part they paid in cash.
 *
 * All integer arithmetic; the one rounding per conversion is half-up, as everywhere else (ADR 0004).
 */
import { cents, type Cents } from './money';
import type { Totals } from './pricing';

/** round(n / d) half-up, for non-negative integers. */
function divHalfUp(n: number, d: number): number {
  return Math.floor((2 * n + d) / (2 * d));
}

/** Card amount that pays off `remainingCash` cash-price cents of a sale priced C cash / K card. */
export function cardAmountFor(remainingCash: number, cashTotal: number, cardTotal: number): Cents {
  if (remainingCash <= 0 || cashTotal <= 0) return cents(0);
  if (remainingCash >= cashTotal) return cents(cardTotal);
  return cents(divHalfUp(remainingCash * cardTotal, cashTotal));
}

/** Cash-price cents a card charge of `cardAmount` covers (capped at what is left). */
export function coverForCard(cardAmount: number, remainingCash: number, cashTotal: number, cardTotal: number): Cents {
  if (cardTotal <= 0) return cents(0);
  // Paying exactly the card price of what's left covers all of it, whatever the rounding.
  if (cardAmount >= cardAmountFor(remainingCash, cashTotal, cardTotal)) return cents(remainingCash);
  return cents(Math.min(remainingCash, divHalfUp(cardAmount * cashTotal, cardTotal)));
}

export interface TenderPortion {
  tender_type: 'cash' | 'card';
  amount_cents: number;
  covers_cash_cents: number;
}

/**
 * What a split sale declares at completion: the money actually taken, with the tax split the same
 * way (cash-price tax on the cash-covered share, card-price tax on the card-covered share).
 */
export function splitTotals(cash: Totals, card: Totals, portions: readonly TenderPortion[]): Totals {
  const total = portions.reduce((n, p) => n + p.amount_cents, 0);
  const cashCover = portions.filter((p) => p.tender_type === 'cash').reduce((n, p) => n + p.covers_cash_cents, 0);
  const cardCover = portions.filter((p) => p.tender_type === 'card').reduce((n, p) => n + p.covers_cash_cents, 0);
  const C = cash.total_cents;
  const tax = C > 0 ? divHalfUp(cash.tax_cents * cashCover + card.tax_cents * cardCover, C) : 0;
  return { subtotal_cents: cents(total - tax), tax_cents: cents(tax), total_cents: cents(total) };
}

export interface RateGroup {
  rate_ppm: number;
  taxable_cents: Cents;
  tax_cents: Cents;
}

/**
 * The receipt's tax-by-rate lines for a split sale. Each rate is blended like `splitTotals`
 * (cash-price groups weighted by the cash-covered share, card-price groups by the card-covered
 * share), and any rounding drift goes on the largest group, so the lines add up to the declared tax.
 */
export function splitTaxGroups(
  cashGroups: readonly RateGroup[],
  cardGroups: readonly RateGroup[],
  portions: readonly TenderPortion[],
  cashTotal: number,
  declaredTax: number,
): RateGroup[] {
  if (cashTotal <= 0) return [];
  const cashCover = portions.filter((p) => p.tender_type === 'cash').reduce((n, p) => n + p.covers_cash_cents, 0);
  const cardCover = portions.filter((p) => p.tender_type === 'card').reduce((n, p) => n + p.covers_cash_cents, 0);
  const blend = (a: number, b: number) => divHalfUp(a * cashCover + b * cardCover, cashTotal);
  const out = cashGroups.map((g) => {
    const k = cardGroups.find((c) => c.rate_ppm === g.rate_ppm) ?? g;
    return { rate_ppm: g.rate_ppm, taxable_cents: cents(blend(g.taxable_cents, k.taxable_cents)), tax_cents: cents(blend(g.tax_cents, k.tax_cents)) };
  });
  const drift = declaredTax - out.reduce((n, g) => n + g.tax_cents, 0);
  if (drift !== 0 && out.length > 0) {
    const big = out.reduce((a, b) => (b.tax_cents > a.tax_cents ? b : a));
    big.tax_cents = cents(Math.max(0, big.tax_cents + drift));
  }
  return out;
}
