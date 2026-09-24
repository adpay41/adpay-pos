/**
 * P16 on the register: end of day needs the drawer counted, covers everything since the previous Z,
 * and the next Z starts after it; training mode rings nothing into the real store.
 */
import { randomUUID } from 'node:crypto';
import { cents, type CatalogItem } from '@adpay/shared';
import { describe, expect, it } from 'vitest';
import { DrawerManager } from '../src/core/drawer';
import { EndOfDay } from '../src/core/eod';
import { SaleSession } from '../src/core/session';
import { MemoryEventStore } from '../src/core/store';

const tenancy = { org_id: randomUUID(), merchant_id: randomUUID(), location_id: randomUUID(), register_id: randomUUID() };
const COFFEE: CatalogItem = {
  item_id: randomUUID(), category_id: null, name: 'Coffee', sku: null, upc: null, plu: null, barcodes: [], cash_price_cents: 225, card_price_cents: 234,
  card_price_override: false, open_price: false, cost_cents: null, taxable: false, tax_rate_ppm: 0, min_age: null, sell_unit: 'each', pack_qty: 1,
  active: true, color: null, image_url: null, sort: 0,
};
const catalog = { categories: [] };

async function setup() {
  const store = new MemoryEventStore();
  const session = new SaleSession({ store, tenancy, catalogVersion: () => 1, uuid: randomUUID });
  await session.restore();
  const drawer = new DrawerManager(store, session, randomUUID);
  await drawer.restore();
  const eod = new EndOfDay(store, session, drawer, tenancy.register_id, 'America/New_York');
  await eod.restore();
  return { store, session, drawer, eod };
}

describe('end of day', () => {
  it('needs the drawer counted; covers everything since the last Z; the next Z starts after it', async () => {
    const { store, session, drawer, eod } = await setup();
    await drawer.start(cents(10_000));
    await session.addItem(COFFEE);
    await session.tenderCash(cents(225));
    await expect(eod.close(catalog)).rejects.toThrow(/count the drawer/);
    await drawer.close(cents(10_225));

    const z1 = await eod.close(catalog);
    expect(z1).toMatchObject({ z_number: 1, sales_count: 1, gross_cents: 225, drawer: { counted_cents: 10_225, over_short_cents: 0 } });
    const closed = (await store.eventsSince(0)).find((e) => e.type === 'eod.closed')!;
    expect(closed.payload).toMatchObject({ z_number: 1, from_seq: 0, to_seq: z1.to_seq, totals: { sales_count: 1, cash_cents: 225 } });

    // A restart keeps the numbering; the next Z has only what came after.
    const again = new EndOfDay(store, session, drawer, tenancy.register_id, 'America/New_York');
    await again.restore();
    await session.addItem(COFFEE);
    await session.tenderCash(cents(500));
    const z2 = await again.preview(catalog);
    expect(z2).toMatchObject({ z_number: 2, sales_count: 1, gross_cents: 225 });
    expect(z2.from_seq).toBe(closed.device_seq + 1);
  });
});

describe('training mode', () => {
  it('a practice session rings and completes without touching the real store', async () => {
    const { store } = await setup();
    const before = (await store.eventsSince(0)).length;
    const training = new SaleSession({ store: new MemoryEventStore(), tenancy, catalogVersion: () => 1, uuid: randomUUID });
    await training.addItem(COFFEE, { qty: 3 });
    const { sale } = await training.tenderCash(cents(1_000));
    expect(sale.status).toBe('completed');
    expect((await store.eventsSince(0)).length).toBe(before);
  });
});
