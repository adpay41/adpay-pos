/**
 * Basket discount (NRS gap, ADR 0048): one discount on the whole ticket, a percent or an amount, with
 * a reason. It is one event (`sale.basket_discounted`; the latest wins, an empty one removes it) and
 * the fold spreads it over the lines, after their own promotions and rewards, so tax, refunds, the Z,
 * the tax report and profit all see each line's share, and it follows the ticket as lines change.
 *
 * The spread is by each line's goods net (price × qty − its own discount; deposits and fee lines are
 * never discounted), largest remainder first, so the shares add up to the discount exactly. An amount
 * off is in cash-price cents; at the card price it is scaled by card goods ÷ cash goods, so paying by
 * card never gets a bigger discount than paying cash.
 */
import { applyRateHalfUp, cents, type RatePpm } from './money';

export interface BasketDiscount {
  kind: 'percent' | 'amount';
  /** For `percent`: parts per million (10% = 100 000). */
  percent_ppm: number | null;
  /** For `amount`: cash-price cents off the ticket. */
  amount_cents: number | null;
  reason: string | null;
}

export interface BasketBase {
  line_id: string;
  cash_cents: number;
  card_cents: number;
}

/** round(n / d) half-up, for non-negative integers. */
const divHalfUp = (n: number, d: number) => Math.floor((2 * n + d) / (2 * d));

/** Spread `target` over `bases` in proportion, largest remainder first (ties: earlier line). */
function spread(target: number, bases: readonly number[]): number[] {
  const total = bases.reduce((n, b) => n + b, 0);
  if (target <= 0 || total <= 0) return bases.map(() => 0);
  const t = Math.min(target, total);
  const floors = bases.map((b) => Math.floor((t * b) / total));
  let left = t - floors.reduce((n, f) => n + f, 0);
  const order = bases.map((b, i) => ({ i, frac: (t * b) % total })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    if (floors[i]! < bases[i]!) {
      floors[i]!++;
      left--;
    }
  }
  return floors;
}

/** The discount off the ticket in each price mode. */
export function basketTargets(d: BasketDiscount, cashGoods: number, cardGoods: number): { cash: number; card: number } {
  if (d.kind === 'percent') {
    const ppm = Math.min(1_000_000, Math.max(0, d.percent_ppm ?? 0)) as RatePpm;
    return { cash: applyRateHalfUp(cents(cashGoods), ppm), card: applyRateHalfUp(cents(cardGoods), ppm) };
  }
  const amount = Math.min(Math.max(0, d.amount_cents ?? 0), cashGoods);
  return { cash: amount, card: cashGoods > 0 ? Math.min(cardGoods, divHalfUp(amount * cardGoods, cashGoods)) : 0 };
}

/** Each line's share of the basket discount, in both price modes. */
export function spreadBasket(d: BasketDiscount | null, lines: readonly BasketBase[]): Map<string, { cash: number; card: number }> {
  const out = new Map<string, { cash: number; card: number }>();
  if (!d) return out;
  const cashGoods = lines.reduce((n, l) => n + l.cash_cents, 0);
  const cardGoods = lines.reduce((n, l) => n + l.card_cents, 0);
  const target = basketTargets(d, cashGoods, cardGoods);
  const cash = spread(target.cash, lines.map((l) => l.cash_cents));
  const card = spread(target.card, lines.map((l) => l.card_cents));
  lines.forEach((l, i) => out.set(l.line_id, { cash: cash[i]!, card: card[i]! }));
  return out;
}

/** A discount that takes nothing off is no discount. */
export function isEmptyBasket(d: BasketDiscount): boolean {
  return d.kind === 'percent' ? !d.percent_ppm : !d.amount_cents;
}
