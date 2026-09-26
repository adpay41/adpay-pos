/**
 * Stock at the register (P22b): tile badges from the server's levels, counted down by this
 * register's own sales (a carton takes 10 packs); deliveries and write-offs are inventory events.
 */
import { randomUUID } from 'node:crypto';
import { cents, type CatalogItem } from '@adpay/shared';
import { describe, expect, it } from 'vitest';
import { SaleSession } from '../src/core/session';
import { StockView } from '../src/core/stock';
import { MemoryEventStore } from '../src/core/store';

const tenancy = { org_id: randomUUID(), merchant_id: randomUUID(), location_id: randomUUID(), register_id: randomUUID() };
const item = (name: string, over: Partial<CatalogItem> = {}): CatalogItem => ({
  item_id: randomUUID(), category_id: null, name, sku: null, upc: null, plu: null, barcodes: [], cash_price_cents: 1400, card_price_cents: 1400,
  card_price_override: false, open_price: false, cost_cents: null, taxable: false, tax_rate_ppm: 0, min_age: null, sell_unit: 'each', pack_qty: 1,
  active: true, color: null, image_url: null, sort: 0, track_stock: true, ...over,
});
const PACK = item('Marlboro pack');
const CARTON = item('Marlboro carton', { stock_of: PACK.item_id, stock_ratio: 10, cash_price_cents: 13_500, card_price_cents: 13_500 });

describe('stock at the register', () => {
  it('badges: count left at or below the low point, "out" at zero; a carton counts in cartons', async () => {
    const view = new StockView(async () => ({ items: [{ item_id: PACK.item_id, on_hand: 22, reorder_point: 20 }], expiring: [] }), () => [PACK, CARTON]);
    await view.refresh();
    expect(view.badge(PACK)).toBeNull(); // 22 > 20
    const store = new MemoryEventStore();
    const session = new SaleSession({ store, tenancy, catalogVersion: () => 1, uuid: randomUUID });
    await session.restore();
    await session.addItem(PACK, { qty: 2 });
    const r = await session.tenderCash(cents(2_800));
    view.noteSale(r.sale);
    view.noteSale(r.sale); // the same sale twice counts once
    expect(view.badge(PACK)).toBe('20');
    expect(view.badge(CARTON)).toBe('2');
    await session.addItem(CARTON, { qty: 2 });
    view.noteSale((await session.tenderCash(cents(27_000))).sale);
    expect(view.badge(PACK)).toBe('out');
  });

  it('offline, the last levels stay', async () => {
    let online = true;
    const view = new StockView(async () => {
      if (!online) throw new Error('offline');
      return { items: [{ item_id: PACK.item_id, on_hand: 5, reorder_point: 10 }], expiring: [] };
    }, () => [PACK]);
    await view.refresh();
    online = false;
    await view.refresh();
    expect(view.badge(PACK)).toBe('5');
  });

  it('deliveries and write-offs are inventory events outside any sale', async () => {
    const store = new MemoryEventStore();
    const session = new SaleSession({ store, tenancy, catalogVersion: () => 1, uuid: randomUUID });
    await session.restore();
    await session.recordInventory('inventory.received', { receipt_id: randomUUID(), item_id: CARTON.item_id, qty: 3, invoice_ref: 'INV-9', expires_on: null });
    await session.recordInventory('inventory.written_off', { item_id: PACK.item_id, qty: 1, reason: 'damaged', note: null });
    const events = await store.unacked(10);
    expect(events.map((e) => [e.type, e.sale_id])).toEqual([
      ['inventory.received', null],
      ['inventory.written_off', null],
    ]);
  });
});
