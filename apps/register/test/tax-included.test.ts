/**
 * Tax-inclusive prices (ADR 0044), rung through the real session so every figure comes from the
 * events: the item rings at exactly its marked price, the tax is backed out of it, and the receipt,
 * refunds, split tender, Z-report, sales-tax report and profit all agree.
 *
 * Rate 6.625% (NJ). Cigarettes marked $10.00 cash / $10.40 card, tax included; a soda $5.00 / $5.20
 * with tax added on top.
 *   $10.00 inclusive → base 1000 ÷ 1.06625 = 937.87 → 938, tax 62
 *   $5.00 added      → 500 × 6.625% = 33.125 → 33
 */
import { randomUUID } from 'node:crypto';
import {
  buildZReport,
  cardAmountFor,
  cents,
  foldSale,
  marginReport,
  receiptText,
  refundTax,
  renderReceipt,
  saleSubtotal,
  saleTaxGroups,
  shownTotals,
  type CatalogItem,
  type FoldedSale,
} from '@adpay/shared';
import { describe, expect, it } from 'vitest';
import { SaleSession } from '../src/core/session';
import { MemoryEventStore } from '../src/core/store';

const tenancy = { org_id: randomUUID(), merchant_id: randomUUID(), location_id: randomUUID(), register_id: randomUUID() };
const item = (name: string, cash: number, card: number, tax_included: boolean): CatalogItem => ({
  item_id: randomUUID(), category_id: null, name, sku: null, upc: null, plu: null, barcodes: [], cash_price_cents: cash, card_price_cents: card,
  card_price_override: false, open_price: false, cost_cents: null, taxable: true, tax_rate_ppm: 66_250, min_age: null,
  sell_unit: 'each', pack_qty: 1, active: true, color: null, image_url: null, sort: 0, tax_included,
});
const CIGS = item('Marlboro Red', 1_000, 1_040, true);
const SODA = item('Soda', 500, 520, false);
const approved = (ref: string) => ({ status: 'approved', provider: 'stub', provider_ref: ref, approval_code: 'A1', brand: 'visa', last4: '4242', message: null }) as const;
const cardBack = async () => ({ status: 'approved' as const, provider: 'stub', provider_ref: 'r', approval_code: null, message: null });

async function setup() {
  const store = new MemoryEventStore();
  const session = new SaleSession({ store, tenancy, catalogVersion: () => 1, uuid: randomUUID });
  await session.restore();
  return { store, session };
}

const receipt = (sale: FoldedSale) =>
  receiptText(
    renderReceipt({
      header: { merchant_name: 'Deli', location_name: 'Jersey City', address_line1: null, city_state_zip: null, register_name: 'R1' },
      sale,
      occurred_at: '2026-09-27T12:00:00.000Z',
      timezone: 'America/New_York',
      copy: 'original',
    }),
  );

describe('a tax-inclusive item alone', () => {
  it('rings at exactly the marked price; the tax is inside it', async () => {
    const { session, store } = await setup();
    await session.addItem(CIGS);
    await session.addItem(CIGS);
    await session.addItem(CIGS); // qty 3: $30.00 marked
    const s = session.state().sale!;
    // 3000 ÷ 1.06625 = 2813.6 → 2814 before tax, 186 tax
    expect(s.cash).toEqual({ subtotal_cents: 2_814, tax_cents: 186, total_cents: 3_000, included_tax_cents: 186 });
    expect(shownTotals(s.cash)).toMatchObject({ items_cents: 3_000, added_tax_cents: 0, included_tax_cents: 186, total_cents: 3_000 });
    const { sale } = await session.tenderCash(cents(3_000));
    expect(sale).toMatchObject({ status: 'completed', paid_cents: 3_000, mismatch: false });
    // The event says so: the flag on the line, the included tax on the completion.
    const events = await store.unacked(100);
    const added = events.find((e) => e.type === 'sale.line_added')!;
    expect(added.type === 'sale.line_added' && added.payload).toMatchObject({ unit_cash_price_cents: 1_000, tax_rate_ppm: 66_250, tax_included: true });
    const completed = events.find((e) => e.type === 'sale.completed')!;
    expect(completed.type === 'sale.completed' && completed.payload).toMatchObject({ subtotal_cents: 2_814, tax_cents: 186, total_cents: 3_000, included_tax_cents: 186 });
  });
});

