import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { adjustPrice, BulkPriceInput, foldSale, marginReport, marginTenths, parseRegisterEvent, roundUpPrice } from '../src';

describe('bulk price change', () => {
  it('+5%, −10%, +25¢, set; half-up; never below a cent', () => {
    expect(adjustPrice(299, { kind: 'percent', ppm: 50_000 }, 'none')).toBe(314); // 14.95 → 15
    expect(adjustPrice(299, { kind: 'percent', ppm: -100_000 }, 'none')).toBe(269); // 29.9 → 30
    expect(adjustPrice(299, { kind: 'amount', cents: 25 }, 'none')).toBe(324);
    expect(adjustPrice(299, { kind: 'set', cents: 349 }, 'none')).toBe(349);
    expect(adjustPrice(20, { kind: 'amount', cents: -50 }, 'none')).toBe(1);
  });

  it('rounds up to …9 or .99', () => {
    expect(roundUpPrice(343, 'up_9')).toBe(349);
    expect(roundUpPrice(349, 'up_9')).toBe(349);
    expect(roundUpPrice(350, 'up_9')).toBe(359);
    expect(roundUpPrice(343, 'up_99')).toBe(399);
    expect(roundUpPrice(399, 'up_99')).toBe(399);
    expect(adjustPrice(299, { kind: 'percent', ppm: 50_000 }, 'up_9')).toBe(319);
  });

  it('needs something to change and a real change', () => {
    expect(BulkPriceInput.safeParse({ change: { kind: 'percent', ppm: 50_000 } }).success).toBe(false);
    expect(BulkPriceInput.safeParse({ item_ids: [randomUUID()], change: { kind: 'amount', cents: 0 } }).success).toBe(false);
  });
});

describe('profit', () => {
  const t = { org_id: randomUUID(), merchant_id: randomUUID(), location_id: randomUUID(), register_id: randomUUID() };
  const TOBACCO = randomUUID();
  const SNACKS = randomUUID();
  const MARLBORO = randomUUID();
  const CHIPS = randomUUID();
  const MYSTERY = randomUUID();

  function sale(lines: { item: string; cat: string; cash: number; qty: number; refund?: number }[], mode: 'cash' | 'card' = 'cash') {
    const id = randomUUID();
    let seq = 0;
    const events = [] as ReturnType<typeof parseRegisterEvent>[];
    const ev = (type: string, payload: unknown) => events.push(parseRegisterEvent({ event_id: randomUUID(), schema_version: 1, sale_id: id, device_seq: seq++, occurred_at: '2026-09-20T15:00:00.000Z', ...t, trace_id: 'x', type, payload }));
    ev('sale.opened', { cashier_user_id: null, catalog_version: 1 });
    const ids = lines.map((l) => {
      const line_id = randomUUID();
      ev('sale.line_added', { line_id, item_id: l.item, name: l.item === MARLBORO ? 'Marlboro' : l.item === CHIPS ? 'Chips' : 'Mystery', category_id: l.cat, qty: l.qty, unit_cash_price_cents: l.cash, unit_card_price_cents: l.cash + 50, taxable: false, tax_rate_ppm: 0, min_age: null });
      return line_id;
    });
    const open = foldSale(id, events);
    const total = mode === 'card' ? open.card.total_cents : open.cash.total_cents;
    ev('sale.tender_added', { tender_id: randomUUID(), tender_type: mode, amount_cents: total, tendered_cents: mode === 'cash' ? total : null, change_cents: mode === 'cash' ? 0 : null, card: mode === 'card' ? { provider: 'stub', provider_ref: 'r', status: 'approved', approval_code: null, brand: null, last4: null } : null });
    ev('sale.completed', { price_mode: mode, ...(mode === 'card' ? open.card : open.cash) });
    lines.forEach((l, i) => {
      if (l.refund) ev('sale.refunded', { refund_id: randomUUID(), tender_type: 'cash', amount_cents: l.cash * l.refund, reason: 'Returned', by_user_id: null, card: null, lines: [{ line_id: ids[i]!, qty: l.refund }] });
    });
    return { ...foldSale(id, events), occurred_at: '2026-09-20T15:00:00.000Z' };
  }

  it('tobacco is most of the sales and little of the profit; refunds come off; uncosted items are counted apart', () => {
    const cost: Record<string, number> = { [MARLBORO]: 1_300, [CHIPS]: 90 };
    const r = marginReport(
      [sale([{ item: MARLBORO, cat: TOBACCO, cash: 1_400, qty: 3, refund: 1 }, { item: CHIPS, cat: SNACKS, cash: 199, qty: 4 }]), sale([{ item: MYSTERY, cat: SNACKS, cash: 500, qty: 1 }], 'card')],
      (item) => cost[item] ?? null,
      (c) => (c === TOBACCO ? 'Tobacco' : 'Snacks'),
      { from: '2026-09-20', to: '2026-09-20' },
    );
    expect(r.categories.find((c) => c.name === 'Tobacco')).toMatchObject({ units: 2, revenue_cents: 2_800, cost_cents: 2_600 });
    expect(r.categories.find((c) => c.name === 'Snacks')).toMatchObject({ units: 5, revenue_cents: 796 + 550, cost_cents: 360, costed_revenue_cents: 796, units_without_cost: 1 });
    expect(marginTenths(r.categories.find((c) => c.name === 'Tobacco')!)).toBe(71); // 7.1%
    expect(marginTenths(r.categories.find((c) => c.name === 'Snacks')!)).toBe(548); // 54.8%
    expect(r.items[0]!.name).toBe('Chips'); // most profit first
  });

  it('flags units sold below cost', () => {
    const r = marginReport([sale([{ item: CHIPS, cat: SNACKS, cash: 80, qty: 2 }])], () => 90, () => 'Snacks', { from: 'a', to: 'b' });
    expect(r.total.units_below_cost).toBe(2);
  });
});
