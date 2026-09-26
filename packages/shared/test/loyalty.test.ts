import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { customerRef, foldSale, LoyaltySettingsInput, loyaltyStatus, normalizeUsPhone, parseRegisterEvent, rewardDiscounts, earned } from '../src';

const COFFEE = randomUUID();
const t = { org_id: randomUUID(), merchant_id: randomUUID(), location_id: randomUUID(), register_id: randomUUID() };
const REF = customerRef('salt-1', '+12015550199');

function sale(lines: { name: string; cash: number; card?: number; qty?: number; cat?: string | null }[], opts: { complete?: boolean; redeem?: number; voided?: boolean } = {}) {
  const id = randomUUID();
  let seq = 0;
  const ev = (type: string, payload: unknown) =>
    parseRegisterEvent({ event_id: randomUUID(), schema_version: 1, sale_id: id, device_seq: seq++, occurred_at: '2026-09-25T12:00:00.000Z', ...t, trace_id: 'x', type, payload });
  const events = [ev('sale.opened', { cashier_user_id: null, catalog_version: 1 })];
  for (const l of lines)
    events.push(
      ev('sale.line_added', {
        line_id: randomUUID(), item_id: randomUUID(), name: l.name, category_id: l.cat ?? null, qty: l.qty ?? 1,
        unit_cash_price_cents: l.cash, unit_card_price_cents: l.card ?? l.cash, taxable: false, tax_rate_ppm: 0, min_age: null,
      }),
    );
  events.push(ev('sale.customer_identified', { customer_ref: REF, last4: '0199', marketing_opt_in: false }));
  if (opts.redeem) events.push(ev('sale.loyalty_redeemed', { customer_ref: REF, cost: opts.redeem, discount_cents: 275 }));
  const open = foldSale(id, events);
  if (opts.complete !== false) {
    events.push(
      ev('sale.tender_added', { tender_id: randomUUID(), tender_type: 'cash', amount_cents: open.cash.total_cents, tendered_cents: open.cash.total_cents, change_cents: 0, card: null }),
      ev('sale.completed', { price_mode: 'cash', ...open.cash }),
    );
  }
  if (opts.voided) events.push(ev('sale.voided', { reason: 'x', by_user_id: null }));
  return foldSale(id, events);
}

describe('customer reference', () => {
  it('is a keyed hash: same number and salt → same ref; another store’s salt → another ref', () => {
    expect(REF).toMatch(/^[0-9a-f]{64}$/);
    expect(customerRef('salt-1', '+12015550199')).toBe(REF);
    expect(customerRef('salt-2', '+12015550199')).not.toBe(REF);
    expect(REF).not.toContain('2015550199');
  });

  it('normalizes US numbers', () => {
    expect(normalizeUsPhone('(201) 555-0199')).toBe('+12015550199');
    expect(normalizeUsPhone('1-201-555-0199')).toBe('+12015550199');
    expect(normalizeUsPhone('555-0199')).toBeNull();
  });
});

describe('earning and balance', () => {
  const coffee5 = LoyaltySettingsInput.parse({ enabled: true, kind: 'visits', visits_needed: 5, qualifying_category_id: COFFEE, reward: { kind: 'free_item', max_cents: 400 } });

  it('a visit counts only with a qualifying item; voided and open sales earn nothing', () => {
    expect(earned(coffee5, sale([{ name: 'Coffee', cash: 275, cat: COFFEE }]))).toEqual({ visits: 1, points: 0 });
    expect(earned(coffee5, sale([{ name: 'Bagel', cash: 250 }]))).toEqual({ visits: 0, points: 0 });
    expect(earned(coffee5, sale([{ name: 'Coffee', cash: 275, cat: COFFEE }], { voided: true }))).toEqual({ visits: 0, points: 0 });
    expect(earned(coffee5, sale([{ name: 'Coffee', cash: 275, cat: COFFEE }], { complete: false }))).toEqual({ visits: 0, points: 0 });
  });

  it('the fifth coffee is free: balance, reward available, and what redeeming costs', () => {
    const four = Array.from({ length: 4 }, () => sale([{ name: 'Coffee', cash: 275, cat: COFFEE }]));
    expect(loyaltyStatus(coffee5, four)).toMatchObject({ balance: 4, needed: 5, rewards_available: 0, to_next: 1, visits: 4, spent_cents: 1100 });
    const five = [...four, sale([{ name: 'Coffee', cash: 275, cat: COFFEE }])];
    expect(loyaltyStatus(coffee5, five)).toMatchObject({ balance: 5, rewards_available: 1 });
    // The sixth ticket uses the reward (its own visit still counts).
    const sixth = sale([{ name: 'Coffee', cash: 275, cat: COFFEE }], { redeem: 5 });
    expect(sixth.loyalty).toEqual({ cost: 5, discount_cents: 275 });
    expect(loyaltyStatus(coffee5, [...five, sixth])).toMatchObject({ balance: 1, rewards_available: 0, to_next: 4 });
  });

  it('points per dollar of the cash-price subtotal, with a minimum ticket', () => {
    const pts = LoyaltySettingsInput.parse({ enabled: true, kind: 'points', points_per_dollar: 2, points_needed: 100, min_ticket_cents: 500 });
    expect(earned(pts, sale([{ name: 'Groceries', cash: 1_899 }]))).toEqual({ visits: 0, points: 36 });
    expect(earned(pts, sale([{ name: 'Gum', cash: 199 }]))).toEqual({ visits: 0, points: 0 });
  });
});

describe('applying a reward', () => {
  it('free item: the cheapest qualifying item, capped, both prices', () => {
    const s = LoyaltySettingsInput.parse({ enabled: true, qualifying_category_id: COFFEE, reward: { kind: 'free_item', max_cents: 300 } });
    const open = sale([{ name: 'Large coffee', cash: 325, card: 338, cat: COFFEE }, { name: 'Small coffee', cash: 175, card: 182, cat: COFFEE }, { name: 'Bagel', cash: 150 }], { complete: false });
    const r = rewardDiscounts(s, open)!;
    expect(r.lines).toEqual([{ line_id: open.lines[1]!.line_id, cash_discount_cents: 175, card_discount_cents: 182 }]);
    expect(r).toMatchObject({ discount_cents: 175, cost: 5 });
    expect(rewardDiscounts(s, sale([{ name: 'Bagel', cash: 150 }], { complete: false }))).toBeNull();
  });

  it('amount off: from the biggest line down, never below zero', () => {
    const s = LoyaltySettingsInput.parse({ enabled: true, kind: 'points', reward: { kind: 'amount_off', cents: 500 } });
    const open = sale([{ name: 'Sandwich', cash: 399 }, { name: 'Chips', cash: 179 }], { complete: false });
    expect(rewardDiscounts(s, open)).toMatchObject({
      lines: [
        { line_id: open.lines[0]!.line_id, cash_discount_cents: 399 },
        { line_id: open.lines[1]!.line_id, cash_discount_cents: 101 },
      ],
      discount_cents: 500,
      cost: 100,
    });
  });
});
