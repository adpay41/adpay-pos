/**
 * Ringing several items in one tap (build plan P14, Bible 1.1): **repeat the last sale** ("same guy,
 * same coffee and pack every morning") and a cashier's **usuals**. Each item is rung through the
 * session like a key press, at today's catalog price, so pricing, tax, charges and events are exactly
 * those of ringing them by hand. An open-price item repeats at the price it was sold at.
 */
import { cents, type CashierUsual, type CatalogItem, type Cents, type FoldedSale } from '@adpay/shared';
import type { SaleSession } from './session';

export interface BatchLine {
  item: CatalogItem;
  qty: number;
  price?: { cash: Cents; card: Cents };
}

export interface Batch {
  lines: BatchLine[];
  /** Names that can't be rung any more (removed from the catalog, inactive, a fee, no price). */
  skipped: string[];
  /** Strictest age check among the lines, or null. One confirmation covers the batch. */
  min_age: number | null;
}

function finish(lines: BatchLine[], skipped: string[]): Batch {
  const age = Math.max(0, ...lines.map((l) => l.item.min_age ?? 0));
  return { lines, skipped, min_age: age > 0 ? age : null };
}

/** The last completed sale's lines, less anything returned. */
export function repeatBatch(sale: FoldedSale, items: ReadonlyMap<string, CatalogItem>): Batch {
  const lines: BatchLine[] = [];
  const skipped: string[] = [];
  for (const l of sale.lines) {
    const qty = l.qty - (sale.refunded_qty[l.line_id] ?? 0);
    if (qty <= 0) continue;
    const item = items.get(l.item_id);
    if (l.is_fee || !item || !item.active) {
      skipped.push(l.name);
      continue;
    }
    lines.push(item.open_price ? { item, qty, price: { cash: cents(l.unit_cash_price_cents), card: cents(l.unit_card_price_cents) } } : { item, qty });
  }
  return finish(lines, skipped);
}

export function usualBatch(u: CashierUsual, items: ReadonlyMap<string, CatalogItem>): Batch {
  const lines: BatchLine[] = [];
  const skipped: string[] = [];
  for (const l of u.lines) {
    const item = items.get(l.item_id);
    // An open-price item has no price to repeat from a preset: ring it by hand.
    if (!item || !item.active || item.open_price) skipped.push(item?.name ?? 'a removed item');
    else lines.push({ item, qty: l.qty });
  }
  return finish(lines, skipped);
}

/** What to save as a usual from the ticket on screen: catalog lines only (no fees), qty per line. */
export function usualLinesFrom(sale: FoldedSale): { item_id: string; qty: number }[] {
  return sale.lines.filter((l) => !l.is_fee).map((l) => ({ item_id: l.item_id, qty: Math.min(100, l.qty) }));
}

/** Ring the batch, one line at a time through the session. */
export async function ringBatch(session: SaleSession, batch: Batch, ageConfirmed: boolean, idCheck?: { age: number; jurisdiction: string | null }): Promise<void> {
  if (batch.min_age && !ageConfirmed) throw new Error(`This needs an ID check (${batch.min_age}+)`);
  for (const l of batch.lines) await session.addItem(l.item, { qty: l.qty, entry: 'key', ageConfirmed, ...(l.price ? { price: l.price } : {}), ...(idCheck && l.item.min_age ? { idCheck } : {}) });
}
