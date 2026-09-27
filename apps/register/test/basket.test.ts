/**
 * Basket (whole-ticket) discount (ADR 0048), rung through the session: one event, spread over the
 * lines by the fold, so tax, refunds, the receipt and the Z all agree; it follows the ticket as lines
 * change, and removing it restores the prices. Figures worked by hand first:
 *
 *   Soda $2.99 (taxed 6.625%) + Sub $10.99 (untaxed); card $3.11 / $11.43.
 *   10%: cash goods 1398 → 140 off: soda 30 (29.94, largest remainder), sub 110.
 *        tax on the soda (299 − 30) = 269 × 6.625% = 17.8 → 18. Total 1398 − 140 + 18 = 1276.
 *        card goods 1454 → 145 off: soda 31, sub 114; tax (311 − 31) × 6.625% = 18.55 → 19; total 1328.
 */
import { randomUUID } from 'node:crypto';
import { buildZReport, cents, permissionsFor, receiptText, renderReceipt, type CatalogItem, type FoldedSale } from '@adpay/shared';
import { describe, expect, it } from 'vitest';
import { SaleSession } from '../src/core/session';
import { MemoryEventStore } from '../src/core/store';

const tenancy = { org_id: randomUUID(), merchant_id: randomUUID(), location_id: randomUUID(), register_id: randomUUID() };
const item = (name: string, cash: number, card: number, taxable: boolean, tax_included = false): CatalogItem => ({
  item_id: randomUUID(), category_id: null, name, sku: null, upc: null, plu: null, barcodes: [], cash_price_cents: cash, card_price_cents: card,
  card_price_override: false, open_price: false, cost_cents: null, taxable, tax_rate_ppm: taxable ? 66_250 : 0, min_age: null,
  sell_unit: 'each', pack_qty: 1, active: true, color: null, image_url: null, sort: 0, tax_included,
});
const SODA = item('Soda', 299, 311, true);
const SUB = item('Italian sub', 1_099, 1_143, false);
const TEN = { kind: 'percent' as const, percent_ppm: 100_000, amount_cents: null, reason: 'Regular customer' };

async function setup() {
  const store = new MemoryEventStore();
  const session = new SaleSession({ store, tenancy, catalogVersion: () => 1, uuid: randomUUID });
  await session.restore();
  await session.addItem(SODA);
  await session.addItem(SUB);
  return { store, session };
}
const line = (s: FoldedSale, name: string) => s.lines.find((l) => l.name === name)!;

describe('basket discount', () => {
  it('10% off: spread over the lines, tax on what is left, both price modes', async () => {
    const { session } = await setup();
    const s = (await session.discountTicket(TEN)).sale!;
    expect([line(s, 'Soda').basket_cash_cents, line(s, 'Italian sub').basket_cash_cents]).toEqual([30, 110]);
    expect(s.cash).toMatchObject({ subtotal_cents: 1_258, tax_cents: 18, total_cents: 1_276 });
    expect([line(s, 'Soda').basket_card_cents, line(s, 'Italian sub').basket_card_cents]).toEqual([31, 114]);
    expect(s.card).toMatchObject({ tax_cents: 19, total_cents: 1_328 });
    expect(s.basket).toMatchObject({ kind: 'percent', cash_cents: 140, card_cents: 145, reason: 'Regular customer' });
  });

  it('an amount off is cash cents, scaled to the card price; removing it restores the ticket', async () => {
    const { session } = await setup();
    const s = (await session.discountTicket({ kind: 'amount', percent_ppm: null, amount_cents: 500, reason: 'Price match' })).sale!;
    expect(s.basket).toMatchObject({ cash_cents: 500, card_cents: 520 }); // 500 × 1454 / 1398 = 520.03
    expect(s.cash.subtotal_cents).toBe(898);
    const back = (await session.discountTicket(null)).sale!;
    expect(back.basket).toBeNull();
    expect(back.cash).toMatchObject({ subtotal_cents: 1_398, total_cents: 1_418 });
  });

  it('follows the ticket: a line added after the discount gets its share', async () => {
    const { session } = await setup();
    await session.discountTicket(TEN);
    const s = (await session.addItem(SODA)).sale!; // the soda line goes to qty 2: goods 1697 → 170 off
    expect(s.basket!.cash_cents).toBe(170);
  });

  it('the receipt shows one discount line, and a refund gives back what was paid for the unit', async () => {
    const { session, store } = await setup();
    await session.discountTicket(TEN);
    const { sale } = await session.tenderCash(cents(2_000));
    expect(sale).toMatchObject({ paid_cents: 1_276, mismatch: false });
    const text = receiptText(
      renderReceipt({ header: { merchant_name: 'Deli', location_name: 'JC', address_line1: null, city_state_zip: null, register_name: 'R1' }, sale, occurred_at: '2026-09-27T12:00:00Z', timezone: 'America/New_York', copy: 'original' }),
    );
    expect(text).toMatch(/Discount 10%\s+-\$1\.40/);
    expect(text).toMatch(/Subtotal\s+\$12\.58/);
    expect(text).toMatch(/TOTAL\s+\$12\.76/);
    const z = buildZReport(await store.unacked(100), { z_number: 1, register_id: tenancy.register_id, business_date: '2026-09-27', from_seq: -1, categoryName: () => 'All' });
    expect(z).toMatchObject({ gross_cents: 1_276, tax_cents: 18 });
    // The soda was $2.99 less its 30¢ share, plus 18¢ tax.
    const r = await session.refund(sale.sale_id, [{ line_id: line(sale, 'Soda').line_id, qty: 1 }], 'Returned');
    expect(r.amount).toBe(287);
  });

  it('a tax-inclusive line under a discount still rings tax-inside: $10.00 less 10% = $9.00 exactly', async () => {
    const store = new MemoryEventStore();
    const session = new SaleSession({ store, tenancy, catalogVersion: () => 1, uuid: randomUUID });
    await session.restore();
    await session.addItem(item('Marlboro Red', 1_000, 1_040, true, true));
    const s = (await session.discountTicket(TEN)).sale!;
    // 900 ÷ 1.06625 = 844.08 → 844 before tax, 56 inside.
    expect(s.cash).toEqual({ subtotal_cents: 844, tax_cents: 56, total_cents: 900, included_tax_cents: 56 });
  });

  it('cashiers need a manager for it by default; managers and owners have it', () => {
    expect(permissionsFor('cashier')).not.toContain('ticket.discount');
    expect(permissionsFor('manager')).toContain('ticket.discount');
    expect(permissionsFor('owner')).toContain('ticket.discount');
  });
});

describe('basket discount on screen', () => {
  it('the ticket shows lines at their own price and the discount once; the customer screen takes it off the lines', async () => {
    const { lineAmount } = await import('@adpay/shared');
    const { displayFor } = await import('../src/core/display');
    const { session } = await setup();
    const s = (await session.discountTicket(TEN)).sale!;
    expect(s.lines.map((l) => lineAmount(l, 'cash'))).toEqual([299, 1_099]);
    const shown = displayFor('Deli', s);
    expect(shown.lines.map((l) => l.cash_cents)).toEqual([269, 989]);
    expect(shown.lines.reduce((n, l) => n + l.cash_cents, 0) + shown.tax_cash_cents).toBe(shown.cash_total_cents);
  });
});
