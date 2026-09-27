/**
 * Tax-free sale (ADR 0049), through the session: no tax on any line, a tax-inclusive price drops to
 * its price before tax, the receipt says so with the certificate, refunds give back no tax, and
 * turning it off charges tax again.
 */
import { randomUUID } from 'node:crypto';
import { cents, permissionsFor, receiptText, renderReceipt, saleTaxGroups, type CatalogItem } from '@adpay/shared';
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
const CIGS = item('Marlboro Red', 1_000, 1_040, true, true);
const RESALE = { reason: 'resale' as const, certificate: 'ST3-00417' };

async function setup(...items: CatalogItem[]) {
  const store = new MemoryEventStore();
  const session = new SaleSession({ store, tenancy, catalogVersion: () => 1, uuid: randomUUID });
  await session.restore();
  for (const i of items) await session.addItem(i);
  return { store, session };
}

describe('tax-free sale', () => {
  it('no tax on any line; turning it off charges tax again', async () => {
    const { session } = await setup(SODA, SUB);
    expect(session.state().sale!.cash.tax_cents).toBe(20); // 299 × 6.625% = 19.8
    const s = (await session.setTaxExempt(RESALE)).sale!;
    expect(s.cash).toMatchObject({ subtotal_cents: 1_398, tax_cents: 0, total_cents: 1_398 });
    expect(s.tax_exempt).toEqual(RESALE);
    expect(saleTaxGroups({ ...s, price_mode: 'cash' })).toEqual([]);
    const back = (await session.setTaxExempt(null)).sale!;
    expect(back.tax_exempt).toBeNull();
    expect(back.cash.tax_cents).toBe(20);
  });

  it('a tax-inclusive price drops to its price before tax: $10.00 → $9.38 cash, $10.40 → $9.75 card', async () => {
    const { session } = await setup(CIGS);
    const s = (await session.setTaxExempt(RESALE)).sale!;
    expect(s.cash).toMatchObject({ subtotal_cents: 938, tax_cents: 0, total_cents: 938 });
    expect(s.card).toMatchObject({ total_cents: 975, tax_cents: 0 });
  });

  it('the receipt says tax exempt with the certificate; a refund gives back no tax', async () => {
    const { session } = await setup(SODA, SUB);
    await session.setTaxExempt(RESALE);
    const { sale } = await session.tenderCash(cents(1_398));
    expect(sale).toMatchObject({ status: 'completed', paid_cents: 1_398, mismatch: false });
    const text = receiptText(
      renderReceipt({ header: { merchant_name: 'Deli', location_name: 'JC', address_line1: null, city_state_zip: null, register_name: 'R1' }, sale, occurred_at: '2026-09-27T12:00:00Z', timezone: 'America/New_York', copy: 'original' }),
    );
    expect(text).toContain('Tax exempt #ST3-00417');
    expect(text).toMatch(/TOTAL\s+\$13\.98/);
    const soda = sale.lines.find((l) => l.name === 'Soda')!;
    expect((await session.refund(sale.sale_id, [{ line_id: soda.line_id, qty: 1 }], 'Returned')).amount).toBe(299);
  });

  it('cashiers need a manager for it by default', () => {
    expect(permissionsFor('cashier')).not.toContain('ticket.tax_exempt');
    expect(permissionsFor('manager')).toContain('ticket.tax_exempt');
  });
});
