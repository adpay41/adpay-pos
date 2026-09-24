import { describe, expect, it } from 'vitest';
import { buildZReport, parseRegisterEvent, renderZReport, zTotals, type RegisterEvent } from '../src';

const T = {
  org_id: '10000000-0000-4000-8000-000000000001',
  merchant_id: '20000000-0000-4000-8000-000000000001',
  location_id: '30000000-0000-4000-8000-000000000001',
  register_id: '40000000-0000-4000-8000-000000000001',
};
const DRINKS = '50000000-0000-4000-8000-000000000001';
const id = (n: number) => `90000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
let seq = 0;
const ev = (type: string, payload: unknown, sale_id: string | null = null): RegisterEvent =>
  parseRegisterEvent({ event_id: id(1000 + ++seq), schema_version: 1, sale_id, device_seq: seq, occurred_at: '2026-09-24T15:00:00Z', ...T, trace_id: 't', actor_user_id: null, type, payload });
const line = (sale: string, n: number, cash: number, card: number, category: string | null, taxable = true) =>
  ev('sale.line_added', { line_id: id(n), item_id: id(n + 100), name: `Item ${n}`, category_id: category, qty: 1, unit_cash_price_cents: cash, unit_card_price_cents: card, taxable, tax_rate_ppm: taxable ? 66_250 : 0, min_age: null }, sale);

function day(): RegisterEvent[] {
  seq = 0;
  const S1 = id(1);
  const S2 = id(2);
  const S3 = id(3);
  return [
    ev('drawer.session_opened', { session_id: id(50), float_cents: 10_000 }),
    // Cash sale: $2.00 drink (taxable 6.625% → 13¢) = $2.13
    ev('sale.opened', { cashier_user_id: null, catalog_version: 1 }, S1),
    line(S1, 11, 200, 208, DRINKS),
    ev('sale.tender_added', { tender_id: id(61), tender_type: 'cash', amount_cents: 213, tendered_cents: 500, change_cents: 287, card: null }, S1),
    ev('sale.completed', { price_mode: 'cash', subtotal_cents: 200, tax_cents: 13, total_cents: 213 }, S1),
    // Card sale: $10 lottery (not taxable) at card price $10
    ev('sale.opened', { cashier_user_id: null, catalog_version: 1 }, S2),
    line(S2, 12, 1_000, 1_000, null, false),
    ev('sale.tender_added', { tender_id: id(62), tender_type: 'card', amount_cents: 1_000, tendered_cents: null, change_cents: null, card: { provider: 'stub', provider_ref: 'r', status: 'approved', approval_code: '1', brand: 'visa', last4: '4242' } }, S2),
    ev('sale.completed', { price_mode: 'card', subtotal_cents: 1_000, tax_cents: 0, total_cents: 1_000 }, S2),
    // A ticket voided before payment: not a sale
    ev('sale.opened', { cashier_user_id: null, catalog_version: 1 }, S3),
    line(S3, 13, 500, 520, DRINKS),
    ev('sale.voided', { reason: 'changed mind', by_user_id: null }, S3),
    // A cash refund of the drink, a no-sale, a counterfeit, then the count
    ev('sale.refunded', { refund_id: id(70), tender_type: 'cash', amount_cents: 213, reason: 'Returned', by_user_id: null, card: null, lines: [{ line_id: id(11), qty: 1 }] }, S1),
    ev('drawer.opened', { reason: 'manual', by_user_id: null }),
    ev('drawer.counterfeit', { session_id: id(50), denomination_cents: 2_000, note: null }),
    ev('drawer.session_closed', { session_id: id(50), counted_cents: 10_000, blind: true }),
  ];
}

describe('Z-report', () => {
  const names = (c: string | null) => (c === DRINKS ? 'Drinks' : 'No category');
  it('by tender, by category, tax by rate, refunds, voids, drawer', () => {
    const z = buildZReport(day(), { z_number: 7, register_id: T.register_id, business_date: '2026-09-24', from_seq: 0, categoryName: names });
    expect(z).toMatchObject({
      z_number: 7,
      sales_count: 2,
      gross_cents: 1_213,
      by_tender: { cash_cents: 213, card_cents: 1_000, cash_count: 1, card_count: 1 },
      tax_by_rate: [{ rate_ppm: 66_250, taxable_cents: 200, tax_cents: 13 }],
      tax_cents: 13,
      refunds: { count: 1, cash_cents: 213, card_cents: 0 },
      voids: 1,
      no_sales: 1,
      counterfeits: 1,
    });
    expect(z.by_category).toEqual([
      { category_id: null, name: 'No category', qty: 1, amount_cents: 1_000 },
      { category_id: DRINKS, name: 'Drinks', qty: 1, amount_cents: 200 },
    ]);
  });

  it('spec acceptance: the Z cash count matches the sum of the cash events', () => {
    const events = day();
    const z = buildZReport(events, { z_number: 1, register_id: T.register_id, business_date: '2026-09-24', from_seq: 0, categoryName: names });
    // float 100.00 + cash taken 2.13 − cash refunded 2.13 = 100.00 expected; counted 100.00
    const cashIn = events.filter((e) => e.type === 'sale.tender_added' && e.payload.tender_type === 'cash').reduce((n, e) => n + (e.payload as { amount_cents: number }).amount_cents, 0);
    const cashOut = events.filter((e) => e.type === 'sale.refunded' && e.payload.tender_type === 'cash').reduce((n, e) => n + (e.payload as { amount_cents: number }).amount_cents, 0);
    expect(z.drawer).toEqual({ sessions: 1, float_cents: 10_000, expected_cents: 10_000 + cashIn - cashOut, counted_cents: 10_000, over_short_cents: 0 });
  });

  it('declares totals for the server to check, and prints on 48 columns', () => {
    const z = buildZReport(day(), { z_number: 2, register_id: T.register_id, business_date: '2026-09-24', from_seq: 0, categoryName: names });
    expect(zTotals(z)).toEqual({ sales_count: 2, gross_cents: 1_213, tax_cents: 13, voids: 1, cash_cents: 213, card_cents: 1_000, refunds_cents: 213 });
    const lines = renderZReport(z, { merchant_name: 'Bodega', location_name: 'Main', register_name: 'Register 1', timezone: 'America/New_York' });
    expect(lines.every((l) => l.length <= 48)).toBe(true);
    expect(lines.some((l) => l.includes('Z-REPORT #2'))).toBe(true);
    expect(lines.some((l) => /Sales \(2\)\s+\$12\.13/.test(l))).toBe(true);
  });
});
