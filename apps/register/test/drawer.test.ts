/**
 * Register cash drawer (P6): float, sales, movements, no sale, blind close, restart safety.
 */
import { randomUUID } from 'node:crypto';
import { cents, type CatalogItem } from '@adpay/shared';
import { describe, expect, it } from 'vitest';
import { DrawerManager } from '../src/core/drawer';
import { SaleSession } from '../src/core/session';
import { MemoryEventStore } from '../src/core/store';

const tenancy = { org_id: randomUUID(), merchant_id: randomUUID(), location_id: randomUUID(), register_id: randomUUID() };
const ITEM: CatalogItem = {
  item_id: randomUUID(), category_id: null, name: 'Sandwich', sku: null, upc: null, plu: null, barcodes: [], cash_price_cents: 899,
  card_price_cents: 935, card_price_override: false, open_price: false, cost_cents: null, taxable: false, tax_rate_ppm: 0,
  min_age: null, sell_unit: 'each', pack_qty: 1, active: true, color: null, image_url: null, sort: 0,
};

async function setup(store = new MemoryEventStore()) {
  const session = new SaleSession({ store, tenancy, catalogVersion: () => 1, uuid: randomUUID });
  await session.restore();
  session.setActor('50000000-0000-4000-8000-000000000001');
  const drawer = new DrawerManager(store, session, randomUUID);
  await drawer.restore();
  return { store, session, drawer };
}

describe('drawer session', () => {
  it('float + cash sales − paid-out − drop; blind close records over/short', async () => {
    const { session, drawer } = await setup();
    await drawer.start(cents(20_000));
    await session.addItem(ITEM);
    await session.tenderCash(cents(1_000));
    await drawer.refresh();
    expect(drawer.current()).toMatchObject({ cash_sales_cents: 899, expected_cents: 20_899 });

    await drawer.move('paid_out', cents(4_500), 'Vendor delivery', 'Stella Bakery');
    await drawer.move('drop', cents(10_000), 'Safe drop');
    await drawer.noSale();
    const open = drawer.current()!;
    expect(open).toMatchObject({ paid_out_cents: 4_500, drops_cents: 10_000, no_sale_opens: 1, expected_cents: 6_399 });
    expect(open.movements[0]).toMatchObject({ reason: 'Vendor delivery', kind: 'paid_out' });

    const closed = await drawer.close(cents(6_300));
    expect(closed).toMatchObject({ counted_cents: 6_300, expected_cents: 6_399, over_short_cents: -99 });
    expect(drawer.current()).toBeNull();
  });

  it('survives an app restart mid-shift, and refuses double starts and movements with no drawer', async () => {
    const store = new MemoryEventStore();
    const a = await setup(store);
    await expect(a.drawer.move('drop', cents(100), 'x')).rejects.toThrow(/Start the drawer/);
    await a.drawer.start(cents(10_000));
    await expect(a.drawer.start(cents(1))).rejects.toThrow(/already started/);

    const b = await setup(store); // app restarted
    expect(b.drawer.current()).toMatchObject({ float_cents: 10_000 });
    await b.drawer.move('paid_in', cents(2_000), 'Change from bank');
    expect(b.drawer.current()!.expected_cents).toBe(12_000);
  });

  it('every step is an immutable event carrying the cashier, and the drawer-open reasons are recorded', async () => {
    const { store, drawer } = await setup();
    await drawer.start(cents(5_000));
    await drawer.move('drop', cents(1_000), 'Safe drop');
    await drawer.noSale();
    await drawer.close(cents(4_000));
    const events = await store.unacked(100);
    expect(events.map((e) => (e.type === 'drawer.opened' ? `drawer.opened:${e.payload.reason}` : e.type))).toEqual([
      'drawer.session_opened',
      'drawer.cash_movement',
      'drawer.opened:movement',
      'drawer.opened:manual',
      'drawer.opened:count',
      'drawer.session_closed',
    ]);
    expect(events.every((e) => e.actor_user_id === '50000000-0000-4000-8000-000000000001')).toBe(true);
  });
});
