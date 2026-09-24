import { describe, expect, it } from 'vitest';
import { complianceCsv, foldSale, parseRegisterEvent, refundTax, saleCharges, saleSubtotal, saleTaxGroups, salesTaxCsv, type RegisterEvent } from '../src';

const T = {
  org_id: '10000000-0000-4000-8000-000000000001',
  merchant_id: '20000000-0000-4000-8000-000000000001',
  location_id: '30000000-0000-4000-8000-000000000001',
  register_id: '40000000-0000-4000-8000-000000000001',
};
const SALE = '70000000-0000-4000-8000-000000000001';
const L1 = '80000000-0000-4000-8000-000000000001';
const L2 = '80000000-0000-4000-8000-000000000002';
let seq = 0;
const ev = (type: string, payload: unknown): RegisterEvent =>
  parseRegisterEvent({ event_id: `90000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`, schema_version: 1, sale_id: SALE, device_seq: seq, occurred_at: '2026-09-24T12:00:00Z', ...T, trace_id: 't', actor_user_id: null, type, payload });

function sale() {
  seq = 0;
  // 3 waters at $1.99 with a 5¢ deposit (taxable 8.875%) + $10 lottery (not taxable), cash.
  const events = [
    ev('sale.opened', { cashier_user_id: null, catalog_version: 1 }),
    ev('sale.line_added', {
      line_id: L1, item_id: L1, name: 'Water', category_id: null, qty: 3, unit_cash_price_cents: 199, unit_card_price_cents: 207, taxable: true, tax_rate_ppm: 88_750, min_age: null,
      charges: [{ rule_id: L2, kind: 'deposit', label: 'NY bottle deposit', unit_cash_cents: 5, unit_card_cents: 5, taxable: false }],
    }),
    ev('sale.line_added', { line_id: L2, item_id: L2, name: 'Scratch-Off $10', category_id: null, qty: 1, unit_cash_price_cents: 1_000, unit_card_price_cents: 1_000, taxable: false, tax_rate_ppm: 0, min_age: 18 }),
  ];
  const s0 = foldSale(SALE, events);
  events.push(ev('sale.tender_added', { tender_id: L1, tender_type: 'cash', amount_cents: s0.cash.total_cents, tendered_cents: 2_000, change_cents: 2_000 - s0.cash.total_cents, card: null }), ev('sale.completed', { price_mode: 'cash', ...s0.cash }));
  return foldSale(SALE, events);
}

describe('sales-tax report helpers', () => {
  it('splits a sale into taxable by rate, non-taxable, and deposits', () => {
    const s = sale();
    // waters 597 + deposits 15 + lottery 1000 = 1612; tax 8.875% of 597 = 52.98 → 53
    expect(saleSubtotal(s)).toBe(1_612);
    expect(saleTaxGroups(s)).toEqual([{ rate_ppm: 88_750, taxable_cents: 597, tax_cents: 53 }]);
    expect(saleCharges(s)).toBe(15);
  });
  it('tax inside a refund of one unit', () => {
    // 199 × 8.875% = 17.66 → 18
    expect(refundTax(sale(), [{ line_id: L1, qty: 1 }])).toBe(18);
    expect(refundTax(sale(), [{ line_id: L2, qty: 1 }])).toBe(0);
  });
  it('CSV: a column pair per rate, a row per month and a total', () => {
    const p = { sales_count: 1, gross_sales_cents: 1_612, taxable_cents: 597, non_taxable_cents: 1_015, tax_cents: 53, by_rate: [{ rate_ppm: 88_750, taxable_cents: 597, tax_cents: 53 }], deposits_fees_cents: 15, refunds_cents: 0, refunds_tax_cents: 0, net_tax_cents: 53 };
    const csv = salesTaxCsv({ from: '2026-07-01', to: '2026-09-30', location_name: null, total: { ...p, period: '2026-07-01 – 2026-09-30' }, by_month: [{ ...p, period: '2026-09' }] });
    const [head, sep, total] = csv.trim().split('\n');
    expect(head).toBe('Period,Sales,Gross sales,Taxable,Non-taxable,Taxable @8.875%,Tax @8.875%,Tax collected,Deposits & fees,Refunds,Tax refunded,Net tax');
    expect(sep).toBe('2026-09,1,16.12,5.97,10.15,5.97,0.53,0.53,0.15,0.00,0.00,0.53');
    expect(total!.startsWith('2026-07-01 – 2026-09-30,1,16.12')).toBe(true);
  });
  it('compliance CSV quotes names and says how the age was checked', () => {
    const csv = complianceCsv([{ at: '2026-09-24T12:00:00.000Z', register_name: 'Register 1', cashier_name: 'Santos, Maria', item_name: 'Newport', restriction: 'tobacco', min_age: 21, method: 'id_scan', scanned_age: 34, jurisdiction: 'NJ', sale_id: SALE }]);
    expect(csv.split('\n')[1]).toBe('2026-09-24T12:00:00.000Z,Register 1,"Santos, Maria",Newport,tobacco,21,ID scanned,34,NJ,70000000');
  });
});
