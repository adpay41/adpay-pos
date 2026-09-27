/**
 * Dual pricing and tax. Merchants post two prices for every item — cash and card — and the customer
 * screen shows both before tender (NJ/NY posted-pricing rules). The card price is derived from the
 * cash price by a per-location percentage unless the item carries an explicit card price.
 */
import { add, applyRateHalfUp, cents, includedTaxHalfUp, mulQty, sub, sum, type Cents, type RatePpm } from './money';

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
  /**
   * The price already contains the sales tax (ADR 0044): the line rings at its marked price and the
   * tax is backed out of it. Per-unit charges on the line are still added on top. Absent = false.
   */
  tax_included?: boolean;
}

const perUnit = (line: TaxableLine, onlyTaxable: boolean): Cents =>
  cents((line.charges ?? []).filter((c) => !onlyTaxable || c.taxable).reduce((n, c) => n + c.unit_cents, 0));

/** What the line costs: price × qty − discount + charges × qty. */
export function lineNet(line: TaxableLine): Cents {
  return add(sub(mulQty(cents(line.unit_price_cents), line.qty), cents(line.discount_cents)), mulQty(perUnit(line, false), line.qty));
}

/** The goods part of a line: price × qty − discount (no charges). */
const goods = (line: TaxableLine): Cents => sub(mulQty(cents(line.unit_price_cents), line.qty), cents(line.discount_cents));

/**
 * The part of the line tax is added on top of: its net price plus its taxable charges, or only the
 * taxable charges when the price already includes the tax; zero for an untaxed item.
 */
export function lineTaxBase(line: TaxableLine): Cents {
  if (!line.taxable || line.tax_rate_ppm === 0) return cents(0);
  const charges = mulQty(perUnit(line, true), line.qty);
  return line.tax_included ? charges : add(goods(line), charges);
}

/** The part of the line that already contains its tax (a tax-inclusive price, ADR 0044); else zero. */
export function lineTaxInclusiveGross(line: TaxableLine): Cents {
  if (!line.taxable || line.tax_rate_ppm === 0 || !line.tax_included) return cents(0);
  return goods(line);
}

/**
 * Tax is computed on the taxable subtotal of each rate group and rounded once per group — not per
 * line — which is how NJ and NY compute tax on a receipt and avoids per-line rounding drift.
 */
export function computeTax(lines: readonly TaxableLine[]): Cents {
  return sum(taxByRate(lines).map((g) => g.tax_cents));
}

export interface TaxGroup {
  rate_ppm: number;
  /** The pre-tax amount taxed at this rate (tax-inclusive prices with their tax taken out). */
  taxable_cents: Cents;
  /** All the tax at this rate: added on top plus contained in tax-inclusive prices. */
  tax_cents: Cents;
  /** The part of `tax_cents` that was inside tax-inclusive prices (ADR 0044). */
  included_tax_cents: Cents;
  /** The part of `taxable_cents` tax was added on top of. */
  added_base_cents: Cents;
}

/**
 * Tax per rate group, in rate order: what the receipt itemizes (Bible 1.6 "itemized tax"). The
 * groups add up to `computeTax` exactly, because that is how it is computed.
 *
 * Within a group, tax added on top is rounded once on the summed base, as before. Tax inside
 * tax-inclusive prices (ADR 0044) is backed out once on the summed marked prices: base = gross ÷
 * (1 + rate) half-up, tax = gross − base. So the customer pays exactly the marked prices.
 */
export function taxByRate(lines: readonly TaxableLine[]): TaxGroup[] {
  const byRate = new Map<number, { added: Cents[]; inclusive: Cents[] }>();
  for (const line of lines) {
    if (!line.taxable || line.tax_rate_ppm === 0) continue;
    const bucket = byRate.get(line.tax_rate_ppm) ?? { added: [], inclusive: [] };
    bucket.added.push(lineTaxBase(line));
    bucket.inclusive.push(lineTaxInclusiveGross(line));
    byRate.set(line.tax_rate_ppm, bucket);
  }
  return [...byRate.entries()]
    .sort(([a], [b]) => a - b)
    .map(([rate_ppm, b]) => {
      const addedBase = sum(b.added);
      const gross = sum(b.inclusive);
      const included = includedTaxHalfUp(gross, rate_ppm);
      const addedTax = applyRateHalfUp(addedBase, rate_ppm);
      return { rate_ppm, taxable_cents: add(addedBase, sub(gross, included)), tax_cents: add(addedTax, included), included_tax_cents: included, added_base_cents: addedBase };
    });
}

/**
 * A ticket's totals. **total = subtotal + tax** always: `subtotal_cents` is before all tax (a
 * tax-inclusive price with its tax taken out) and `tax_cents` is all the tax, so the books, the Z and
 * the tax report read them as before. `included_tax_cents` is the part of the tax that was inside
 * marked prices: the receipt shows those prices as marked and "includes tax" instead of adding it.
 */
export interface Totals {
  subtotal_cents: Cents;
  tax_cents: Cents;
  total_cents: Cents;
  /** Absent on totals from before ADR 0044 (zero). */
  included_tax_cents?: Cents;
}

export function computeTotals(lines: readonly TaxableLine[]): Totals {
  const marked = sum(lines.map(lineNet));
  const groups = taxByRate(lines);
  const tax = sum(groups.map((g) => g.tax_cents));
  const included = sum(groups.map((g) => g.included_tax_cents));
  const subtotal = sub(marked, included);
  return { subtotal_cents: subtotal, tax_cents: tax, total_cents: add(subtotal, tax), included_tax_cents: included };
}

/**
 * How a ticket's totals read to the customer (ADR 0044): the items at their marked prices, the tax
 * added on top of them, and the tax that was already inside the marked prices.
 */
export function shownTotals(t: Totals): { items_cents: Cents; added_tax_cents: Cents; included_tax_cents: Cents; total_cents: Cents } {
  const included = t.included_tax_cents ?? cents(0);
  return { items_cents: add(t.subtotal_cents, included), added_tax_cents: sub(t.tax_cents, included), included_tax_cents: included, total_cents: t.total_cents };
}

/** Tax contained in one line's marked goods price, backed out on its own (line-level reports). */
export function lineIncludedTax(line: TaxableLine): Cents {
  return includedTaxHalfUp(lineTaxInclusiveGross(line), line.tax_rate_ppm);
}