describe('a ticket mixing tax-inclusive and normal items', () => {
  async function mixedCashSale() {
    const ctx = await setup();
    await ctx.session.addItem(CIGS);
    await ctx.session.addItem(SODA);
    const { sale } = await ctx.session.tenderCash(cents(2_000));
    return { ...ctx, sale };
  }

  it('totals: the marked $10.00 plus $5.00 plus tax on the soda only', async () => {
    const { sale } = await mixedCashSale();
    expect(sale.cash).toEqual({ subtotal_cents: 1_438, tax_cents: 95, total_cents: 1_533, included_tax_cents: 62 });
    expect(sale.paid_cents).toBe(1_533); // 1000 + 500 + 33
    expect(sale.tenders[0]!.change_cents).toBe(467);
    expect(sale.mismatch).toBe(false);
  });

  it('receipt: prices as marked, tax added only to the soda, the tax inside the cigarettes and the whole tax shown', async () => {
    const { sale } = await mixedCashSale();
    const text = receipt(sale);
    expect(text).toMatch(/Marlboro Red \*\s+\$10\.00/);
    expect(text).toMatch(/Soda\s+\$5\.00/);
    expect(text).toMatch(/Subtotal\s+\$15\.00/);
    expect(text).toMatch(/Tax 6\.625% on \$5\.00\s+\$0\.33/);
    expect(text).toMatch(/TOTAL\s+\$15\.33/);
    expect(text).toMatch(/\* Incl\. tax 6\.625% on \$9\.38\s+\$0\.62/);
    expect(text).toMatch(/Total tax\s+\$0\.95/);
    expect(text).toContain('* Price includes tax');
    // Never tax added to a price that already had it.
    expect(text).not.toMatch(/on \$15\.00/);
  });

  it('books: Z-report, sales-tax report and profit count the tax inside the price as tax', async () => {
    const { sale, store } = await mixedCashSale();
    const events = await store.unacked(100);
    const z = buildZReport(events, { z_number: 1, register_id: tenancy.register_id, business_date: '2026-09-27', from_seq: -1, categoryName: () => 'All' });
    expect(z).toMatchObject({ gross_cents: 1_533, tax_cents: 95, tax_by_rate: [{ rate_ppm: 66_250, taxable_cents: 1_438, tax_cents: 95 }] });
    expect(z.by_category.reduce((n, c) => n + c.amount_cents, 0)).toBe(1_438); // category sales are before tax
    expect(saleTaxGroups(sale)).toEqual([{ rate_ppm: 66_250, taxable_cents: 1_438, tax_cents: 95, included_tax_cents: 62, added_base_cents: 500 }]);
    expect(saleSubtotal(sale)).toBe(1_438);
    const margin = marginReport([{ ...sale, occurred_at: '2026-09-27T12:00:00.000Z' }], () => null, () => 'All', { from: '2026-09-27', to: '2026-09-27' });
    expect(margin.items.find((i) => i.name === 'Marlboro Red')!.revenue_cents).toBe(938);
    expect(margin.total.revenue_cents).toBe(1_438);
  });

  it('replays from the events alone to the same split', async () => {
    const { sale, store } = await mixedCashSale();
    const again = foldSale(sale.sale_id, await store.unacked(100));
    expect(again.cash).toEqual(sale.cash);
    expect(again.declared).toEqual(sale.cash);
  });
});

