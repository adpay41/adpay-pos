/**
 * Dual pricing and tax. Merchants post two prices for every item — cash and card — and the customer
 * screen shows both before tender (NJ/NY posted-pricing rules). The card price is derived from the
 * cash price by a per-location percentage unless the item carries an explicit card price.
 */
import { add, applyRateHalfUp, cents, mulQty, sub, sum, type Cents, type RatePpm } from './money';

export type PriceMode = 'cash' | 'card';

/** Card price = cash price + cash price × dual-price rate, rounded half-up once. */
export function deriveCardPrice(cashPrice: Cents, dualPriceRate: RatePpm): Cents {
  return add(cashPrice, applyRateHalfUp(cashPrice, dualPriceRate));
}

export interface ItemPriceInput {
  cash_price_cents: number;
  /** Explicit card price; when null the location's dual-price rate derives it. */
  card_price_cents: number | null;
}

export interface DualPrice {
  cash: Cents;
  card: Cents;
}

export function resolveDualPrice(item: ItemPriceInput, dualPriceRate: RatePpm): DualPrice {
  const cash = cents(item.cash_price_cents);
  const card = item.card_price_cents === null ? deriveCardPrice(cash, dualPriceRate) : cents(item.card_price_cents);
  return { cash, card };
}

export interface TaxableLine {
  qty: number;
  unit_price_cents: number;
  discount_cents: number;
  taxable: boolean;
  tax_rate_ppm: number;
}

export function lineNet(line: TaxableLine): Cents {
  return sub(mulQty(cents(line.unit_price_cents), line.qty), cents(line.discount_cents));
}

/**
 * Tax is computed on the taxable subtotal of each rate group and rounded once per group — not per
 * line — which is how NJ and NY compute tax on a receipt and avoids per-line rounding drift.
 */
export function computeTax(lines: readonly TaxableLine[]): Cents {
  const byRate = new Map<number, Cents[]>();
  for (const line of lines) {
    if (!line.taxable || line.tax_rate_ppm === 0) continue;
    const bucket = byRate.get(line.tax_rate_ppm) ?? [];
    bucket.push(lineNet(line));
    byRate.set(line.tax_rate_ppm, bucket);
  }
  const taxes: Cents[] = [];
  for (const [rate, nets] of byRate) taxes.push(applyRateHalfUp(sum(nets), rate));
  return sum(taxes);
}

export interface Totals {
  subtotal_cents: Cents;
  tax_cents: Cents;
  total_cents: Cents;
}

export function computeTotals(lines: readonly TaxableLine[]): Totals {
  const subtotal = sum(lines.map(lineNet));
  const tax = computeTax(lines);
  return { subtotal_cents: subtotal, tax_cents: tax, total_cents: add(subtotal, tax) };
}
