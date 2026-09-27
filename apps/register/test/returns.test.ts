/**
 * Refund without a receipt (ADR 0051), through the session: a return ticket where what comes back is
 * rung like a sale, then refunded in cash at its total. It is never a sale: the Z counts it as a
 * refund, the drawer pays it out, the tax report takes its tax back, and no age check is logged.
 */
import { randomUUID } from 'node:crypto';
import { buildZReport, cents, refundTax, saleNetCents, type CatalogItem } from '@adpay/shared';
import { describe, expect, it } from 'vitest';
import { DrawerManager } from '../src/core/drawer';
import { SaleError, SaleSession } from '../src/core/session';
import { MemoryEventStore } from '../src/core/store';

const tenancy = { org_id: randomUUID(), merchant_id: randomUUID(), location_id: randomUUID(), register_id: randomUUID() };
const item = (name: string, cash: number, taxable: boolean, min_age: number | null = null): CatalogItem => ({
  item_id: randomUUID(), category_id: null, name, sku: null, upc: null, plu: null, barcodes: [], cash_price_cents: cash, card_price_cents: cash + 12,
  card_price_override: false, open_price: false, cost_cents: null, taxable, tax_rate_ppm: taxable ? 66_250 : 0, min_age,
  sell_unit: 'each', pack_qty: 1, active: true, color: null, image_url: null, sort: 0,
});
const SODA = item('Soda', 299, true);
const CIGS = item('Marlboro Red', 1_399, false, 21);

async function setup() {
  const store = new MemoryEventStore();
  const session = new SaleSession({ store, tenancy, catalogVersion: () => 1, uuid: randomUUID });
  await session.restore();
  const drawer = new DrawerManager(store, session, randomUUID);
  await drawer.restore();
  await drawer.start(cents(10_000));
  return { store, session, drawer };
}

describe('refund without a receipt', () => {
  it('rings what comes back and refunds it in cash at today’s price with tax; no age check is asked or logged', async () => {
    const { session, store } = await setup();
    await session.startReturn('Defective');
    await session.addItem(SODA);
    const s = (await session.addItem(CIGS)).sale!; // no ageConfirmed: coming back, not sold
    expect(s).toMatchObject({ kind: 'return', return_reason: 'Defective', status: 'open' });
    // 299 + 1399 = 1698; tax on the soda 19.8 → 20
    expect(s.cash.total_cents).toBe(1_718);
    const r = await session.completeReturn();
    expect(r.amount).toBe(1_718);
    expect(r.sale).toMatchObject({ status: 'returned', price_mode: 'cash', refunded_cents: 1_718 });
    expect(saleNetCents(r.sale)).toBe(-1_718);
    expect(session.state().sale).toBeNull();
    const events = await store.unacked(200);
    expect(events.some((e) => e.type === 'sale.age_verified')).toBe(false);
    expect(events.some((e) => e.type === 'sale.completed')).toBe(false);
    const refunded = events.find((e) => e.type === 'sale.refunded')!;
    expect(refunded.type === 'sale.refunded' && refunded.payload).toMatchObject({ tender_type: 'cash', amount_cents: 1_718, reason: 'Defective' });
    expect(refundTax(r.sale, r.sale.lines.map((l) => ({ line_id: l.line_id, qty: l.qty })))).toBe(20);
  });

  it('a return takes no tenders, and cannot start over a ticket with items on it', async () => {
    const { session } = await setup();
    await session.addItem(SODA);
    await expect(session.startReturn('Wrong item')).rejects.toBeInstanceOf(SaleError);
    await session.voidSale('test');
    await session.startReturn('Wrong item');
    await session.addItem(SODA);
    await expect(session.tenderCash(cents(500))).rejects.toThrow(/return/);
    await expect(session.tenderOther('check', cents(100), { reference: null })).rejects.toThrow(/return/);
  });

  it('the Z and the drawer see a refund, not a sale', async () => {
    const { session, store, drawer } = await setup();
    await session.startReturn('Changed mind');
    await session.addItem(SODA);
    await session.completeReturn();
    const z = buildZReport(await store.unacked(200), { z_number: 1, register_id: tenancy.register_id, business_date: '2026-09-27', from_seq: -1, categoryName: () => 'All' });
    expect(z).toMatchObject({ sales_count: 0, gross_cents: 0, refunds: { count: 1, cash_cents: 319, card_cents: 0 } });
    await drawer.refresh();
    expect(drawer.current()!.cash_refunds_cents).toBe(319);
    expect(drawer.current()!.expected_cents).toBe(10_000 - 319);
  });
});
