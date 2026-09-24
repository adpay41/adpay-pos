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
  /**
   * Per-unit charges on the line in this price mode (P10: deposit, excise, fee). They are part of
   * what the customer pays; `taxable` ones are also part of the item's sales-tax base.
   */
  charges?: readonly { unit_cents: number; taxable: boolean }[];
}

const perUnit = (line: TaxableLine, onlyTaxable: boolean): Cents =>
  cents((line.charges ?? []).filter((c) => !onlyTaxable || c.taxable).reduce((n, c) => n + c.unit_cents, 0));

/** What the line costs: price × qty − discount + charges × qty. */
export function lineNet(line: TaxableLine): Cents {
  return add(sub(mulQty(cents(line.unit_price_cents), line.qty), cents(line.discount_cents)), mulQty(perUnit(line, false), line.qty));
}

/** The line's sales-tax base: its net price plus its taxable charges; zero for an untaxed item. */
export function lineTaxBase(line: TaxableLine): Cents {
  if (!line.taxable || line.tax_rate_ppm === 0) return cents(0);
  return add(sub(mulQty(cents(line.unit_price_cents), line.qty), cents(line.discount_cents)), mulQty(perUnit(line, true), line.qty));
}

/**
 * Tax is computed on the taxable subtotal of each rate group and rounded once per group — not per
 * line — which is how NJ and NY compute tax on a receipt and avoids per-line rounding drift.
 */
export function computeTax(lines: readonly TaxableLine[]): Cents {
  return sum(taxByRate(lines).map((g) => g.tax_cents));
}

/**
 * Tax per rate group, in rate order: what the receipt itemizes (Bible 1.6 "itemized tax"). The
 * groups add up to `computeTax` exactly, because that is how it is computed.
 */
export function taxByRate(lines: readonly TaxableLine[]): { rate_ppm: number; taxable_cents: Cents; tax_cents: Cents }[] {
  const byRate = new Map<number, Cents[]>();
  for (const line of lines) {
    if (!line.taxable || line.tax_rate_ppm === 0) continue;
    const bucket = byRate.get(line.tax_rate_ppm) ?? [];
    bucket.push(lineTaxBase(line));
    byRate.set(line.tax_rate_ppm, bucket);
  }
  return [...byRate.entries()]
    .sort(([a], [b]) => a - b)
    .map(([rate_ppm, nets]) => {
      const taxable_cents = sum(nets);
      return { rate_ppm, taxable_cents, tax_cents: applyRateHalfUp(taxable_cents, rate_ppm) };
    });
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
