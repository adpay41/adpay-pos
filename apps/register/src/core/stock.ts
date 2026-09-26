/**
 * Stock at the register (P22b, ADR 0034): the store's levels from the server, refreshed every few
 * minutes when online, and counted down by this register's own sales in between, for the low-stock
 * badge on tiles ("3 left") and the sell-soon banner. The server's fold is the truth; this is a
 * glance, and offline it simply stops being refreshed.
 */
import type { CatalogItem, FoldedSale } from '@adpay/shared';

export interface StockSnapshot {
  items: { item_id: string; on_hand: number; reorder_point: number | null }[];
  expiring: { item_id: string; name: string; expires_on: string; qty: number }[];
}

export class StockView {
  private levels = new Map<string, { on_hand: number; reorder_point: number | null }>();
  private expiringLots: StockSnapshot['expiring'] = [];
  private listeners = new Set<() => void>();
  private seen = new Set<string>();

  constructor(
    private readonly fetchStock: () => Promise<StockSnapshot>,
    private readonly items: () => readonly CatalogItem[],
  ) {}

  async refresh(): Promise<void> {
    try {
      const s = await this.fetchStock();
      this.levels = new Map(s.items.map((i) => [i.item_id, { on_hand: i.on_hand, reorder_point: i.reorder_point }]));
      this.expiringLots = s.expiring;
      this.notify();
    } catch {
      // Offline: keep what we had.
    }
  }

  /** Count a completed sale down from the levels until the next refresh. */
  noteSale(sale: FoldedSale): void {
    if (sale.status !== 'completed' || this.seen.has(sale.sale_id)) return;
    this.seen.add(sale.sale_id);
    const byId = new Map(this.items().map((i) => [i.item_id, i]));
    for (const l of sale.lines) {
      const item = byId.get(l.item_id);
      const base = item?.stock_of ?? l.item_id;
      const level = this.levels.get(base);
      if (!level) continue;
      level.on_hand -= l.qty * (item?.stock_of ? (item.stock_ratio ?? 1) : 1);
    }
    this.notify();
  }

  /** "3 left" / "Out" on a tile when the item (or what it breaks into) is at or below its low point. */
  badge(item: CatalogItem): string | null {
    const level = this.levels.get(item.stock_of ?? item.item_id);
    if (!level) return null;
    const units = item.stock_of ? Math.floor(level.on_hand / (item.stock_ratio ?? 1)) : level.on_hand;
    if (units <= 0) return 'out';
    if (level.reorder_point !== null && level.on_hand <= level.reorder_point) return `${units}`;
    return null;
  }

  expiring(): StockSnapshot['expiring'] {
    return this.expiringLots;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify() {
    for (const fn of this.listeners) fn();
  }
}
