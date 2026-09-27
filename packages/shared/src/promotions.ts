/**
 * Promotions (Bible 2.3 "2 for $5, mix and match, buy X get Y, happy hour, with start/end and per
 * store"; build plan P20a, ADR 0031).
 *
 * A promotion becomes line discounts on the ticket, recomputed by the register whenever the ticket
 * changes, and written as ordinary `sale.line_discounted` events carrying the promotion's id. The sale
 * stays a fold of its events: a receipt or report weeks later sees exactly what was given. Lines with
 * a discount from anything else (a manual discount, a loyalty reward) are left alone.
 *
 * Prices stay dual (ADR 0004): the promotional price is set in cash cents; the card side derives from
 * it with the location's dual-price rate, like any card price.
 */
import { z } from 'zod';
import type { FoldedLine, FoldedSale } from './fold';
import { applyRateHalfUp, cents, type Cents } from './money';
import { deriveCardPrice } from './pricing';

export const PromotionRule = z.discriminatedUnion('kind', [
  /** "2 for $5": any N qualifying units (mix and match) for a group price, in cash cents. */
  z.strictObject({ kind: z.literal('multi_price'), qty: z.int().min(2).max(24), price_cents: z.int().min(1).max(100_000) }),
  /** "Buy 1 get 1 free", "buy 2 get 1 half off": in each block of buy+get, the cheapest `get` units. */
  z.strictObject({ kind: z.literal('buy_get'), buy: z.int().min(1).max(12), get: z.int().min(1).max(12), percent_off: z.int().min(1).max(100) }),
  /** "Happy hour: 20% off": every qualifying unit, usually with a time window. */
  z.strictObject({ kind: z.literal('percent_off'), percent_off: z.int().min(1).max(90) }),
]);
export type PromotionRule = z.infer<typeof PromotionRule>;

const Hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const PromotionInput = z
  .strictObject({
    name: z.string().trim().min(2).max(48),
    rule: PromotionRule,
    /** What qualifies: these items and/or every item in these categories. */
    item_ids: z.array(z.uuid()).max(500).default([]),
    category_ids: z.array(z.uuid()).max(50).default([]),
    /** Null = every store of the merchant. */
    location_ids: z.array(z.uuid()).max(50).nullable().default(null),
    starts_on: Day,
    ends_on: Day.nullable().default(null),
    /** 0 = Sunday … 6 = Saturday; null = every day. */
    days: z.array(z.int().min(0).max(6)).min(1).max(7).nullable().default(null),
    /** Store-local time window, e.g. 15:00–18:00 for a happy hour; null = all day. */
    start_time: Hhmm.nullable().default(null),
    end_time: Hhmm.nullable().default(null),
    /** Show it on the customer screen while idle ("deals of the day", Bible 1.5). */
    show_on_idle: z.boolean().default(true),
  })
  .refine((p) => p.item_ids.length + p.category_ids.length > 0, { message: 'Pick at least one item or category', path: ['item_ids'] })
  .refine((p) => p.ends_on === null || p.ends_on >= p.starts_on, { message: 'The end date is before the start', path: ['ends_on'] })
  .refine((p) => (p.start_time === null) === (p.end_time === null), { message: 'Give both a start and an end time, or neither', path: ['end_time'] });
export type PromotionInput = z.infer<typeof PromotionInput>;

export interface Promotion extends PromotionInput {
  promo_id: string;
  active: boolean;
}

/** The customer-facing line: "2 for $5.00 · Red Bull", "Buy 1 get 1 free". */
export function promotionText(p: Pick<Promotion, 'name' | 'rule'>): string {
  const d = (c: number) => `$${Math.trunc(c / 100)}.${String(c % 100).padStart(2, '0')}`;
  const r = p.rule;
  const deal =
    r.kind === 'multi_price'
      ? `${r.qty} for ${d(r.price_cents)}`
      : r.kind === 'buy_get'
        ? `Buy ${r.buy} get ${r.get} ${r.percent_off === 100 ? 'free' : `${r.percent_off}% off`}`
        : `${r.percent_off}% off`;
  return deal === p.name ? deal : `${deal} · ${p.name}`;
}

/** Whether a promotion runs at this store-local moment. */
export function promotionActive(p: Promotion, locationId: string, local: { date: string; weekday: number; hhmm: string }): boolean {
  if (!p.active) return false;
  if (p.location_ids && !p.location_ids.includes(locationId)) return false;
  if (local.date < p.starts_on || (p.ends_on && local.date > p.ends_on)) return false;
  if (p.days && !p.days.includes(local.weekday)) return false;
  if (p.start_time && p.end_time) {
    const inside = p.start_time <= p.end_time ? local.hhmm >= p.start_time && local.hhmm < p.end_time : local.hhmm >= p.start_time || local.hhmm < p.end_time;
    if (!inside) return false;
  }
  return true;
}

/** Store-local date, weekday and HH:MM for a moment. */
export function localMoment(at: Date, timeZone: string): { date: string; weekday: number; hhmm: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(at)
      .map((x) => [x.type, x.value]),
  );
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday!);
  return { date: `${parts.year}-${parts.month}-${parts.day}`, weekday, hhmm: `${parts.hour}:${parts.minute}` };
}

export interface PromoDiscount {
  line_id: string;
  cash_discount_cents: number;
  card_discount_cents: number;
  promo_id: string;
  name: string;
}

interface Unit {
  line: FoldedLine;
  cash: number;
  card: number;
}

