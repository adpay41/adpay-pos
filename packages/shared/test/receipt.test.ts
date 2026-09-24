import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  cents,
  changeDue,
  foldSale,
  parseRegisterEvent,
  quickCashOptions,
  RECEIPT_WIDTH,
  receiptText,
  renderReceipt,
  TenderError,
} from '../src';

describe('cash tender', () => {
  it('computes change and refuses short tender', () => {
    expect(changeDue(cents(1491), cents(2000))).toBe(509);
    expect(changeDue(cents(1491), cents(1491))).toBe(0);
    expect(() => changeDue(cents(1491), cents(1000))).toThrow(TenderError);
  });

  it('offers the amounts customers actually hand over', () => {
    expect(quickCashOptions(cents(1491))).toEqual([1491, 1500, 2000, 5000, 10000]);
    expect(quickCashOptions(cents(500))).toEqual([500, 1000, 2000, 5000, 10000]);
    // $50 and $100 must always be offered — they're what customers hand over most.
    expect(quickCashOptions(cents(2310))).toEqual([2310, 2400, 2500, 3000, 4000, 5000, 10000]);
    expect(quickCashOptions(cents(2039))).toContain(5000);
  });
});

describe('receipt', () => {
  const t = { org_id: randomUUID(), merchant_id: randomUUID(), location_id: randomUUID(), register_id: randomUUID() };
  const sale = randomUUID();
  let seq = 0;
  const ev = (type: string, payload: unknown) =>
    parseRegisterEvent({
      event_id: randomUUID(), schema_version: 1, sale_id: sale, device_seq: seq++,
      occurred_at: '2026-09-23T12:15:00.000Z', ...t, trace_id: 'r', type, payload,
    });
  const line = (name: string, cash: number, card: number, qty: number, taxable: boolean, min_age: number | null = null) =>
    ev('sale.line_added', {
      line_id: randomUUID(), item_id: randomUUID(), name, category_id: null, qty,
      unit_cash_price_cents: cash, unit_card_price_cents: card, taxable, tax_rate_ppm: taxable ? 66_250 : 0, min_age,
    });

  const cig = line('Marlboro Red — Pack', 1400, 1400, 1, false, 21);
  const events = [
    ev('sale.opened', { cashier_user_id: null, catalog_version: 1 }),
    line('Bacon, Egg & Cheese on a Roll', 599, 623, 2, true),
    cig,
    ev('sale.age_verified', { line_id: (cig.payload as { line_id: string }).line_id, method: 'manual', verified_by_user_id: null }),
  ];
  const provisional = foldSale(sale, events);
  const total = provisional.cash.total_cents; // 1198 + 79 tax + 1400 = 2677
  const done = [
    ...events,
    ev('sale.tender_added', { tender_id: randomUUID(), tender_type: 'cash', amount_cents: total, tendered_cents: 3000, change_cents: 3000 - total, card: null }),
    ev('sale.completed', { price_mode: 'cash', ...provisional.cash }),
  ];

  const lines = renderReceipt({
    header: { merchant_name: 'Journal Square Deli & Grocery', location_name: 'Jersey City', address_line1: '118 Newark Ave', city_state_zip: 'Jersey City, NJ 07302', register_name: 'Register 1' },
    sale: foldSale(sale, done),
    occurred_at: '2026-09-23T12:15:00.000Z',
    timezone: 'America/New_York',
    copy: 'original',
  });
  const text = receiptText(lines);

  it('fits an 80mm printer: no line wider than 48 columns', () => {
    for (const l of lines) expect(l.text.length).toBeLessThanOrEqual(RECEIPT_WIDTH);
  });

  it('shows the charged amounts, change, and both price totals', () => {
    expect(total).toBe(2677);
    expect(text).toContain('2 x Bacon, Egg & Cheese on a Roll');
    expect(text).toMatch(/TOTAL\s+\$26\.77/);
    expect(text).toMatch(/Change\s+\$3\.23/);
    expect(text).toMatch(/Cash price total\s+\$26\.77/);
    expect(text).toMatch(/Card price total\s+\$27\.29/); // 1246 + 83 tax + 1400 (face-value pack)
    expect(text).toContain('Age 21+ verified');
    expect(text).toContain('9/23/26, 8:15 AM'); // store-local time
  });

  it('marks reprints', () => {
    const reprint = renderReceipt({
      header: { merchant_name: 'X', location_name: 'Y', address_line1: null, city_state_zip: null, register_name: 'R1' },
      sale: foldSale(sale, done), occurred_at: '2026-09-23T12:15:00.000Z', timezone: 'America/New_York', copy: 'reprint',
    });
    expect(receiptText(reprint)).toContain('REPRINT');
  });
});
