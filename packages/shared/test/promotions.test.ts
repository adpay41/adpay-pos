import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  applyPromotions,
  foldSale,
  parseRegisterEvent,
  promotionActive,
  promotionChanges,
  PromotionInput,
  promotionText,
  receiptText,
  renderReceipt,
  type FoldedSale,
  type Promotion,
  type RegisterEvent,
} from '../src';

const RED_BULL = randomUUID();
const MONSTER = randomUUID();
const DRINKS = randomUUID();
const t = { org_id: randomUUID(), merchant_id: randomUUID(), location_id: randomUUID(), register_id: randomUUID() };
const ctx = (iso: string) => ({ location_id: t.location_id, at: new Date(iso), timezone: 'America/New_York', dual_price_rate_ppm: 40_000 });
const promo = (over: Partial<PromotionInput>): Promotion => ({ promo_id: randomUUID(), active: true, ...PromotionInput.parse({ name: 'Deal', starts_on: '2026-09-01', ...over }) });

function ticket(lines: { item: string; cash: number; card: number; qty?: number; cat?: string | null }[]) {
  const id = randomUUID();
  let seq = 0;
  const events: RegisterEvent[] = [];
  const ev = (type: string, payload: unknown) =>
    events.push(parseRegisterEvent({ event_id: randomUUID(), schema_version: 1, sale_id: id, device_seq: seq++, occurred_at: '2026-09-25T16:00:00.000Z', ...t, trace_id: 'x', type, payload }));
  ev('sale.opened', { cashier_user_id: null, catalog_version: 1 });
  for (const l of lines)
    ev('sale.line_added', {
      line_id: randomUUID(), item_id: l.item, name: l.item === RED_BULL ? 'Red Bull 12oz' : l.item === MONSTER ? 'Monster 16oz' : 'Chips', category_id: l.cat === undefined ? DRINKS : l.cat,
      qty: l.qty ?? 1, unit_cash_price_cents: l.cash, unit_card_price_cents: l.card, taxable: true, tax_rate_ppm: 66_250, min_age: null,
    });
  return { id, events, ev, fold: () => foldSale(id, events) };
}
/** Write what the engine asks for, as the register does. */
function settle(tk: ReturnType<typeof ticket>, promos: Promotion[], at: string): FoldedSale {
  const changes = promotionChanges(tk.fold(), applyPromotions(promos, tk.fold(), ctx(at)));
  for (const c of changes) tk.ev('sale.line_discounted', { line_id: c.line_id, cash_discount_cents: c.cash_discount_cents, card_discount_cents: c.card_discount_cents, reason: c.reason, promo_id: c.promo_id });
  return tk.fold();
}

describe('2 for $5, mix and match', () => {
  const twoFor5 = promo({ name: '2 for $5 energy drinks', rule: { kind: 'multi_price', qty: 2, price_cents: 500 }, item_ids: [RED_BULL, MONSTER] });

  it('any two qualifying cans for $5.00 cash, the card side at the card price of $5.00', () => {
    const tk = ticket([{ item: RED_BULL, cash: 299, card: 311 }, { item: MONSTER, cash: 329, card: 342 }]);
    const s = settle(tk, [twoFor5], '2026-09-25T16:00:00Z');
    expect(s.cash.subtotal_cents).toBe(500);
    expect(s.card.subtotal_cents).toBe(520); // $5.00 + 4%
    expect(s.lines.every((l) => l.discount_promo_id === twoFor5.promo_id)).toBe(true);
  });

  it('a third can pays full price; removing one of the pair undoes the deal', () => {
    const tk = ticket([{ item: RED_BULL, cash: 299, card: 311, qty: 3 }]);
    let s = settle(tk, [twoFor5], '2026-09-25T16:00:00Z');
    expect(s.cash.subtotal_cents).toBe(500 + 299);
    tk.ev('sale.line_qty_changed', { line_id: s.lines[0]!.line_id, qty: 1 });
    s = settle(tk, [twoFor5], '2026-09-25T16:00:00Z');
    expect(s.cash.subtotal_cents).toBe(299);
    expect(s.lines[0]!.discount_promo_id).toBeNull();
  });

  it('never makes a ticket dearer, and leaves a manually discounted line alone', () => {
    const cheap = ticket([{ item: RED_BULL, cash: 200, card: 208 }, { item: MONSTER, cash: 250, card: 260 }]);
    expect(settle(cheap, [twoFor5], '2026-09-25T16:00:00Z').cash.subtotal_cents).toBe(450);
    const manual = ticket([{ item: RED_BULL, cash: 299, card: 311 }, { item: MONSTER, cash: 329, card: 342 }]);
    manual.ev('sale.line_discounted', { line_id: manual.fold().lines[0]!.line_id, cash_discount_cents: 50, card_discount_cents: 50, reason: 'Manager' });
    expect(applyPromotions([twoFor5], manual.fold(), ctx('2026-09-25T16:00:00Z'))).toEqual([]);
  });
});