/** Split `total` across lines in proportion to `weights`, largest remainder, so the parts add up exactly. */
function split(total: number, weights: number[]): number[] {
  const w = weights.reduce((a, b) => a + b, 0);
  if (w === 0) return weights.map(() => 0);
  const raw = weights.map((x) => (total * x) / w);
  const out = raw.map(Math.floor);
  let left = total - out.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => [r - Math.floor(r), i] as const).sort((a, b) => b[0] - a[0]);
  for (const [, i] of order) {
    if (left <= 0) break;
    out[i]!++;
    left--;
  }
  return out;
}

/**
 * The discounts the running promotions give this ticket. Each unit counts toward at most one
 * promotion (the first that uses it, in the order given). Lines already discounted by something
 * other than a promotion are skipped.
 */
export function applyPromotions(
  promotions: readonly Promotion[],
  sale: FoldedSale,
  ctx: { location_id: string; at: Date; timezone: string; dual_price_rate_ppm: number },
): PromoDiscount[] {
  const local = localMoment(ctx.at, ctx.timezone);
  const free = sale.lines.filter((l) => !l.is_fee && l.qty > 0 && (l.discount_promo_id !== null || (l.cash_discount_cents === 0 && l.card_discount_cents === 0)));
  const used = new Map<string, number>(); // line_id → units already in a promotion
  const out = new Map<string, PromoDiscount>();
  const add = (line: FoldedLine, cashOff: number, cardOff: number, p: Promotion) => {
    const cur = out.get(line.line_id);
    out.set(line.line_id, {
      line_id: line.line_id,
      cash_discount_cents: (cur?.cash_discount_cents ?? 0) + cashOff,
      card_discount_cents: (cur?.card_discount_cents ?? 0) + cardOff,
      promo_id: cur?.promo_id ?? p.promo_id,
      name: cur?.name ?? p.name,
    });
  };

  for (const p of promotions) {
    if (!promotionActive(p, ctx.location_id, local)) continue;
    const qualifies = (l: FoldedLine) => (l.item_id !== null && p.item_ids.includes(l.item_id)) || (l.category_id !== null && p.category_ids.includes(l.category_id));
    // One entry per available unit, most expensive first: groups favor the customer.
    const units: Unit[] = [];
    for (const l of free) {
      if (!qualifies(l)) continue;
      const left = l.qty - (used.get(l.line_id) ?? 0);
      for (let i = 0; i < left; i++) units.push({ line: l, cash: l.unit_cash_price_cents, card: l.unit_card_price_cents });
    }
    units.sort((a, b) => b.cash - a.cash);
    const take = (u: Unit) => used.set(u.line.line_id, (used.get(u.line.line_id) ?? 0) + 1);
    const r = p.rule;

    if (r.kind === 'multi_price') {
      const promoCard = deriveCardPrice(cents(r.price_cents), ctx.dual_price_rate_ppm);
      for (let g = 0; g + r.qty <= units.length; g += r.qty) {
        const group = units.slice(g, g + r.qty);
        const cashOff = group.reduce((n, u) => n + u.cash, 0) - r.price_cents;
        const cardOff = group.reduce((n, u) => n + u.card, 0) - promoCard;
        if (cashOff <= 0) continue; // the deal would cost the customer more: skip it
        const cashParts = split(cashOff, group.map((u) => u.cash));
        const cardParts = split(Math.max(0, cardOff), group.map((u) => u.card));
        group.forEach((u, i) => {
          take(u);
          add(u.line, cashParts[i]!, cardParts[i]!, p);
        });
      }
    } else if (r.kind === 'buy_get') {
      const block = r.buy + r.get;
      for (let g = 0; g + block <= units.length; g += block) {
        const group = units.slice(g, g + block);
        group.forEach(take);
        // The cheapest `get` in the block (the list is sorted high → low).
        for (const u of group.slice(r.buy)) add(u.line, applyRateHalfUp(cents(u.cash), r.percent_off * 10_000), applyRateHalfUp(cents(u.card), r.percent_off * 10_000), p);
      }
    } else {
      for (const u of units) {
        take(u);
        add(u.line, applyRateHalfUp(cents(u.cash), r.percent_off * 10_000), applyRateHalfUp(cents(u.card), r.percent_off * 10_000), p);
      }
    }
  }
  return [...out.values()];
}

/**
 * What the register must write to bring the ticket to `wanted`: a discount per changed line, and a
 * reset for a promotion's line that no longer qualifies (e.g. one of a pair was removed).
 */
export function promotionChanges(
  sale: FoldedSale,
  wanted: readonly PromoDiscount[],
): { line_id: string; cash_discount_cents: number; card_discount_cents: number; promo_id: string | null; reason: string | null }[] {
  const byLine = new Map(wanted.map((w) => [w.line_id, w]));
  const changes: { line_id: string; cash_discount_cents: number; card_discount_cents: number; promo_id: string | null; reason: string | null }[] = [];
  for (const l of sale.lines) {
    const w = byLine.get(l.line_id);
    if (w) {
      if (w.cash_discount_cents !== l.cash_discount_cents || w.card_discount_cents !== l.card_discount_cents || w.promo_id !== l.discount_promo_id) {
        changes.push({ line_id: l.line_id, cash_discount_cents: w.cash_discount_cents, card_discount_cents: w.card_discount_cents, promo_id: w.promo_id, reason: `Promo: ${w.name}` });
      }
    } else if (l.discount_promo_id !== null) {
      changes.push({ line_id: l.line_id, cash_discount_cents: 0, card_discount_cents: 0, promo_id: null, reason: null });
    }
  }
  return changes;
}

/** Total promotional savings on a folded sale, in its price mode's terms (cash side). */
export function promoSavings(sale: FoldedSale): Cents {
  return cents(sale.lines.filter((l) => l.discount_promo_id !== null).reduce((n, l) => n + l.cash_discount_cents, 0));
}
