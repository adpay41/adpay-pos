/**
 * Register speed (P5): quantity intelligence, open price, case barcodes, and items created at the
 * register from an unknown barcode, all offline.
 */
import { randomUUID } from 'node:crypto';
import {
  barcodeIndex,
  cents,
  lookupBarcode,
  type CatalogItem,
  type CatalogSnapshot,
  type DeviceItemCreate,
  type DeviceItemResult,
} from '@adpay/shared';
import { describe, expect, it } from 'vitest';
import { NewItemOutbox } from '../src/core/new-items';
import { SaleError, SaleSession } from '../src/core/session';
import { MemoryEventStore } from '../src/core/store';

const tenancy = { org_id: randomUUID(), merchant_id: randomUUID(), location_id: randomUUID(), register_id: randomUUID() };
function item(name: string, cash: number, extra: Partial<CatalogItem> = {}): CatalogItem {
  return {
    item_id: randomUUID(), category_id: null, name, sku: null, upc: null, plu: null, barcodes: [], cash_price_cents: cash,
    card_price_cents: cash + 10, card_price_override: false, open_price: false, cost_cents: null, taxable: false, tax_rate_ppm: 0,
    min_age: null, sell_unit: 'each', pack_qty: 1, active: true, color: null, image_url: null, sort: 0, ...extra,
  };
}
const SODA = item('Soda', 199, { upc: '049000042566' });
const CIGS = item('Marlboro Pack', 1250, { min_age: 21, upc: '028200003843', barcodes: [{ barcode: '028200003850', pack_qty: 10 }] });
const DELI = item('Deli by the pound', 0, { open_price: true });

function newSession(store = new MemoryEventStore()) {
  return { store, session: new SaleSession({ store, tenancy, catalogVersion: () => 1, uuid: randomUUID }) };
}

describe('quantity intelligence', () => {
  it('ringing the same item again raises the quantity of that line', async () => {
    const { session, store } = newSession();
    await session.addItem(SODA, { entry: 'scan' });
    const s = await session.addItem(SODA, { entry: 'scan' });
    expect(s.sale!.lines).toHaveLength(1);
    expect(s.sale!.lines[0]!.qty).toBe(2);
    expect(s.sale!.cash.total_cents).toBe(398);
    const types = (await store.unacked(100)).map((e) => e.type);
    expect(types).toEqual(['sale.opened', 'sale.line_added', 'sale.line_qty_changed']);
  });

  it('only merges with the line just rung; another item in between starts a new line', async () => {
    const { session } = newSession();
    await session.addItem(SODA);
    await session.addItem(item('Chips', 150));
    const s = await session.addItem(SODA);
    expect(s.sale!.lines.map((l) => [l.name, l.qty])).toEqual([
      ['Soda', 1],
      ['Chips', 1],
      ['Soda', 1],
    ]);
  });

  it('a second pack of an age-checked item needs no second prompt', async () => {
    const { session } = newSession();
    await session.addItem(CIGS, { ageConfirmed: true });
    expect(session.wouldMerge(CIGS)).toBe(true);
    const s = await session.addItem(CIGS); // no ageConfirmed: it merges into the checked line
    expect(s.sale!.lines[0]).toMatchObject({ qty: 2, age_verified: true });
  });

  it('long-press quantity sets the line, and 0 removes it', async () => {
    const { session } = newSession();
    const s = await session.addItem(SODA);
    const id = s.sale!.lines[0]!.line_id;
    expect((await session.setQty(id, 6)).sale!.lines[0]!.qty).toBe(6);
    expect((await session.setQty(id, 0)).sale!.lines).toHaveLength(0);
    await expect(session.setQty(id, 2)).rejects.toBeInstanceOf(SaleError);
  });

  it('a case barcode rings the pack quantity', async () => {
    const idx = barcodeIndex({ items: [SODA, CIGS] });
    const hit = lookupBarcode(idx, '028200003850')!;
    const { session } = newSession();
    const s = await session.addItem(hit.item, { qty: hit.qty, ageConfirmed: true, entry: 'scan' });
    expect(s.sale!.lines[0]).toMatchObject({ name: 'Marlboro Pack', qty: 10 });
    expect(s.sale!.cash.total_cents).toBe(12_500);
  });
});