describe('buy X get Y, and happy hour', () => {
  it('buy 1 get 1 free: the cheaper of each pair', () => {
    const bogo = promo({ name: 'BOGO', rule: { kind: 'buy_get', buy: 1, get: 1, percent_off: 100 }, category_ids: [DRINKS] });
    const s = settle(ticket([{ item: RED_BULL, cash: 299, card: 311 }, { item: MONSTER, cash: 329, card: 342 }]), [bogo], '2026-09-25T16:00:00Z');
    expect(s.cash.subtotal_cents).toBe(329);
    expect(s.card.subtotal_cents).toBe(342);
  });

  it('happy hour applies only inside its store-local window and days', () => {
    const hh = promo({ name: 'Happy hour', rule: { kind: 'percent_off', percent_off: 20 }, category_ids: [DRINKS], days: [1, 2, 3, 4, 5], start_time: '15:00', end_time: '18:00' });
    // Friday 2026-09-25: 16:00 New York = 20:00Z inside; 19:00 New York = 23:00Z outside.
    expect(settle(ticket([{ item: RED_BULL, cash: 300, card: 312 }]), [hh], '2026-09-25T20:00:00Z').cash.subtotal_cents).toBe(240);
    expect(settle(ticket([{ item: RED_BULL, cash: 300, card: 312 }]), [hh], '2026-09-25T23:00:00Z').cash.subtotal_cents).toBe(300);
    // Saturday: not a happy-hour day.
    expect(promotionActive(hh, t.location_id, { date: '2026-09-26', weekday: 6, hhmm: '16:00' })).toBe(false);
  });
});

describe('promotion data', () => {
  it('validates, and describes itself for the customer screen', () => {
    expect(PromotionInput.safeParse({ name: 'X', rule: { kind: 'percent_off', percent_off: 10 }, starts_on: '2026-09-01' }).success).toBe(false); // nothing qualifies
    expect(PromotionInput.safeParse({ name: 'Deal', rule: { kind: 'percent_off', percent_off: 10 }, item_ids: [RED_BULL], starts_on: '2026-09-02', ends_on: '2026-09-01' }).success).toBe(false);
    expect(promotionText({ name: 'Energy drinks', rule: { kind: 'multi_price', qty: 2, price_cents: 500 } })).toBe('2 for $5.00 · Energy drinks');
    expect(promotionText({ name: 'Snacks', rule: { kind: 'buy_get', buy: 1, get: 1, percent_off: 100 } })).toBe('Buy 1 get 1 free · Snacks');
  });

  it('the receipt names the deal and says what the customer saved', () => {
    const twoFor5 = promo({ name: '2 for $5 energy drinks', rule: { kind: 'multi_price', qty: 2, price_cents: 500 }, item_ids: [RED_BULL, MONSTER] });
    const s = settle(ticket([{ item: RED_BULL, cash: 299, card: 311 }, { item: MONSTER, cash: 329, card: 342 }]), [twoFor5], '2026-09-25T16:00:00Z');
    const text = receiptText(renderReceipt({ header: { merchant_name: 'Deli', location_name: 'JC', address_line1: null, city_state_zip: null, register_name: 'R1' }, sale: s, occurred_at: '2026-09-25T16:00:00Z', timezone: 'America/New_York', copy: 'original' }));
    expect(text).toContain('2 for $5 energy drinks');
    expect(text).toContain('You saved $1.28');
  });
});
