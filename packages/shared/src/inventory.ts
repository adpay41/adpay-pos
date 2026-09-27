/**
 * Inventory (Bible 1.9, 2.4; build plan P22, ADR 0034). Stock is never a number someone edits: it is
 * folded, per store and item, from counts, receipts, write-offs and the sales themselves.
 *
 * - A **count** sets what is on the shelf at that moment; everything after it moves from there.
 * - A **receipt** adds units; a **write-off** (waste, spoilage, theft, damaged, expired) removes them.
 * - A completed sale removes what it sold; refunded units come back.
 * - **Case-break**: an item can count in another item's units ("a carton is 10 packs"). Stock is kept
 *   on the base item, so selling a carton takes 10 packs and receiving 3 cartons adds 30.
 */
import { z } from 'zod';
import type { FoldedSale } from './fold';

export const WRITE_OFF_REASONS = ['waste', 'spoilage', 'theft', 'damaged', 'expired'] as const;
export type WriteOffReason = (typeof WRITE_OFF_REASONS)[number];

export const ItemStockSettingsInput = z
  .strictObject({
    track_stock: z.boolean(),
    /** Low stock at or below this many (base units). */
    reorder_point: z.int().min(0).max(100_000).nullable().default(null),
    /** Case-break: this item's stock is `stock_ratio` units of another item. */
    stock_of: z.uuid().nullable().default(null),
    stock_ratio: z.int().min(1).max(1_000).default(1),
    /** Perishable: receipts ask for an expiry date; sell-by alerts on the register. */
    perishable: z.boolean().default(false),
  })
  .refine((s) => s.stock_of !== null || s.stock_ratio === 1, { message: 'A pack size needs the item it breaks into', path: ['stock_ratio'] });
export type ItemStockSettings = z.infer<typeof ItemStockSettingsInput>;

/** A movement recorded from the merchant app (the register sends the same as events). */
export const InventoryMovementInput = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('count'), item_id: z.uuid(), location_id: z.uuid(), qty: z.int().min(0).max(1_000_000), note: z.string().trim().max(200).nullable().default(null) }),
  z.strictObject({
    kind: z.literal('receive'), item_id: z.uuid(), location_id: z.uuid(), qty: z.int().min(1).max(100_000),
    invoice_ref: z.string().trim().max(60).nullable().default(null), expires_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
  }),
  z.strictObject({ kind: z.literal('write_off'), item_id: z.uuid(), location_id: z.uuid(), qty: z.int().min(1).max(100_000), reason: z.enum(WRITE_OFF_REASONS), note: z.string().trim().max(200).nullable().default(null) }),
]);
export type InventoryMovementInput = z.infer<typeof InventoryMovementInput>;

export interface Movement {
  item_id: string;
  kind: 'count' | 'receive' | 'adjust';
  /** count: units on the shelf; receive: units in; adjust: signed change (a write-off is negative). */
  qty: number;
  at: string;
}

export interface StockItem {
  item_id: string;
  stock_of: string | null;
  stock_ratio: number;
}

export interface StockLevel {
  item_id: string;
  on_hand: number;
  counted_at: string | null;
  sold_since_count: number;
  last_sold_at: string | null;
  /** Every count after the first: what the fold expected vs what was on the shelf (shrink, P23b). */
  variances: { at: string; expected: number; counted: number }[];
}

/**
 * Fold movements and sales into stock per base item. Items without a count start at zero; a count
 * resets the level, and only what happened after it moves it.
 */
export function foldStock(items: readonly StockItem[], movements: readonly Movement[], sales: readonly (FoldedSale & { occurred_at: string })[]): Map<string, StockLevel> {
  const byId = new Map(items.map((i) => [i.item_id, i]));
  const base = (id: string) => byId.get(id)?.stock_of ?? id;
  const ratio = (id: string) => (byId.get(id)?.stock_of ? byId.get(id)!.stock_ratio : 1);
  const levels = new Map<string, StockLevel>();
  const level = (id: string) => {
    let l = levels.get(id);
    if (!l) levels.set(id, (l = { item_id: id, on_hand: 0, counted_at: null, sold_since_count: 0, last_sold_at: null, variances: [] }));
    return l;
  };

  // Changes in time order: movements and sales interleaved, so a count resets only what came before.
  type Change = { at: string; item: string; count?: number; delta?: number; sold?: number };
  const changes: Change[] = [];
  for (const m of movements) {
    if (!byId.has(m.item_id)) continue;
    const b = base(m.item_id);
    const units = m.qty * ratio(m.item_id);
    changes.push(m.kind === 'count' ? { at: m.at, item: b, count: units } : { at: m.at, item: b, delta: m.kind === 'receive' ? units : m.qty * ratio(m.item_id) });
  }
  for (const s of sales) {
    if (s.status !== 'completed' && s.status !== 'voided') continue;
    for (const l of s.lines) {
      if (l.item_id === null || !byId.has(l.item_id)) continue; // a department ring counts no stock
      const kept = l.qty - (s.refunded_qty[l.line_id] ?? 0);
      const voidedAll = s.status === 'voided';
      const units = (voidedAll ? 0 : kept) * ratio(l.item_id);
      if (units) changes.push({ at: s.occurred_at, item: base(l.item_id), sold: units });
    }
  }
  changes.sort((a, b) => a.at.localeCompare(b.at));
  for (const c of changes) {
    const l = level(c.item);
    if (c.count !== undefined) {
      // The first count sets the level; later ones show what went missing (or turned up).
      if (l.counted_at !== null) l.variances.push({ at: c.at, expected: l.on_hand, counted: c.count });
      l.on_hand = c.count;
      l.counted_at = c.at;
      l.sold_since_count = 0;
    } else if (c.delta !== undefined) l.on_hand += c.delta;
    else if (c.sold) {
      l.on_hand -= c.sold;
      l.sold_since_count += c.sold;
      if (!l.last_sold_at || c.at > l.last_sold_at) l.last_sold_at = c.at;
    }
  }
  return levels;
}

/** Dead stock (Bible 2.4): something on the shelf that hasn't sold in `days`. */
export function isDeadStock(l: Pick<StockLevel, 'on_hand' | 'last_sold_at'>, now: Date, days = 60): boolean {
  if (l.on_hand <= 0) return false;
  if (!l.last_sold_at) return true;
  return now.getTime() - Date.parse(l.last_sold_at) > days * 86_400_000;
}