describe('open price', () => {
  it('requires a typed price, records both prices and marks the line as open-price', async () => {
    const { session, store } = newSession();
    await expect(session.addItem(DELI)).rejects.toThrow(/Enter a price/);
    const s = await session.addItem(DELI, { price: { cash: cents(837), card: cents(871) } });
    expect(s.sale!.lines[0]).toMatchObject({ unit_cash_price_cents: 837, unit_card_price_cents: 871 });
    const added = (await store.unacked(100)).find((e) => e.type === 'sale.line_added')!;
    expect(added.type === 'sale.line_added' && added.payload.price_source).toBe('open');
    // Two open-price rings are two lines (two different weighings), never merged.
    const t = await session.addItem(DELI, { price: { cash: cents(837), card: cents(871) } });
    expect(t.sale!.lines).toHaveLength(2);
  });
});

describe('items created at the register', () => {
  const snapshot: CatalogSnapshot = {
    merchant_id: tenancy.merchant_id, location_id: tenancy.location_id, catalog_version: 3, dual_price_rate_ppm: 40_000, tax_rate_ppm: 66_250,
    generated_at: '', items: [SODA], quick_keys: [],
    categories: [{ category_id: 'c0000000-0000-4000-8000-000000000001', name: 'Grocery', sort: 0, taxable: true, min_age: null, color: null, active: true }],
  };
  const cmd = (over: Partial<DeviceItemCreate> = {}): DeviceItemCreate => ({
    item_id: randomUUID(), name: 'Goya Adobo', category_id: 'c0000000-0000-4000-8000-000000000001', cash_price_cents: 349,
    upc: '041331021636', created_by_user_id: null, created_at: new Date().toISOString(), ...over,
  });

  class FakeItems {
    online = true;
    got: DeviceItemCreate[] = [];
    refuse = new Set<string>();
    async createItem(c: DeviceItemCreate): Promise<DeviceItemResult> {
      if (!this.online) throw new Error('network unreachable');
      if (this.refuse.has(c.item_id)) throw Object.assign(new Error('bad category'), { status: 400 });
      this.got.push(c);
      return { item_id: c.item_id, status: 'created', catalog_version: 4 };
    }
  }

  it('is sellable at once, priced for this location (card via dual %, tax by category), before the server knows it', async () => {
    const store = new MemoryEventStore();
    const outbox = new NewItemOutbox(store, new FakeItems());
    const c = cmd();
    await outbox.add(c);
    const view = outbox.overlay(snapshot);
    const created = view.items.find((i) => i.item_id === c.item_id)!;
    expect(created).toMatchObject({ name: 'Goya Adobo', cash_price_cents: 349, card_price_cents: 363, taxable: true, tax_rate_ppm: 66_250 });
    expect(lookupBarcode(barcodeIndex(view), '041331021636')!.item.item_id).toBe(c.item_id);

    const { session } = newSession(store);
    const s = await session.addItem(created, { entry: 'new_item' });
    expect(s.sale!.lines[0]!.item_id).toBe(c.item_id);
  });

  it('waits offline, survives a restart, and flushes when the server is back', async () => {
    const store = new MemoryEventStore();
    const api = new FakeItems();
    api.online = false;
    const outbox = new NewItemOutbox(store, api);
    await outbox.add(cmd());
    await expect(outbox.flush()).rejects.toThrow('network unreachable');

    const restarted = new NewItemOutbox(store, api);
    await restarted.load();
    expect(restarted.list()).toHaveLength(1);
    api.online = true;
    await restarted.flush();
    expect(api.got).toHaveLength(1);
    expect(restarted.list()).toHaveLength(0);
  });

  it('a command the server refuses is dropped and reported, and does not block the rest', async () => {
    const store = new MemoryEventStore();
    const api = new FakeItems();
    const rejected: string[] = [];
    const outbox = new NewItemOutbox(store, api, (c, why) => rejected.push(`${c.name}: ${why}`));
    const bad = cmd({ name: 'Bad' });
    const good = cmd({ name: 'Good', upc: '012345678905' });
    api.refuse.add(bad.item_id);
    await outbox.add(bad);
    await outbox.add(good);
    await outbox.flush();
    expect(rejected).toEqual(['Bad: bad category']);
    expect(api.got.map((c) => c.name)).toEqual(['Good']);
  });

  it('drops out of the overlay once the snapshot carries it', async () => {
    const outbox = new NewItemOutbox(new MemoryEventStore(), new FakeItems());
    const c = cmd();
    await outbox.add(c);
    const later = { ...snapshot, items: [...snapshot.items, { ...SODA, item_id: c.item_id, name: 'Goya Adobo (from server)' }] };
    expect(outbox.overlay(later).items.filter((i) => i.item_id === c.item_id).map((i) => i.name)).toEqual(['Goya Adobo (from server)']);
  });
});
