/**
 * Ticket lifecycle (P7): hold/recall, refunds at the price paid, voiding a completed sale, and the
 * drawer seeing the cash go back.
 */
import { randomUUID } from 'node:crypto';
import { cents, type CatalogItem } from '@adpay/shared';
import { describe, expect, it } from 'vitest';
import { DrawerManager } from '../src/core/drawer';
import { SaleError, SaleSession } from '../src/core/session';
import { MemoryEventStore } from '../src/core/store';

const tenancy = { org_id: randomUUID(), merchant_id: randomUUID(), location_id: randomUUID(), register_id: randomUUID() };
function item(name: string, cash: number, card: number, taxable = false): CatalogItem {
  return {
    item_id: randomUUID(), category_id: null, name, sku: null, upc: null, plu: null, barcodes: [], cash_price_cents: cash, card_price_cents: card,
    card_price_override: false, open_price: false, cost_cents: null, taxable, tax_rate_ppm: taxable ? 66_250 : 0, min_age: null,
    sell_unit: 'each', pack_qty: 1, active: true, color: null, image_url: null, sort: 0,
  };
}
const SODA = item('Soda', 299, 311, true);
const SUB = item('Italian sub', 1_099, 1_143);

async function setup(store = new MemoryEventStore()) {
  const session = new SaleSession({ store, tenancy, catalogVersion: () => 1, uuid: randomUUID });
  await session.restore();
  return { store, session };
}

describe('hold and recall', () => {
  it('parks a ticket, serves the next customer, and brings it back intact', async () => {
    const { session } = await setup();
    await session.addItem(SUB);
    const first = session.state().sale!.sale_id;
    let s = await session.hold('Guy in the red hat');
    expect(s.sale).toBeNull();
    expect(s.parked).toMatchObject([{ sale_id: first, label: 'Guy in the red hat' }]);

    await session.addItem(SODA); // next customer
    await session.tenderCash(cents(500));

    s = await session.recall(first);
    expect(s.sale!.sale_id).toBe(first);
    expect(s.sale!.status).toBe('open');
    expect(s.sale!.lines.map((l) => l.name)).toEqual(['Italian sub']);
    expect(s.parked).toEqual([]);
  });

  it('recalling while another ticket is open holds that one instead of losing it', async () => {
    const { session } = await setup();
    await session.addItem(SUB);
    const a = session.state().sale!.sale_id;
    await session.hold();
    await session.addItem(SODA);
    const b = session.state().sale!.sale_id;
    const s = await session.recall(a);
    expect(s.sale!.sale_id).toBe(a);
    expect(s.parked.map((p) => p.sale_id)).toEqual([b]);
  });

  it('held tickets survive an app restart', async () => {
    const store = new MemoryEventStore();
    const { session } = await setup(store);
    await session.addItem(SUB);
    await session.hold('Maria');
    const again = await setup(store);
    expect(again.session.state().parked).toHaveLength(1);
    const [t] = await again.session.parkedTickets();
    expect(t!.sale.cash.total_cents).toBe(1_099);
  });

  it('an empty ticket cannot be held', async () => {
    const { session } = await setup();
    await session.addItem(SODA);
    await session.removeLine(session.state().sale!.lines[0]!.line_id);
    await expect(session.hold()).rejects.toBeInstanceOf(SaleError);
  });
});

describe('refunds and voids of completed sales', () => {
  async function paidSale() {
    const ctx = await setup();
    const drawer = new DrawerManager(ctx.store, ctx.session, randomUUID);
    await drawer.restore();
    await drawer.start(cents(10_000));
    await ctx.session.addItem(SODA);
    await ctx.session.addItem(SODA);
    await ctx.session.addItem(SUB);
    const { sale } = await ctx.session.tenderCash(cents(2_000));
    return { ...ctx, drawer, sale };
  }

  it('refunds a returned soda at the cash price with its tax, and the drawer expects that much less', async () => {
    const { session, drawer, sale } = await paidSale();
    const soda = sale.lines.find((l) => l.name === 'Soda')!;
    const { amount, sale: after } = await session.refund(sale.sale_id, [{ line_id: soda.line_id, qty: 1 }], 'Wrong flavor');
    expect(amount).toBe(319); // 299 + 6.625% tax
    expect(after.refunded_qty[soda.line_id]).toBe(1);
    await drawer.refresh();
    expect(drawer.current()!.cash_refunds_cents).toBe(319);
    expect(drawer.current()!.expected_cents).toBe(10_000 + sale.cash.total_cents - 319);
    // Can't refund more sodas than were bought.
    await expect(session.refund(sale.sale_id, [{ line_id: soda.line_id, qty: 2 }], 'x')).rejects.toThrow(/Only 1/);
  });

  it('voiding a completed sale gives back exactly what is left and marks it voided', async () => {
    const { session, sale, drawer } = await paidSale();
    const soda = sale.lines.find((l) => l.name === 'Soda')!;
    await session.refund(sale.sale_id, [{ line_id: soda.line_id, qty: 1 }], 'Wrong flavor');
    const { amount, sale: voided } = await session.voidCompleted(sale.sale_id, 'Customer changed mind');
    expect(voided.status).toBe('voided');
    expect(amount + 319).toBe(sale.paid_cents);
    expect(voided.refunded_cents).toBe(sale.paid_cents);
    await drawer.refresh();
    expect(drawer.current()!.expected_cents).toBe(10_000); // back to the float
    await expect(session.voidCompleted(sale.sale_id, 'again')).rejects.toThrow(/already voided/);
  });
});
