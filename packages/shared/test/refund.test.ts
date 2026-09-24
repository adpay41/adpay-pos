import { describe, expect, it } from 'vitest';
import { foldSale, parseRegisterEvent, refundQuote, refundableQty, type RegisterEvent } from '../src';

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
  parseRegisterEvent({
    event_id: `90000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`, schema_version: 1, sale_id: SALE, device_seq: seq,
    occurred_at: '2026-09-24T12:00:00Z', ...T, trace_id: 't', actor_user_id: null, type, payload,
  });

function sale(mode: 'cash' | 'card') {
  seq = 0;
  // 2 × $2.99 soda (taxable 6.625%) + 1 × $12.50 cigarettes (non-taxable). Cash price vs card price differ.
  const events = [
    ev('sale.opened', { cashier_user_id: null, catalog_version: 1 }),
    ev('sale.line_added', { line_id: L1, item_id: L1, name: 'Soda', category_id: null, qty: 2, unit_cash_price_cents: 299, unit_card_price_cents: 311, taxable: true, tax_rate_ppm: 66_250, min_age: null }),
    ev('sale.line_added', { line_id: L2, item_id: L2, name: 'Cigarettes', category_id: null, qty: 1, unit_cash_price_cents: 1_250, unit_card_price_cents: 1_300, taxable: false, tax_rate_ppm: 0, min_age: 21 }),
  ];
  const s0 = foldSale(SALE, events);
  const t = mode === 'cash' ? s0.cash : s0.card;
  events.push(
    ev('sale.tender_added', {
      tender_id: '90000000-0000-4000-8000-0000000000aa', tender_type: mode, amount_cents: t.total_cents, tendered_cents: mode === 'cash' ? t.total_cents : null,
      change_cents: mode === 'cash' ? 0 : null,
      card: mode === 'card' ? { provider: 'stub', provider_ref: 'x', status: 'approved', approval_code: '1', brand: 'visa', last4: '4242' } : null,
    }),
    ev('sale.completed', { price_mode: mode, ...t }),
  );
  return events;
}

describe('refunds at the price paid', () => {
  it('a cash sale refunds the cash price with its tax; a card sale refunds the card price', () => {
    const cash = foldSale(SALE, sale('cash'));
    // one soda back: 299 + 6.625% (19.8 → 20) = 319
    expect(refundQuote(cash, [{ line_id: L1, qty: 1 }]).amount_cents).toBe(319);
    const card = foldSale(SALE, sale('card'));
    // one soda at card price: 311 + 20.6 → 21 = 332
    expect(refundQuote(card, [{ line_id: L1, qty: 1 }]).amount_cents).toBe(332);
  });

  it('returning everything refunds exactly what was paid; partial refunds are tracked per line', () => {
    const events = sale('cash');
    const s = foldSale(SALE, events);
    const everything = refundQuote(s, [{ line_id: L1, qty: 2 }, { line_id: L2, qty: 1 }]);
    expect(everything).toMatchObject({ full: true, amount_cents: s.paid_cents });

    events.push(ev('sale.refunded', { refund_id: '90000000-0000-4000-8000-0000000000bb', tender_type: 'cash', amount_cents: 319, reason: 'Damaged', by_user_id: null, card: null, lines: [{ line_id: L1, qty: 1 }] }));
    const after = foldSale(SALE, events);
    expect(after.refunded_cents).toBe(319);
    expect(refundableQty(after)).toEqual({ [L1]: 1, [L2]: 1 });
    // The rest now refunds exactly the remainder — no stray cent from rounding the two soda refunds apart.
    const rest = refundQuote(after, [{ line_id: L1, qty: 1 }, { line_id: L2, qty: 1 }]);
    expect(rest.full).toBe(true);
    expect(rest.amount_cents).toBe(after.paid_cents - 319);
    expect(() => refundQuote(after, [{ line_id: L1, qty: 2 }])).toThrow(/Only 1/);
  });

  it('only completed sales can be refunded', () => {
    seq = 0;
    const open = foldSale(SALE, [ev('sale.opened', { cashier_user_id: null, catalog_version: 1 })]);
    expect(() => refundQuote(open, [])).toThrow(/completed/);
  });
});