describe('refunding a tax-inclusive item', () => {
  it('gives back exactly the marked price, and the tax report takes its tax back out', async () => {
    const { session } = await setup();
    await session.addItem(CIGS);
    await session.addItem(SODA);
    const { sale } = await session.tenderCash(cents(2_000));
    const cigs = sale.lines.find((l) => l.name === 'Marlboro Red')!;
    const soda = sale.lines.find((l) => l.name === 'Soda')!;
    const r = await session.refund(sale.sale_id, [{ line_id: cigs.line_id, qty: 1 }], 'Wrong brand');
    expect(r.amount).toBe(1_000);
    expect(refundTax(sale, [{ line_id: cigs.line_id, qty: 1 }])).toBe(62);
    // The rest refunds the exact remainder: the soda with its added tax.
    const rest = await session.refund(sale.sale_id, [{ line_id: soda.line_id, qty: 1 }], 'Changed mind');
    expect(rest.amount).toBe(533);
    expect(rest.sale.refunded_cents).toBe(sale.paid_cents);
  });
});

describe('a tax-inclusive item inside a split tender', () => {
  it('cash part at the cash price, card part at the card price; all the tax is inside, none added', async () => {
    const { session } = await setup();
    await session.addItem(CIGS);
    const before = session.state().sale!;
    // Card $10.40 inclusive: 1040 ÷ 1.06625 = 975.4 → 975, tax 65.
    expect(before.card).toEqual({ subtotal_cents: 975, tax_cents: 65, total_cents: 1_040, included_tax_cents: 65 });
    await session.tenderCash(cents(500), { partial: true });
    const { tender_id, amount } = await session.startCard();
    expect(amount).toBe(520); // half the ticket at the card price
    const { sale } = await session.finishCard(tender_id, amount, approved('stub_split_incl'));
    expect(sale).toMatchObject({ status: 'completed', price_mode: 'split', paid_cents: 1_020, mismatch: false });
    // Tax blended by what each tender covered: (62 × 500 + 65 × 500) ÷ 1000 = 63.5 → 64, all of it inside the prices.
    expect(sale.declared).toEqual({ subtotal_cents: 956, tax_cents: 64, total_cents: 1_020, included_tax_cents: 64 });
    expect(shownTotals(sale.declared!)).toMatchObject({ items_cents: 1_020, added_tax_cents: 0 });
    const text = receipt(sale);
    expect(text).toMatch(/TOTAL\s+\$10\.20/);
    expect(text).not.toMatch(/Tax 6\.625% on/); // no tax added on top
    expect(text).toMatch(/Total tax\s+\$0\.64/);
    // Voiding it returns each part to how it was paid.
    const v = await session.voidCompleted(sale.sale_id, 'Mistake', cardBack);
    expect(v.amount).toBe(1_020);
  });

  it('mixed with a normal item: the tenders add up to the total, and total = subtotal + tax', async () => {
    const { session } = await setup();
    await session.addItem(CIGS);
    await session.addItem(SODA);
    const before = session.state().sale!;
    expect(before.card).toEqual({ subtotal_cents: 1_495, tax_cents: 99, total_cents: 1_594, included_tax_cents: 65 });
    await session.tenderCash(cents(500), { partial: true });
    const { tender_id, amount } = await session.startCard();
    expect(amount).toBe(cardAmountFor(1_033, 1_533, 1_594)); // 1074
    const { sale } = await session.finishCard(tender_id, amount, approved('stub_split_mixed'));
    expect(sale.mismatch).toBe(false);
    const d = sale.declared!;
    expect(d.total_cents).toBe(500 + amount);
    expect(d.subtotal_cents + d.tax_cents).toBe(d.total_cents);
    expect(d).toMatchObject({ tax_cents: 98, included_tax_cents: 64 });
    // What the customer reads adds up: items as marked + tax added = total.
    const shown = shownTotals(d);
    expect(shown.items_cents + shown.added_tax_cents).toBe(d.total_cents);
    const groups = saleTaxGroups(sale);
    expect(groups.reduce((n, g) => n + g.tax_cents, 0)).toBe(98);
  });
});
