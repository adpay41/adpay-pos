/**
 * P14 on the register: repeat the last sale and ring a cashier's usual in one tap, through the same
 * session path as a key press (today's prices, age check once for the batch), offline.
 */
import { randomUUID } from 'node:crypto';
import { cents, type CatalogItem } from '@adpay/shared';
import { describe, expect, it } from 'vitest';
import { repeatBatch, ringBatch, usualBatch, usualLinesFrom } from '../src/core/usuals';
import { SaleSession } from '../src/core/session';
import { MemoryEventStore } from '../src/core/store';

const tenancy = { org_id: randomUUID(), merchant_id: randomUUID(), location_id: randomUUID(), register_id: randomUUID() };
const item = (name: string, cash: number, extra: Partial<CatalogItem> = {}): CatalogItem => ({
  item_id: randomUUID(), category_id: null, name, sku: null, upc: null, plu: null, barcodes: [], cash_price_cents: cash, card_price_cents: cash + 10,
  card_price_override: false, open_price: false, cost_cents: null, taxable: false, tax_rate_ppm: 0, min_age: null, sell_unit: 'each', pack_qty: 1,
  active: true, color: null, image_url: null, sort: 0, ...extra,
});
const COFFEE = item('Hot Coffee — Medium', 225);
const NEWPORT = item('Newport Menthol — Pack', 1450, { min_age: 21 });
const DELI = item('Deli by weight', 0, { open_price: true });
const GONE = item('Discontinued thing', 100);

const session = () => new SaleSession({ store: new MemoryEventStore(), tenancy, catalogVersion: () => 1, uuid: randomUUID });

describe('repeat last sale', () => {
  it('re-rings the last sale at today’s prices, keeps an open price, skips what is gone or returned', async () => {
    const s = session();
    await s.addItem(COFFEE, { qty: 2 });
    await s.addItem(DELI, { price: { cash: cents(637), card: cents(662) } });
    await s.addItem(GONE);
    await s.addItem(NEWPORT, { ageConfirmed: true });
    const { sale } = await s.tenderCash(cents(10_000));

    const today = new Map([COFFEE, DELI, NEWPORT].map((i) => [i.item_id, { ...i, cash_price_cents: i === COFFEE ? 250 : i.cash_price_cents }]));
    const batch = repeatBatch(sale, today);
    expect(batch.skipped).toEqual(['Discontinued thing']);
    expect(batch.min_age).toBe(21);
    await expect(ringBatch(s, batch, false)).rejects.toThrow(/ID check/);

    await ringBatch(s, batch, true);
    const now = s.state().sale!;
    expect(now.lines.map((l) => [l.name, l.qty, l.unit_cash_price_cents])).toEqual([
      ['Hot Coffee — Medium', 2, 250], // today's price
      ['Deli by weight', 1, 637], // the price it was sold at
      ['Newport Menthol — Pack', 1, 1450],
    ]);
    expect(now.lines.find((l) => l.min_age)!.age_verified).toBe(true);
  });
});

describe('the usual', () => {
  it('saves catalog lines only and rings them in one tap', async () => {
    const s = session();
    await s.addItem(COFFEE);
    await s.addItem(NEWPORT, { ageConfirmed: true });
    const lines = usualLinesFrom(s.state().sale!);
    expect(lines).toEqual([
      { item_id: COFFEE.item_id, qty: 1 },
      { item_id: NEWPORT.item_id, qty: 1 },
    ]);
    await s.voidSale('test');

    const byId = new Map([COFFEE, NEWPORT, DELI].map((i) => [i.item_id, i]));
    const b = usualBatch({ usual_id: randomUUID(), user_id: randomUUID(), label: 'Mike', lines: [...lines, { item_id: DELI.item_id, qty: 1 }] }, byId);
    expect(b.skipped).toEqual(['Deli by weight']); // open price: ring it by hand
    await ringBatch(s, b, true);
    expect(s.state().sale!.cash.total_cents).toBe(225 + 1450);
  });
});
