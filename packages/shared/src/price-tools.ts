/**
 * Bulk price changes and profit (Bible 2.2 "profit, not just sales", 2.3 "bulk price change";
 * build plan P20b, ADR 0032). Integer cents throughout: a percentage is parts per million.
 */
import { z } from 'zod';
import type { FoldedSale } from './fold';
import { applyRateHalfUp, cents } from './money';
import { lineIncludedTax } from './pricing';

export const BulkPriceInput = z
  .strictObject({
    /** What to change: whole categories and/or chosen items. */
    category_ids: z.array(z.uuid()).max(100).default([]),
    item_ids: z.array(z.uuid()).max(2000).default([]),
    change: z.discriminatedUnion('kind', [
      /** "+5% on all drinks": parts per million, −50% … +200%. */
      z.strictObject({ kind: z.literal('percent'), ppm: z.int().min(-500_000).max(2_000_000).refine((v) => v !== 0, 'A change of 0%') }),
      /** "+25¢ on every sandwich". */
      z.strictObject({ kind: z.literal('amount'), cents: z.int().min(-100_000).max(100_000).refine((v) => v !== 0, 'A change of $0') }),
      /** "Every Red Bull is $3.49". */
      z.strictObject({ kind: z.literal('set'), cents: z.int().min(1).max(10_000_000) }),
    ]),
    /** Round the new cash price up to one ending in 9 cents, or in .99. */
    round: z.enum(['none', 'up_9', 'up_99']).default('none'),
    dry_run: z.boolean().default(true),
  })
  .refine((b) => b.category_ids.length + b.item_ids.length > 0, { message: 'Pick at least one category or item', path: ['category_ids'] });
export type BulkPriceInput = z.infer<typeof BulkPriceInput>;

/** Round a price up to the next one ending in 9 cents (3.43 → 3.49) or .99 (3.43 → 3.99). */
export function roundUpPrice(c: number, round: BulkPriceInput['round']): number {
  if (round === 'up_9') return c % 10 === 9 ? c : c + ((9 - (c % 10) + 10) % 10);
  if (round === 'up_99') return c % 100 === 99 ? c : Math.floor(c / 100) * 100 + 99;
  return c;
}

/** The new cash price for one item; never below 1¢. */
export function adjustPrice(current: number, change: BulkPriceInput['change'], round: BulkPriceInput['round']): number {
  let next: number;
  if (change.kind === 'set') next = change.cents;
  else if (change.kind === 'amount') next = current + change.cents;
  else next = current + (change.ppm >= 0 ? applyRateHalfUp(cents(current), change.ppm) : -applyRateHalfUp(cents(current), -change.ppm));
  return Math.max(1, roundUpPrice(next, round));
}

// --- Profit --------------------------------------------------------------------------------------

export interface MarginLine {
  key: string;
  name: string;
  units: number;
  /** What the customers paid for the goods: price × units − discounts, net of refunds; no deposits or fees. */
  revenue_cents: number;
  /** Cost of the units whose item had a cost when sold. */
  cost_cents: number;
  /** Revenue of those same units: margin is measured on them only. */
  costed_revenue_cents: number;
  units_without_cost: number;
  /** Units sold below their cost. */
  units_below_cost: number;
}

export interface MarginReport {
  from: string;
  to: string;
  total: MarginLine;
  categories: MarginLine[];
  items: MarginLine[];
}

const empty = (key: string, name: string): MarginLine => ({ key, name, units: 0, revenue_cents: 0, cost_cents: 0, costed_revenue_cents: 0, units_without_cost: 0, units_below_cost: 0 });

/**
 * Fold completed sales into revenue and cost by category and item. `costAt(item_id, when)` is the
 * unit cost in force when the sale happened (from the price history), or null when none was entered.
 * Refunded units come off at the price paid; voided sales count for nothing.
 */
export function marginReport(
  sales: readonly (FoldedSale & { occurred_at: string })[],
  costAt: (itemId: string, when: string) => number | null,
  categoryName: (categoryId: string | null) => string,
  range: { from: string; to: string },
): MarginReport {
  const total = empty('total', 'All sales');
  const cats = new Map<string, MarginLine>();
  const items = new Map<string, MarginLine>();
  for (const s of sales) {
    if (s.status !== 'completed') continue;
    const mode = s.price_mode === 'card' ? 'card' : 'cash';
    for (const l of s.lines) {
      if (l.is_fee || l.qty <= 0) continue;
      const kept = l.qty - (s.refunded_qty[l.line_id] ?? 0);
      if (kept <= 0) continue;
      const unit = mode === 'card' ? l.unit_card_price_cents : l.unit_cash_price_cents;
      const discount = mode === 'card' ? l.card_discount_cents : l.cash_discount_cents;
      const marked = unit * l.qty - discount; // goods only, before per-unit charges
      // Revenue is before tax: a tax-inclusive price (ADR 0044) has its tax taken out.
      const gross = marked - lineIncludedTax({ qty: l.qty, unit_price_cents: unit, discount_cents: discount, taxable: l.taxable, tax_rate_ppm: l.tax_rate_ppm, tax_included: l.tax_included });
      const revenue = kept === l.qty ? gross : Math.floor((gross * kept * 2 + l.qty) / (2 * l.qty));
      // A department ring has no item and no cost: it's bucketed under its department (ADR 0046).
      const unitCost = l.item_id ? costAt(l.item_id, s.occurred_at) : null;
      const itemKey = l.item_id ?? `dept:${l.category_id ?? 'none'}`;
      const catKey = l.category_id ?? 'none';
      if (!cats.has(catKey)) cats.set(catKey, empty(catKey, categoryName(l.category_id)));
      if (!items.has(itemKey)) items.set(itemKey, empty(itemKey, l.item_id ? l.name : `${l.name} (department)`));
      for (const m of [total, cats.get(catKey)!, items.get(itemKey)!]) {
        m.units += kept;
        m.revenue_cents += revenue;
        if (unitCost === null) m.units_without_cost += kept;
        else {
          m.cost_cents += unitCost * kept;
          m.costed_revenue_cents += revenue;
          if (revenue < unitCost * kept) m.units_below_cost += kept;
        }
      }
    }
  }
  const byProfit = (a: MarginLine, b: MarginLine) => b.costed_revenue_cents - b.cost_cents - (a.costed_revenue_cents - a.cost_cents) || b.revenue_cents - a.revenue_cents;
  return { ...range, total, categories: [...cats.values()].sort((a, b) => b.revenue_cents - a.revenue_cents), items: [...items.values()].sort(byProfit) };
}

/** Margin as tenths of a percent (313 = 31.3%) on the costed units; null without any. */
export function marginTenths(m: Pick<MarginLine, 'costed_revenue_cents' | 'cost_cents'>): number | null {
  if (m.costed_revenue_cents <= 0) return null;
  const profit = m.costed_revenue_cents - m.cost_cents;
  return Math.round((profit * 1000) / m.costed_revenue_cents);
}
