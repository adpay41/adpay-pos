/**
 * Check and other tenders (ADR 0050), through the session: at the cash price, never more than is due
 * and no change, cash + check stays a cash-price sale, a card with anything else is split, the Z and
 * the receipt name them, the drawer counts only cash, and a check sale refunds in cash.
 */
import { randomUUID } from 'node:crypto';
import { buildZReport, cents, foldDrawer, receiptText, renderReceipt, type CatalogItem } from '@adpay/shared';
import { describe, expect, it } from 'vitest';
import { SaleError, SaleSession } from '../src/core/session';
import { MemoryEventStore } from '../src/core/store';

const tenancy = { org_id: randomUUID(), merchant_id: randomUUID(), location_id: randomUUID(), register_id: randomUUID() };
// $20.00 cash / $20.80 card, taxed 6.625%: 2133 cash, 2218 card.
const PLATTER: CatalogItem = {
  item_id: randomUUID(), category_id: null, name: 'Party platter', sku: null, upc: null, plu: null, barcodes: [], cash_price_cents: 2_000,
  card_price_cents: 2_080, card_price_override: false, open_price: false, cost_cents: null, taxable: true, tax_rate_ppm: 66_250, min_age: null,
  sell_unit: 'each', pack_qty: 1, active: true, color: null, image_url: null, sort: 0,
};
const approved = { status: 'approved', provider: 'stub', provider_ref: 'stub_x', approval_code: 'A1', brand: 'visa', last4: '4242', message: null } as const;

async function setup() {
  const store = new MemoryEventStore();
  const session = new SaleSession({ store, tenancy, catalogVersion: () => 1, uuid: randomUUID });
  await session.restore();
  await session.addItem(PLATTER);
  return { store, session };
}
const receipt = (sale: Parameters<typeof renderReceipt>[0]['sale']) =>
  receiptText(renderReceipt({ header: { merchant_name: 'Deli', location_name: 'JC', address_line1: null, city_state_zip: null, register_name: 'R1' }, sale, occurred_at: '2026-09-27T12:00:00Z', timezone: 'America/New_York', copy: 'original' }));

describe('check and other tenders', () => {
  it('a check pays the ticket at the cash price, with its number on the receipt', async () => {
    const { session } = await setup();
    const r = await session.tenderOther('check', cents(2_133), { reference: '1042' });
    expect(r.completed).toBe(true);
    expect(r.sale).toMatchObject({ status: 'completed', price_mode: 'cash', paid_cents: 2_133, mismatch: false });
    expect(r.sale.tenders[0]).toMatchObject({ tender_type: 'check', reference: '1042', change_cents: 0, approved: true });
    expect(receipt(r.sale)).toMatch(/Check #1042\s+\$21\.33/);
  });

  it('never more than is due, and no change', async () => {
    const { session } = await setup();
    await expect(session.tenderOther('check', cents(2_500), { reference: null })).rejects.toBeInstanceOf(SaleError);
  });

  it('cash + check stays a cash-price sale, not split', async () => {
    const { session } = await setup();
    await session.tenderCash(cents(1_000), { partial: true });
    const r = await session.tenderOther('check', cents(1_133), { reference: '77' });
    expect(r.sale).toMatchObject({ price_mode: 'cash', paid_cents: 2_133, mismatch: false });
  });

  it('EBT for part and a card for the rest is split: the card pays its share at the card price', async () => {
    const { session } = await setup();
    const part = await session.tenderOther('other', cents(1_000), { reference: '4410', other_kind: 'ebt' });
    expect(part.completed).toBe(false);
    const { tender_id, amount } = await session.startCard();
    const r = await session.finishCard(tender_id, amount, approved);
    expect(r.sale).toMatchObject({ status: 'completed', price_mode: 'split', mismatch: false });
    expect(r.sale.paid_cents).toBe(1_000 + amount);
    expect(r.sale.paid_cents).toBeGreaterThan(2_133);
    expect(receipt(r.sale)).toMatch(/EBT #4410\s+\$10\.00/);
  });

  it('the Z names checks and other tenders; the drawer counts only the cash', async () => {
    const { session, store } = await setup();
    await session.tenderCash(cents(1_000), { partial: true });
    await session.tenderOther('check', cents(1_133), { reference: null });
    await session.addItem(PLATTER);
    await session.tenderOther('other', cents(2_133), { reference: null, other_kind: 'gift_card' });
    const events = await store.unacked(200);
    const z = buildZReport(events, { z_number: 1, register_id: tenancy.register_id, business_date: '2026-09-27', from_seq: -1, categoryName: () => 'All' });
    expect(z.by_tender).toMatchObject({ cash_cents: 1_000, cash_count: 1, check_cents: 1_133, check_count: 1, other_cents: 2_133, other_count: 1, card_cents: 0 });
    expect(z.gross_cents).toBe(4_266);
    // Only the $10.00 cash is drawer cash; the $11.33 check and the gift card never are.
    const drawer = foldDrawer(events);
    expect(drawer.unassigned_cash_cents + drawer.sessions.reduce((n, d) => n + d.cash_sales_cents, 0)).toBe(1_000);
  });

  it('a check sale refunds in cash', async () => {
    const { session } = await setup();
    const { sale } = await session.tenderOther('check', cents(2_133), { reference: '1042' });
    const r = await session.refund(sale.sale_id, [{ line_id: sale.lines[0]!.line_id, qty: 1 }], 'Returned');
    expect(r).toMatchObject({ tender: 'cash', amount: 2_133 });
  });
});
