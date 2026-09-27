/**
 * Department ring (ADR 0046): an amount rung straight to a department, with no item record. The line
 * takes the department's tax and age rule, never merges, refunds like any line, and every report
 * buckets it by its department.
 */
import { randomUUID } from 'node:crypto';
import { buildZReport, cents, departmentItem, deriveCardPrice, marginReport, type CatalogCategory, type CatalogSnapshot } from '@adpay/shared';
import { describe, expect, it } from 'vitest';
import { SaleError, SaleSession } from '../src/core/session';
import { MemoryEventStore } from '../src/core/store';
import { repeatBatch, usualLinesFrom } from '../src/core/usuals';

const tenancy = { org_id: randomUUID(), merchant_id: randomUUID(), location_id: randomUUID(), register_id: randomUUID() };
const cat = (name: string, over: Partial<CatalogCategory> = {}): CatalogCategory => ({ category_id: randomUUID(), name, sort: 0, taxable: true, min_age: null, color: null, active: true, ...over });
const GROCERY = cat('Grocery');
const PRODUCE = cat('Produce', { taxable: false });
const TOBACCO = cat('Tobacco', { min_age: 21, restriction: 'tobacco' });
const snapshot: Pick<CatalogSnapshot, 'tax_rate_ppm' | 'compliance'> = { tax_rate_ppm: 66_250 };
const price = (c: number) => ({ cash: cents(c), card: deriveCardPrice(cents(c), 40_000) });

async function setup() {
  const store = new MemoryEventStore();
  const session = new SaleSession({ store, tenancy, catalogVersion: () => 1, uuid: randomUUID });
  await session.restore();
  return { store, session };
}

describe('department ring', () => {
  it('rings $3.50 to Grocery: no item on the event, the department on the line, taxed as the department', async () => {
    const { session, store } = await setup();
    const s = await session.addItem(departmentItem(GROCERY, snapshot), { price: price(350) });
    expect(s.sale!.lines[0]).toMatchObject({ item_id: null, is_department: true, name: 'Grocery', category_id: GROCERY.category_id, unit_cash_price_cents: 350 });
    expect(s.sale!.cash).toMatchObject({ subtotal_cents: 350, tax_cents: 23, total_cents: 373 });
    const added = (await store.unacked(10)).find((e) => e.type === 'sale.line_added')!;
    expect(added.type === 'sale.line_added' && added.payload).toMatchObject({ item_id: null, price_source: 'department' });
  });

  it('a department that is not taxed rings with no tax; two rings are two lines', async () => {
    const { session } = await setup();
    await session.addItem(departmentItem(PRODUCE, snapshot), { price: price(199) });
    const s = await session.addItem(departmentItem(PRODUCE, snapshot), { price: price(199) });
    expect(s.sale!.lines).toHaveLength(2);
    expect(s.sale!.cash).toMatchObject({ tax_cents: 0, total_cents: 398 });
  });

  it('an age-restricted department needs the age check', async () => {
    const { session } = await setup();
    const item = departmentItem(TOBACCO, snapshot);
    expect(item.min_age).toBe(21);
    await expect(session.addItem(item, { price: price(1_299) })).rejects.toBeInstanceOf(SaleError);
    const s = await session.addItem(item, { price: price(1_299), ageConfirmed: true });
    expect(s.sale!.lines[0]).toMatchObject({ item_id: null, age_verified: true });
  });

  it('refunds, Z-report, profit, repeat and usuals all handle a line with no item', async () => {
    const { session, store } = await setup();
    await session.addItem(departmentItem(GROCERY, snapshot), { price: price(350) });
    const { sale } = await session.tenderCash(cents(500));
    expect(sale).toMatchObject({ status: 'completed', paid_cents: 373, mismatch: false });

    const z = buildZReport(await store.unacked(100), { z_number: 1, register_id: tenancy.register_id, business_date: '2026-09-27', from_seq: -1, categoryName: (id) => (id === GROCERY.category_id ? 'Grocery' : '?') });
    expect(z.by_category).toEqual([{ category_id: GROCERY.category_id, name: 'Grocery', qty: 1, amount_cents: 350 }]);

    const margin = marginReport([{ ...sale, occurred_at: '2026-09-27T12:00:00.000Z' }], () => null, () => 'Grocery', { from: '2026-09-27', to: '2026-09-27' });
    expect(margin.items).toEqual([expect.objectContaining({ name: 'Grocery (department)', revenue_cents: 350, units_without_cost: 1 })]);

    // Repeat last sale rings it again at the same amount; a usual never includes it.
    const batch = repeatBatch(sale, new Map(), (id) => (id === GROCERY.category_id ? departmentItem(GROCERY, snapshot) : null));
    expect(batch.lines).toEqual([expect.objectContaining({ qty: 1, price: { cash: 350, card: 364 } })]);
    expect(repeatBatch(sale, new Map()).skipped).toEqual(['Grocery']);
    expect(usualLinesFrom(sale)).toEqual([]);

    const r = await session.refund(sale.sale_id, [{ line_id: sale.lines[0]!.line_id, qty: 1 }], 'Wrong amount');
    expect(r.amount).toBe(373);
  });
});
